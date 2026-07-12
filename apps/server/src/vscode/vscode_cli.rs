use std::path::{Path, PathBuf};
use std::process::Stdio;

use axum::http::StatusCode;
use futures_util::future::BoxFuture;
use semver::Version;
use tokio::process::Command;
use uuid::Uuid;

use super::proxy::{extract_vscode_token_cookie, upsert_query_param};
#[cfg(test)]
use super::runtime::RuntimeState;
use super::runtime::{
    ArchiveFormat, DEFAULT_HOST, InstalledRuntime, LaunchConfig, READY_POLL_INTERVAL,
    READY_TIMEOUT, RuntimeError, RuntimeInstallState, RuntimeManager, RuntimeSpec,
    RuntimeStatusSnapshot, pick_unused_port,
};
use super::{
    CONFIG_DIR, VSCODE_CLI_DATA_DIR, VSCODE_CLI_PUBLIC_BASE_PATH, VSCODE_CLI_UPSTREAM_BASE_PATH,
    VSCODE_SERVER_DATA_DIR, VSCODE_TOKEN_QUERY_PARAM, VSCODE_UPDATE_BASE_URL, VscodeCliError,
    VscodeConnection, VscodeRuntimeKind, VscodeRuntimeStatusSnapshot,
};
#[cfg(target_os = "linux")]
use crate::process_manager::configure_parent_death_signal;

#[derive(Clone)]
pub struct VscodeCliSpec;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VscodeCliPlatform {
    pub os: &'static str,
    pub arch: &'static str,
    pub cli_download_segment: &'static str,
    pub update_segment: &'static str,
    pub archive_format: ArchiveFormat,
}

#[derive(Clone, Debug)]
pub struct VscodeCliLaunchRequest {
    runtime_dir: PathBuf,
    binary_path: PathBuf,
    host: String,
    port: u16,
    cli_data_dir: PathBuf,
    server_data_dir: PathBuf,
    connection_token_file: PathBuf,
    connection_token: String,
}

pub type VscodeCliManager = RuntimeManager<VscodeCliSpec>;
pub(super) type VscodeCliInstallState = RuntimeInstallState<VscodeCliSpec>;
#[cfg(test)]
pub(super) type VscodeCliRuntimeState = RuntimeState<VscodeConnection>;

impl From<RuntimeError> for VscodeCliError {
    fn from(error: RuntimeError) -> Self {
        match error {
            RuntimeError::Io(error) => Self::Io(error),
            RuntimeError::Http(error) => Self::Http(error),
            RuntimeError::Archive(message) => Self::Archive(message),
            RuntimeError::Spawn(message) => Self::Spawn(message),
            RuntimeError::StartupTimeout(_) => Self::StartupTimeout,
            RuntimeError::UnsupportedPlatform(message) => Self::UnsupportedPlatform(message),
            RuntimeError::InvalidVersion(message) => Self::InvalidVersion(message),
            RuntimeError::NotInstalled(_) => Self::NotInstalled,
        }
    }
}

impl RuntimeSpec for VscodeCliSpec {
    type Platform = VscodeCliPlatform;
    type Connection = VscodeConnection;
    type Error = VscodeCliError;
    type LaunchRequest = VscodeCliLaunchRequest;
    type Status = VscodeRuntimeStatusSnapshot;

    const PROCESS_ID: &'static str = "vscode_cli";
    const PROCESS_KIND: &'static str = "vscode-cli";
    const CLIENT_LABEL: &'static str = "vscode cli";
    const LAUNCH_LABEL: &'static str = "VS Code CLI";
    const INSTALL_CONFLICT_MESSAGE: &'static str = "VS Code CLI install is already running";
    const EXIT_MESSAGE: &'static str = "VS Code CLI exited";

    fn detect_platform() -> Result<Self::Platform, RuntimeError> {
        detect_platform()
    }

    fn normalize_version(raw: &str) -> Result<String, RuntimeError> {
        normalize_version(raw)
    }

    fn runtime_dir_name(version: &str, platform: Self::Platform) -> String {
        format!("vscode-cli-{version}-{}-{}", platform.os, platform.arch)
    }

    fn archive_format(platform: Self::Platform) -> ArchiveFormat {
        platform.archive_format
    }

    fn archive_url(version: &str, platform: Self::Platform) -> String {
        format!(
            "{VSCODE_UPDATE_BASE_URL}/{version}/{}/stable",
            platform.cli_download_segment
        )
    }

