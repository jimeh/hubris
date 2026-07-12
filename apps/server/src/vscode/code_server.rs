use std::path::{Path, PathBuf};
use std::process::Stdio;

use futures_util::future::BoxFuture;
use semver::Version;
use tokio::process::Command;

use super::runtime::{
    ArchiveFormat, DEFAULT_HOST, InstalledRuntime, LaunchConfig, READY_POLL_INTERVAL,
    READY_TIMEOUT, RuntimeError, RuntimeInstallState, RuntimeManager, RuntimeSpec,
    RuntimeStatusSnapshot, pick_unused_port,
};
#[cfg(test)]
use super::runtime::{
    DownloadRuntimeFn, FetchLatestFn, LaunchFn, RunningRuntime, RuntimeDownloadRequest,
    RuntimeState, cleanup_other_runtimes, download_runtime_from_url,
};
use super::{
    CODE_SERVER_PUBLIC_BASE_PATH, CONFIG_DIR, CodeServerConnection, CodeServerError,
    CodeServerLaunchRequest, CodeServerStatusSnapshot, EXTENSIONS_DIR, RELEASES_BASE_URL,
    UPSTREAM_READY_PATH, USER_DIR,
};
#[cfg(target_os = "linux")]
use crate::process_manager::configure_parent_death_signal;

#[derive(Clone)]
pub struct CodeServerSpec;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CodeServerPlatform {
    pub os: &'static str,
    pub arch: &'static str,
}

pub type CodeServerManager = RuntimeManager<CodeServerSpec>;
pub(super) type CodeServerInstallState = RuntimeInstallState<CodeServerSpec>;
#[cfg(test)]
pub(super) type CodeServerDownloadRequest = RuntimeDownloadRequest<CodeServerSpec>;
pub(super) type InstalledCodeServerRuntime = InstalledRuntime<CodeServerSpec>;
#[cfg(test)]
pub(super) type CodeServerFetchLatestFn = FetchLatestFn<CodeServerSpec>;
#[cfg(test)]
pub(super) type CodeServerDownloadRuntimeFn = DownloadRuntimeFn<CodeServerSpec>;
#[cfg(test)]
pub(super) type CodeServerLaunchFn = LaunchFn<CodeServerSpec>;
#[cfg(test)]
pub(super) type RunningCodeServer = RunningRuntime<CodeServerSpec>;
#[cfg(test)]
pub(super) type ManagerRuntimeState = RuntimeState<CodeServerConnection>;

impl From<RuntimeError> for CodeServerError {
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

impl RuntimeSpec for CodeServerSpec {
    type Platform = CodeServerPlatform;
    type Connection = CodeServerConnection;
    type Error = CodeServerError;
    type LaunchRequest = CodeServerLaunchRequest;
    type Status = CodeServerStatusSnapshot;

    const PROCESS_ID: &'static str = "code_server";
    const PROCESS_KIND: &'static str = "code-server";
    const CLIENT_LABEL: &'static str = "code-server";
    const LAUNCH_LABEL: &'static str = "code-server";
    const INSTALL_CONFLICT_MESSAGE: &'static str = "code-server install is already running";
    const EXIT_MESSAGE: &'static str = "code-server exited";

    fn detect_platform() -> Result<Self::Platform, RuntimeError> {
        detect_platform()
    }

    fn normalize_version(raw: &str) -> Result<String, RuntimeError> {
        normalize_runtime_version(raw)
    }

    fn runtime_dir_name(version: &str, platform: Self::Platform) -> String {
        runtime_dir_name(version, platform)
    }

    fn archive_format(_platform: Self::Platform) -> ArchiveFormat {
        ArchiveFormat::TarGz
    }

    fn archive_url(version: &str, platform: Self::Platform) -> String {
        archive_url(RELEASES_BASE_URL, version, platform)
    }

    fn download_client() -> Result<reqwest::Client, RuntimeError> {
        Ok(reqwest::Client::new())
    }

    fn binary_path(runtime_dir: &Path, _platform: Self::Platform) -> Option<PathBuf> {
        let binary_path = runtime_dir.join("bin").join("code-server");
        binary_path.exists().then_some(binary_path)
    }

    fn locate_extracted_root(
        extract_dir: &Path,
        dir_name: &str,
        platform: Self::Platform,
    ) -> Option<PathBuf> {
        let extracted_root = extract_dir.join(dir_name);
        Self::binary_path(&extracted_root, platform).map(|_| extracted_root)
    }

    fn missing_extracted_binary(extract_dir: &Path, dir_name: &str) -> String {
        format!(
            "extracted runtime is missing bin/code-server: {}",
            extract_dir.join(dir_name).display()
        )
    }

    fn missing_installed_binary(runtime_dir: &Path) -> String {
        format!(
            "missing code-server binary after extraction: {}",
            runtime_dir.join("bin").join("code-server").display()
        )
    }

    fn platform_suffix(platform: Self::Platform) -> String {
        format!("-{}-{}", platform.os, platform.arch)
    }

    fn runtime_prefix() -> &'static str {
        "code-server-"
    }

    fn fetch_latest(client: reqwest::Client) -> BoxFuture<'static, Result<String, Self::Error>> {
        Box::pin(fetch_latest_version(client))
    }

    fn update_available(installed: &InstalledRuntime<Self>, latest: &str) -> bool {
        Version::parse(latest).is_ok_and(|version| installed.version_semver < version)
    }

    fn build_launch_request(
        root_dir: &Path,
        runtime: &InstalledRuntime<Self>,
    ) -> Self::LaunchRequest {
        build_launch_request(root_dir, runtime)
    }

    fn prepare_launch(
        request: Self::LaunchRequest,
    ) -> BoxFuture<'static, Result<LaunchConfig<Self::Connection>, RuntimeError>> {
        Box::pin(prepare_launch(request))
    }

    fn wait_until_ready(
        connection: Self::Connection,
    ) -> BoxFuture<'static, Result<(), RuntimeError>> {
        Box::pin(async move { wait_for_ready(&reqwest::Client::new(), &connection).await })
    }

    fn status(common: RuntimeStatusSnapshot) -> Self::Status {
        CodeServerStatusSnapshot {
            supported: common.supported,
            installed_version: common.installed_version,
            process_status: common.process_status,
            latest: common.latest,
            install_progress: common.install_progress,
            message: common.message,
        }
    }
}

pub(super) fn detect_platform() -> Result<CodeServerPlatform, RuntimeError> {
    let os = match std::env::consts::OS {
        "linux" => "linux",
        "macos" => "macos",
        other => {
            return Err(RuntimeError::UnsupportedPlatform(format!(
                "unsupported code-server host OS: {other}"
            )));
        }
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        "arm" | "armv7l" => "armv7l",
        other => {
            return Err(RuntimeError::UnsupportedPlatform(format!(
                "unsupported code-server host architecture: {other}"
            )));
        }
    };
    Ok(CodeServerPlatform { os, arch })
}

fn normalize_runtime_version(raw: &str) -> Result<String, RuntimeError> {
    let version = raw.trim().trim_start_matches('v');
    Version::parse(version)
        .map_err(|_| RuntimeError::InvalidVersion(format!("invalid code-server version: {raw}")))?;
    Ok(version.to_string())
}

#[cfg(test)]
pub(super) fn normalize_version(raw: &str) -> Result<String, CodeServerError> {
    normalize_runtime_version(raw).map_err(Into::into)
}

pub(super) fn runtime_dir_name(version: &str, platform: CodeServerPlatform) -> String {
    format!("code-server-{version}-{}-{}", platform.os, platform.arch)
}

fn archive_url(releases_base_url: &str, version: &str, platform: CodeServerPlatform) -> String {
    let dir_name = runtime_dir_name(version, platform);
    format!("{releases_base_url}/download/v{version}/{dir_name}.tar.gz")
}