    fn download_client() -> Result<reqwest::Client, RuntimeError> {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .map_err(RuntimeError::Http)
    }

    fn binary_path(runtime_dir: &Path, platform: Self::Platform) -> Option<PathBuf> {
        vscode_cli_runtime_binary(runtime_dir, platform)
    }

    fn locate_extracted_root(
        extract_dir: &Path,
        _dir_name: &str,
        platform: Self::Platform,
    ) -> Option<PathBuf> {
        locate_extracted_root(extract_dir, platform)
    }

    fn missing_extracted_binary(extract_dir: &Path, _dir_name: &str) -> String {
        format!(
            "extracted VS Code CLI is missing a runnable binary: {}",
            extract_dir.display()
        )
    }

    fn missing_installed_binary(runtime_dir: &Path) -> String {
        format!(
            "missing VS Code CLI binary after extraction: {}",
            runtime_dir.display()
        )
    }

    fn platform_suffix(platform: Self::Platform) -> String {
        format!("-{}-{}", platform.os, platform.arch)
    }

    fn runtime_prefix() -> &'static str {
        "vscode-cli-"
    }

    fn fetch_latest(client: reqwest::Client) -> BoxFuture<'static, Result<String, Self::Error>> {
        Box::pin(fetch_latest_release(client))
    }

    fn update_available(installed: &InstalledRuntime<Self>, latest: &str) -> bool {
        installed.version_semver < Version::parse(latest).unwrap()
    }

    fn build_launch_request(
        root_dir: &Path,
        runtime: &InstalledRuntime<Self>,
    ) -> Self::LaunchRequest {
        let port = pick_unused_port().unwrap_or(8080);
        VscodeCliLaunchRequest {
            runtime_dir: runtime.runtime_dir.clone(),
            binary_path: runtime.binary_path.clone(),
            host: DEFAULT_HOST.to_string(),
            port,
            cli_data_dir: root_dir.join(VSCODE_CLI_DATA_DIR),
            server_data_dir: root_dir.join(VSCODE_SERVER_DATA_DIR),
            connection_token_file: root_dir.join(CONFIG_DIR).join("vscode-connection-token"),
            connection_token: Uuid::new_v4().to_string(),
        }
    }

    fn prepare_launch(
        request: Self::LaunchRequest,
    ) -> BoxFuture<'static, Result<LaunchConfig<Self::Connection>, RuntimeError>> {
        Box::pin(prepare_launch(request))
    }

    fn wait_until_ready(
        connection: Self::Connection,
    ) -> BoxFuture<'static, Result<(), RuntimeError>> {
        Box::pin(wait_for_ready(connection))
    }

    fn status(common: RuntimeStatusSnapshot) -> Self::Status {
        VscodeRuntimeStatusSnapshot {
            supported: common.supported,
            installed_version: common.installed_version,
            process_status: common.process_status,
            latest: common.latest,
            install_progress: common.install_progress,
            message: common.message,
            active_task_id: None,
        }
    }
}

fn detect_platform() -> Result<VscodeCliPlatform, RuntimeError> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok(VscodeCliPlatform {
            os: "linux",
            arch: "x64",
            cli_download_segment: "cli-linux-x64",
            update_segment: "linux-x64",
            archive_format: ArchiveFormat::TarGz,
        }),
        ("macos", "aarch64") => Ok(VscodeCliPlatform {
            os: "darwin",
            arch: "arm64",
            cli_download_segment: "cli-darwin-arm64",
            update_segment: "darwin-arm64",
            archive_format: ArchiveFormat::Zip,
        }),
        ("macos", "x86_64") => Ok(VscodeCliPlatform {
            os: "darwin",
            arch: "x64",
            cli_download_segment: "cli-darwin-x64",
            update_segment: "darwin",
            archive_format: ArchiveFormat::Zip,
        }),
        ("windows", "x86_64") => Ok(VscodeCliPlatform {
            os: "win32",
            arch: "x64",
            cli_download_segment: "cli-win32-x64",
            update_segment: "win32-x64-archive",
            archive_format: ArchiveFormat::Zip,
        }),
        (os, arch) => Err(RuntimeError::UnsupportedPlatform(format!(
            "unsupported VS Code CLI host platform: {os}/{arch}"
        ))),
    }
}

#[cfg(test)]
pub(super) fn detect_vscode_cli_platform() -> Result<VscodeCliPlatform, VscodeCliError> {
    detect_platform().map_err(Into::into)
}