async fn fetch_latest_version(client: reqwest::Client) -> Result<String, CodeServerError> {
    let response = client
        .get(format!("{RELEASES_BASE_URL}/latest"))
        .send()
        .await?;
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            CodeServerError::InvalidReleaseRedirect(
                "missing redirect location from /releases/latest".to_string(),
            )
        })?;
    let tag = location
        .rsplit('/')
        .next()
        .and_then(|segment| segment.strip_prefix('v'))
        .ok_or_else(|| {
            CodeServerError::InvalidReleaseRedirect(format!(
                "invalid release redirect location: {location}"
            ))
        })?;
    normalize_runtime_version(tag).map_err(Into::into)
}

pub(super) fn build_launch_request(
    root_dir: &Path,
    runtime: &InstalledCodeServerRuntime,
) -> CodeServerLaunchRequest {
    let port = pick_unused_port().unwrap_or(8080);
    CodeServerLaunchRequest {
        runtime_dir: runtime.runtime_dir.clone(),
        binary_path: runtime.binary_path.clone(),
        host: DEFAULT_HOST.to_string(),
        port,
        user_data_dir: root_dir.join(USER_DIR),
        extensions_dir: root_dir.join(EXTENSIONS_DIR),
        config_file: root_dir.join(CONFIG_DIR).join("config.yaml"),
    }
}

async fn prepare_launch(
    request: CodeServerLaunchRequest,
) -> Result<LaunchConfig<CodeServerConnection>, RuntimeError> {
    tokio::fs::create_dir_all(&request.runtime_dir).await?;
    tokio::fs::create_dir_all(&request.user_data_dir).await?;
    tokio::fs::create_dir_all(&request.extensions_dir).await?;
    tokio::fs::create_dir_all(
        request
            .config_file
            .parent()
            .unwrap_or_else(|| Path::new(".")),
    )
    .await?;
    tokio::fs::write(
        &request.config_file,
        "bind-addr: 127.0.0.1:8080\nauth: none\ncert: false\n",
    )
    .await?;
    let mut command = Command::new(&request.binary_path);
    command
        .arg("--bind-addr")
        .arg(format!("{}:{}", request.host, request.port))
        .arg("--auth")
        .arg("none")
        .arg("--user-data-dir")
        .arg(&request.user_data_dir)
        .arg("--extensions-dir")
        .arg(&request.extensions_dir)
        .arg("--config")
        .arg(&request.config_file)
        .arg("--disable-update-check")
        .arg("--abs-proxy-base-path")
        .arg(CODE_SERVER_PUBLIC_BASE_PATH)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(target_os = "linux")]
    configure_parent_death_signal(&mut command);
    Ok(LaunchConfig {
        command,
        connection: CodeServerConnection {
            base_url: format!("http://{}:{}", request.host, request.port),
        },
        binary_path: request.binary_path,
    })
}

pub(super) async fn wait_for_ready(
    client: &reqwest::Client,
    connection: &CodeServerConnection,
) -> Result<(), RuntimeError> {
    let started = tokio::time::Instant::now();
    loop {
        let response = client
            .get(connection.http_url(UPSTREAM_READY_PATH))
            .send()
            .await;
        match response {
            Ok(response) if response.status() != axum::http::StatusCode::ACCEPTED => {
                return Ok(());
            }
            Ok(_) | Err(_) => {}
        }
        if started.elapsed() >= READY_TIMEOUT {
            return Err(RuntimeError::StartupTimeout("code-server"));
        }
        tokio::time::sleep(READY_POLL_INTERVAL).await;
    }
}

#[cfg(test)]
pub(super) async fn cleanup_other_platform_runtimes(
    root_dir: PathBuf,
    platform: CodeServerPlatform,
    keep_runtime_dir: &Path,
) -> Result<(), CodeServerError> {
    cleanup_other_runtimes::<CodeServerSpec>(root_dir, platform, keep_runtime_dir)
        .await
        .map_err(Into::into)
}

#[cfg(test)]
pub(super) async fn download_runtime_archive_from_base_url(
    request: CodeServerDownloadRequest,
    client: reqwest::Client,
    releases_base_url: &str,
) -> Result<InstalledCodeServerRuntime, CodeServerError> {
    let version = normalize_runtime_version(&request.version)?;
    let url = archive_url(releases_base_url, &version, request.platform);
    download_runtime_from_url::<CodeServerSpec>(request, version, url, client)
        .await
        .map_err(Into::into)
}