fn normalize_version(raw: &str) -> Result<String, RuntimeError> {
    let version = raw.trim().trim_start_matches('v');
    Version::parse(version)
        .map_err(|_| RuntimeError::InvalidVersion(format!("invalid VS Code version: {raw}")))?;
    Ok(version.to_string())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VscodeUpdateApiResponse {
    name: String,
}

async fn fetch_latest_release(client: reqwest::Client) -> Result<String, VscodeCliError> {
    let platform = detect_platform()?;
    let response = client
        .get(format!(
            "{VSCODE_UPDATE_BASE_URL}/api/update/{}/stable/latest",
            platform.update_segment
        ))
        .send()
        .await?
        .error_for_status()?;
    let payload: VscodeUpdateApiResponse = response.json().await?;
    normalize_version(&payload.name).map_err(Into::into)
}

fn locate_extracted_root(extract_dir: &Path, platform: VscodeCliPlatform) -> Option<PathBuf> {
    if vscode_cli_runtime_binary(extract_dir, platform).is_some() {
        return Some(extract_dir.to_path_buf());
    }
    std::fs::read_dir(extract_dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.is_dir() && vscode_cli_runtime_binary(path, platform).is_some())
}

fn vscode_cli_runtime_binary(root: &Path, platform: VscodeCliPlatform) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    let wanted = if platform.os == "win32" {
        vec!["code.cmd", "code.exe"]
    } else {
        vec!["code"]
    };
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if wanted.contains(&name) {
                return Some(path);
            }
        }
    }
    None
}

async fn prepare_launch(
    request: VscodeCliLaunchRequest,
) -> Result<LaunchConfig<VscodeConnection>, RuntimeError> {
    tokio::fs::create_dir_all(&request.runtime_dir).await?;
    tokio::fs::create_dir_all(&request.cli_data_dir).await?;
    tokio::fs::create_dir_all(&request.server_data_dir).await?;
    tokio::fs::create_dir_all(
        request
            .connection_token_file
            .parent()
            .unwrap_or_else(|| Path::new(".")),
    )
    .await?;
    tokio::fs::write(&request.connection_token_file, &request.connection_token).await?;
    let mut command = Command::new(&request.binary_path);
    command
        .arg("serve-web")
        .arg("--host")
        .arg(&request.host)
        .arg("--port")
        .arg(request.port.to_string())
        .arg("--accept-server-license-terms")
        .arg("--server-base-path")
        .arg(VSCODE_CLI_PUBLIC_BASE_PATH)
        .arg("--server-data-dir")
        .arg(&request.server_data_dir)
        .arg("--connection-token-file")
        .arg(&request.connection_token_file)
        .arg("--disable-telemetry")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .current_dir(&request.runtime_dir);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(target_os = "linux")]
    configure_parent_death_signal(&mut command);
    Ok(LaunchConfig {
        command,
        connection: VscodeConnection {
            runtime: VscodeRuntimeKind::VscodeCli,
            base_url: format!("http://{}:{}", request.host, request.port),
            ws_base_url: format!("ws://{}:{}", request.host, request.port),
            upstream_base_path: VSCODE_CLI_UPSTREAM_BASE_PATH.to_string(),
            connection_token: Some(request.connection_token.clone()),
        },
        binary_path: request.binary_path,
    })
}

async fn wait_for_ready(connection: VscodeConnection) -> Result<(), RuntimeError> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let started = tokio::time::Instant::now();
    let authenticated_url = connection.http_url(&upsert_query_param(
        "/",
        VSCODE_TOKEN_QUERY_PARAM,
        connection.connection_token.as_deref().unwrap_or_default(),
    ));
    let ready_url = connection.http_url("/");
    let mut cookie = None;
    loop {
        let response = client.get(&authenticated_url).send().await;
        match response {
            Ok(response) if response.status() == StatusCode::ACCEPTED => {}
            Ok(response) => {
                if cookie.is_none() {
                    cookie = extract_vscode_token_cookie(response.headers());
                }
                if let Some(cookie) = cookie.as_deref() {
                    let ready_response =
                        client.get(&ready_url).header("cookie", cookie).send().await;
                    if let Ok(ready_response) = ready_response
                        && ready_response.status() == StatusCode::OK
                    {
                        return Ok(());
                    }
                } else if response.status() == StatusCode::OK {
                    return Ok(());
                }
            }
            Err(_) => {}
        }
        if started.elapsed() >= READY_TIMEOUT {
            return Err(RuntimeError::StartupTimeout("VS Code CLI"));
        }
        tokio::time::sleep(READY_POLL_INTERVAL).await;
    }
}
