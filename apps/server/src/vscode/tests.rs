use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::extract::Request as AxumRequest;
use axum::http::header::{HOST, ORIGIN};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::{Router, body::Body};
use flate2::Compression;
use flate2::write::GzEncoder;
use semver::Version;
use tar::Builder;
use tokio::process::Command;
use tokio::sync::Mutex;

use super::code_server::{
    CodeServerDownloadRequest, CodeServerDownloadRuntimeFn as DownloadRuntimeFn,
    CodeServerFetchLatestFn as FetchLatestFn, CodeServerLaunchFn as LaunchFn, CodeServerPlatform,
    InstalledCodeServerRuntime as InstalledRuntime, ManagerRuntimeState, RunningCodeServer,
    build_launch_request, cleanup_other_platform_runtimes, download_runtime_archive_from_base_url,
    normalize_version, runtime_dir_name, wait_for_ready,
};
use super::proxy::{
    authorized_http_url, forwarded_public_host, forwarded_public_origin,
    request_target_from_public_path,
};
use super::runtime::RUNTIMES_DIR;
use super::vscode_cli::{VscodeCliRuntimeState, detect_vscode_cli_platform};
use super::*;
use crate::domain::settings::{SettingsPatch, VscodeSettingsPatch};
use crate::domain::task::TaskRemoved;
use crate::domain::vscode::{VscodeInstallPhase, VscodeProcessStatus};
use crate::process_manager::TestProcessProbe;
#[cfg(target_os = "linux")]
use crate::process_manager::configure_parent_death_signal;
use crate::process_manager::{
    ManagedChildProcess, ManagedProcessLifecycleState, ManagedProcessRuntime, ManagedProcessService,
};
use crate::settings_manager::SettingsManager;
use crate::task_manager::TaskService;
use crate::{AppState, build_router, events::EventKind};
#[cfg(unix)]
use std::fs::Permissions;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn static_fetch_latest(version: &'static str) -> FetchLatestFn {
    Arc::new(move || Box::pin(async move { Ok(version.to_string()) }))
}

fn static_download_runtime(temp_root: PathBuf) -> DownloadRuntimeFn {
    Arc::new(move |request: CodeServerDownloadRequest| {
        let temp_root = temp_root.clone();
        Box::pin(async move {
            let dir_name = runtime_dir_name(&request.version, request.platform);
            let runtime_dir = request.root_dir.join(RUNTIMES_DIR).join(&dir_name);
            tokio::fs::create_dir_all(runtime_dir.join("bin")).await?;
            tokio::fs::write(runtime_dir.join("bin").join("code-server"), "#!/bin/sh\n").await?;
            tokio::fs::write(temp_root.join("downloaded"), dir_name.as_bytes()).await?;
            Ok(InstalledRuntime {
                version: request.version.clone(),
                version_semver: Version::parse(&request.version).unwrap(),
                platform: request.platform,
                runtime_dir: runtime_dir.clone(),
                binary_path: runtime_dir.join("bin").join("code-server"),
            })
        })
    })
}

fn runtime_archive(dir_name: &str) -> Vec<u8> {
    let mut tar_bytes = Vec::new();
    {
        let mut builder = Builder::new(&mut tar_bytes);
        let file_contents = b"#!/bin/sh\n";
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o755);
        header.set_size(file_contents.len() as u64);
        header.set_cksum();
        builder
            .append_data(
                &mut header,
                format!("{dir_name}/bin/code-server"),
                &file_contents[..],
            )
            .unwrap();
        builder.finish().unwrap();
    }

    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&tar_bytes).unwrap();
    encoder.finish().unwrap()
}

async fn select_code_server_runtime(state: &AppState) {
    state
        .settings
        .patch(SettingsPatch {
            appearance: None,
            terminal: None,
            editor: None,
            worktree: None,
            experimental: None,
            vscode: Some(VscodeSettingsPatch {
                runtime: Some(VscodeRuntimeKind::CodeServer),
            }),
            chat: None,
        })
        .await
        .unwrap();
}

async fn replace_code_server_runtime(state: &mut AppState, code_server: Arc<CodeServerManager>) {
    state.processes.register_controller(code_server.clone());
    code_server.clone().register_process_callback().await;

    let tasks = Arc::new(TaskService::new(state.events.clone()));
    let vscode_cli = state.vscode.vscode_cli.clone();
    register_vscode_tasks(&tasks, code_server.clone(), vscode_cli.clone());
    let vscode = Arc::new(VscodeManager::new(
        state.settings.clone(),
        state.events.clone(),
        tasks.clone(),
        code_server,
        vscode_cli,
    ));
    vscode.clone().register_status_callbacks().await;
    state.tasks = tasks;
    state.vscode = vscode;
    select_code_server_runtime(state).await;
}

#[cfg(unix)]
async fn wait_for_file(path: &Path) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(contents) = tokio::fs::read_to_string(path).await
            && !contents.trim().is_empty()
        {
            return contents;
        }

        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {}",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[cfg(unix)]
fn process_exists(pid: i32) -> bool {
    let result = unsafe { libc::kill(pid, 0) };
    if result == 0 {
        return true;
    }

    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(target_os = "linux")]
fn process_is_zombie(pid: i32) -> bool {
    let status_path = format!("/proc/{pid}/status");
    let Ok(status) = std::fs::read_to_string(status_path) else {
        return false;
    };

    status
        .lines()
        .find(|line| line.starts_with("State:"))
        .is_some_and(|line| line.contains("\tZ"))
}

#[cfg(unix)]
async fn wait_for_process_exit(pid: i32) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        if !process_exists(pid) {
            return;
        }

        #[cfg(target_os = "linux")]
        if process_is_zombie(pid) {
            return;
        }

        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for process {pid} to exit"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn linux_parent_death_signal_terminates_child_after_parent_exit() {
    let tmp = tempfile::TempDir::new().unwrap();
    let child_pid_path = tmp.path().join("child.pid");

    let status = Command::new(std::env::current_exe().unwrap())
        .arg("--ignored")
        .arg("--exact")
        .arg("vscode::tests::linux_parent_death_signal_helper")
        .env("HUBRIS_TEST_PDEATHSIG_CHILD_PID_FILE", &child_pid_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .unwrap();

    let child_pid: i32 = wait_for_file(&child_pid_path).await.trim().parse().unwrap();
    assert!(
        status.success() || !process_exists(child_pid),
        "helper test exited unsuccessfully before child shutdown was observed: {status:?}"
    );
    wait_for_process_exit(child_pid).await;
}

#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore]
async fn linux_parent_death_signal_helper() {
    let Some(child_pid_path) = std::env::var_os("HUBRIS_TEST_PDEATHSIG_CHILD_PID_FILE") else {
        return;
    };

    let mut command = Command::new("sleep");
    command
        .arg("1000")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_parent_death_signal(&mut command);

    let child = command.spawn().unwrap();
    let child_pid = child.id().unwrap();
    std::fs::write(PathBuf::from(child_pid_path), format!("{child_pid}")).unwrap();
}

#[test]
fn request_target_from_public_path_extracts_runtime_relative_path() {
    assert_eq!(
        request_target_from_public_path("/code/vscode-cli"),
        Some((VscodeRuntimeKind::VscodeCli, "/".to_string()))
    );
    assert_eq!(
        request_target_from_public_path("/code/vscode-cli/?folder=%2Ftmp%2Fdemo"),
        Some((
            VscodeRuntimeKind::VscodeCli,
            "/?folder=%2Ftmp%2Fdemo".to_string()
        ))
    );
    assert_eq!(
        request_target_from_public_path("/code/code-server/static/out.js"),
        Some((VscodeRuntimeKind::CodeServer, "/static/out.js".to_string()))
    );
    assert_eq!(request_target_from_public_path("/code"), None);
}

#[test]
fn runtime_dir_name_uses_version_platform_suffix() {
    let platform = CodeServerPlatform {
        os: "macos",
        arch: "arm64",
    };
    assert_eq!(
        runtime_dir_name("4.114.1", platform),
        "code-server-4.114.1-macos-arm64"
    );
}

#[test]
fn normalize_version_accepts_tags_and_rejects_invalid_values() {
    assert_eq!(normalize_version("v4.114.1").unwrap(), "4.114.1");
    assert!(matches!(
        normalize_version("latest"),
        Err(CodeServerError::InvalidVersion(_))
    ));
}

#[test]
fn build_launch_request_uses_managed_dirs_and_runtime_binary() {
    let platform = CodeServerPlatform {
        os: "linux",
        arch: "amd64",
    };
    let runtime = InstalledRuntime {
        version: "4.114.1".to_string(),
        version_semver: Version::parse("4.114.1").unwrap(),
        platform,
        runtime_dir: PathBuf::from(
            "/tmp/hubris/code-server/runtimes/code-server-4.114.1-linux-amd64",
        ),
        binary_path: PathBuf::from(
            "/tmp/hubris/code-server/runtimes/code-server-4.114.1-linux-amd64/bin/code-server",
        ),
    };

    let request = build_launch_request(Path::new("/tmp/hubris/code-server"), &runtime);

    assert_eq!(
        request.user_data_dir,
        PathBuf::from("/tmp/hubris/code-server/user")
    );
    assert_eq!(
        request.extensions_dir,
        PathBuf::from("/tmp/hubris/code-server/extensions")
    );
    assert_eq!(
        request.config_file,
        PathBuf::from("/tmp/hubris/code-server/config/config.yaml")
    );
    assert_eq!(request.binary_path, runtime.binary_path);
}

#[tokio::test]
async fn cleanup_other_platform_runtimes_keeps_other_arches() {
    let tmp = tempfile::TempDir::new().unwrap();
    let runtimes = tmp.path().join(RUNTIMES_DIR);
    tokio::fs::create_dir_all(&runtimes).await.unwrap();
    tokio::fs::create_dir_all(runtimes.join("code-server-4.113.0-linux-amd64"))
        .await
        .unwrap();
    tokio::fs::create_dir_all(runtimes.join("code-server-4.114.1-linux-amd64"))
        .await
        .unwrap();
    tokio::fs::create_dir_all(runtimes.join("code-server-4.114.1-macos-arm64"))
        .await
        .unwrap();

    cleanup_other_platform_runtimes(
        tmp.path().to_path_buf(),
        CodeServerPlatform {
            os: "linux",
            arch: "amd64",
        },
        &runtimes.join("code-server-4.114.1-linux-amd64"),
    )
    .await
    .unwrap();

    assert!(
        !tokio::fs::try_exists(runtimes.join("code-server-4.113.0-linux-amd64"))
            .await
            .unwrap()
    );
    assert!(
        tokio::fs::try_exists(runtimes.join("code-server-4.114.1-linux-amd64"))
            .await
            .unwrap()
    );
    assert!(
        tokio::fs::try_exists(runtimes.join("code-server-4.114.1-macos-arm64"))
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn download_runtime_archive_follows_release_asset_redirects() {
    let version = "4.114.1";
    let platform = CodeServerPlatform {
        os: "linux",
        arch: "amd64",
    };
    let dir_name = runtime_dir_name(version, platform);
    let asset_name = format!("{dir_name}.tar.gz");
    let archive = Arc::new(runtime_archive(&dir_name));
    let redirected_asset_path = format!("/assets/{asset_name}");
    let upstream = Router::new()
        .route(
            &format!("/releases/download/v{version}/{asset_name}"),
            any({
                let redirected_asset_path = redirected_asset_path.clone();
                move || async move {
                    Response::builder()
                        .status(StatusCode::FOUND)
                        .header(axum::http::header::LOCATION, redirected_asset_path.clone())
                        .body(Body::empty())
                        .unwrap()
                }
            }),
        )
        .route(
            &redirected_asset_path,
            any({
                let archive = archive.clone();
                move || async move {
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(axum::http::header::CONTENT_TYPE, "application/gzip")
                        .body(Body::from(archive.as_ref().clone()))
                        .unwrap()
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });

    let tmp = tempfile::TempDir::new().unwrap();
    let installed = download_runtime_archive_from_base_url(
        CodeServerDownloadRequest {
            version: version.to_string(),
            platform,
            root_dir: tmp.path().join("code-server"),
            force: false,
            install_progress: None,
        },
        reqwest::Client::new(),
        &format!("http://{addr}/releases"),
    )
    .await
    .unwrap();

    assert_eq!(installed.version, version);
    assert_eq!(
        installed.runtime_dir.file_name().unwrap(),
        dir_name.as_str()
    );
    assert!(tokio::fs::try_exists(installed.binary_path).await.unwrap());
}

#[tokio::test]
async fn download_runtime_archive_replaces_incomplete_target_runtime() {
    let version = "4.114.1";
    let platform = CodeServerPlatform {
        os: "linux",
        arch: "amd64",
    };
    let dir_name = runtime_dir_name(version, platform);
    let asset_name = format!("{dir_name}.tar.gz");
    let archive = Arc::new(runtime_archive(&dir_name));
    let upstream = Router::new().route(
        &format!("/releases/download/v{version}/{asset_name}"),
        any({
            let archive = archive.clone();
            move || async move {
                Response::builder()
                    .status(StatusCode::OK)
                    .header(axum::http::header::CONTENT_TYPE, "application/gzip")
                    .body(Body::from(archive.as_ref().clone()))
                    .unwrap()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });

    let tmp = tempfile::TempDir::new().unwrap();
    let root_dir = tmp.path().join("code-server");
    let runtime_dir = root_dir.join(RUNTIMES_DIR).join(&dir_name);
    tokio::fs::create_dir_all(&runtime_dir).await.unwrap();
    tokio::fs::write(runtime_dir.join("stale.txt"), "stale")
        .await
        .unwrap();

    let installed = download_runtime_archive_from_base_url(
        CodeServerDownloadRequest {
            version: version.to_string(),
            platform,
            root_dir: root_dir.clone(),
            force: false,
            install_progress: None,
        },
        reqwest::Client::new(),
        &format!("http://{addr}/releases"),
    )
    .await
    .unwrap();

    assert_eq!(installed.version, version);
    assert!(tokio::fs::try_exists(installed.binary_path).await.unwrap());
    assert!(
        !tokio::fs::try_exists(runtime_dir.join("stale.txt"))
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn ensure_ready_serializes_concurrent_startup() {
    let launches = Arc::new(AtomicUsize::new(0));
    let launches_clone = launches.clone();
    let launch: LaunchFn = Arc::new(move |request| {
        let launches = launches_clone.clone();
        Box::pin(async move {
            launches.fetch_add(1, Ordering::Relaxed);
            tokio::time::sleep(Duration::from_millis(25)).await;
            Ok(RunningCodeServer {
                connection: CodeServerConnection {
                    base_url: format!("http://{}:{}", request.host, request.port),
                },
                process: ManagedProcessRuntime::External,
            })
        })
    });

    let tmp = tempfile::TempDir::new().unwrap();
    let manager = CodeServerManager::with_hooks(
        tmp.path().join("code-server"),
        static_fetch_latest("4.114.1"),
        static_download_runtime(tmp.path().to_path_buf()),
        launch,
    );
    start_code_server_install_task(&manager, Some("4.114.1".to_string()), false).await;
    wait_for_running_status(&manager).await;
    manager.stop().await.unwrap();

    let (first, second) = tokio::join!(manager.ensure_ready(), manager.ensure_ready());

    assert!(first.is_ok());
    assert!(second.is_ok());
    assert_eq!(launches.load(Ordering::Relaxed), 2);
}

#[tokio::test]
async fn ensure_ready_waits_for_install_completion_without_relaunching() {
    let launches = Arc::new(AtomicUsize::new(0));
    let launches_for_download = launches.clone();
    let download: DownloadRuntimeFn = Arc::new(move |request: CodeServerDownloadRequest| {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(25)).await;
            let dir_name = runtime_dir_name(&request.version, request.platform);
            let runtime_dir = request.root_dir.join(RUNTIMES_DIR).join(&dir_name);
            tokio::fs::create_dir_all(runtime_dir.join("bin")).await?;
            tokio::fs::write(runtime_dir.join("bin").join("code-server"), "#!/bin/sh\n").await?;
            Ok(InstalledRuntime {
                version: request.version.clone(),
                version_semver: Version::parse(&request.version).unwrap(),
                platform: request.platform,
                runtime_dir: runtime_dir.clone(),
                binary_path: runtime_dir.join("bin").join("code-server"),
            })
        })
    });
    let launch: LaunchFn = Arc::new(move |request| {
        let launches = launches_for_download.clone();
        Box::pin(async move {
            launches.fetch_add(1, Ordering::Relaxed);
            Ok(RunningCodeServer {
                connection: CodeServerConnection {
                    base_url: format!("http://{}:{}", request.host, request.port),
                },
                process: ManagedProcessRuntime::External,
            })
        })
    });

    let tmp = tempfile::TempDir::new().unwrap();
    let manager = CodeServerManager::with_hooks(
        tmp.path().join("code-server"),
        static_fetch_latest("4.114.1"),
        download,
        launch,
    );

    start_code_server_install_task(&manager, Some("4.114.1".to_string()), false).await;
    let install = manager.status().await;
    assert_eq!(
        install.process_status,
        CodeServerProcessStatusValue::Installing
    );

    let connection = tokio::time::timeout(Duration::from_secs(2), manager.ensure_ready())
        .await
        .unwrap()
        .unwrap();

    assert!(connection.base_url.starts_with("http://127.0.0.1:"));
    assert_eq!(launches.load(Ordering::Relaxed), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn managed_child_shutdown_terminates_process_group_gracefully() {
    let tmp = tempfile::TempDir::new().unwrap();
    let script_path = tmp.path().join("graceful-shutdown.sh");
    let child_pid_path = tmp.path().join("child.pid");
    let ready_path = tmp.path().join("ready");
    tokio::fs::write(
        &script_path,
        format!(
            concat!(
                "#!/bin/sh\n",
                "set -eu\n",
                "child_pid_file=\"{}\"\n",
                "ready_file=\"{}\"\n",
                "sleep 1000 &\n",
                "child=$!\n",
                "echo \"$child\" > \"$child_pid_file\"\n",
                "echo ready > \"$ready_file\"\n",
                "trap 'exit 0' TERM INT\n",
                "wait \"$child\"\n"
            ),
            child_pid_path.display(),
            ready_path.display()
        ),
    )
    .await
    .unwrap();
    tokio::fs::set_permissions(&script_path, Permissions::from_mode(0o755))
        .await
        .unwrap();

    let mut command = Command::new(&script_path);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    let child = command.spawn().unwrap();
    let mut process = ManagedChildProcess::new(child);

    let child_pid: i32 = wait_for_file(&child_pid_path).await.trim().parse().unwrap();
    let _ = wait_for_file(&ready_path).await;

    process
        .shutdown_with_timeout(Duration::from_millis(250))
        .await
        .unwrap();

    wait_for_process_exit(child_pid).await;
    assert!(!process.is_alive().unwrap());
}

#[cfg(unix)]
#[tokio::test]
async fn managed_child_shutdown_escalates_after_timeout() {
    let tmp = tempfile::TempDir::new().unwrap();
    let script_path = tmp.path().join("ignore-term.sh");
    let ready_path = tmp.path().join("ready");
    tokio::fs::write(
        &script_path,
        format!(
            concat!(
                "#!/bin/sh\n",
                "set -eu\n",
                "ready_file=\"{}\"\n",
                "echo ready > \"$ready_file\"\n",
                "trap '' TERM INT\n",
                "while :; do\n",
                "  sleep 1\n",
                "done\n"
            ),
            ready_path.display()
        ),
    )
    .await
    .unwrap();
    tokio::fs::set_permissions(&script_path, Permissions::from_mode(0o755))
        .await
        .unwrap();

    let mut command = Command::new(&script_path);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    let child = command.spawn().unwrap();
    let mut process = ManagedChildProcess::new(child);

    let _ = wait_for_file(&ready_path).await;
    let started = tokio::time::Instant::now();
    process
        .shutdown_with_timeout(Duration::from_millis(250))
        .await
        .unwrap();

    assert!(started.elapsed() >= Duration::from_millis(250));
    assert!(!process.is_alive().unwrap());
}

#[tokio::test]
async fn shutdown_stops_running_process_and_resets_state() {
    let manager = CodeServerManager::with_hooks(
        PathBuf::from("/tmp/hubris/code-server"),
        static_fetch_latest("4.114.1"),
        Arc::new(|_| Box::pin(async { Err(CodeServerError::Archive("unused".to_string())) })),
        Arc::new(|_| {
            Box::pin(async {
                Ok(RunningCodeServer {
                    connection: CodeServerConnection {
                        base_url: "http://127.0.0.1:1234".into(),
                    },
                    process: ManagedProcessRuntime::External,
                })
            })
        }),
    );
    let probe = TestProcessProbe::new(true);

    {
        let mut state = manager.inner.lock().await;
        state.runtime = ManagerRuntimeState::Ready(CodeServerConnection {
            base_url: "http://127.0.0.1:1234".into(),
        });
    }
    manager.process_handle.finish_running(probe.runtime()).await;

    manager.shutdown().await.unwrap();

    assert_eq!(probe.shutdowns.load(Ordering::Relaxed), 1);
    assert_eq!(probe.drop_kills.load(Ordering::Relaxed), 0);

    let status = manager.process_handle.status().await.unwrap();
    assert_eq!(
        status.lifecycle_state,
        ManagedProcessLifecycleState::Stopped
    );
}

#[tokio::test]
async fn failed_shutdown_recovers_out_of_stopping_state() {
    let manager = CodeServerManager::with_hooks(
        PathBuf::from("/tmp/hubris/code-server"),
        static_fetch_latest("4.114.1"),
        static_download_runtime(PathBuf::from("/tmp/hubris")),
        Arc::new(|_| {
            Box::pin(async {
                Ok(RunningCodeServer {
                    connection: CodeServerConnection {
                        base_url: "http://127.0.0.1:1234".into(),
                    },
                    process: ManagedProcessRuntime::External,
                })
            })
        }),
    );
    let probe = TestProcessProbe::new(true).with_shutdown_error();
    manager.process_handle.finish_running(probe.runtime()).await;

    let error = manager.stop().await.unwrap_err();
    assert!(matches!(error, CodeServerError::Spawn(_)));

    let status = manager.process_handle.status().await.unwrap();
    assert_eq!(status.lifecycle_state, ManagedProcessLifecycleState::Error);

    manager.process_handle.finish_stopped().await;
    let recovered = manager.process_handle.status().await.unwrap();
    assert_eq!(
        recovered.lifecycle_state,
        ManagedProcessLifecycleState::Stopped
    );
}

#[tokio::test]
async fn wait_for_ready_retries_until_server_stops_returning_accepted() {
    let requests = Arc::new(AtomicUsize::new(0));
    let request_counter = requests.clone();
    let app = Router::new().route(
        "/",
        any(move || {
            let request_counter = request_counter.clone();
            async move {
                let count = request_counter.fetch_add(1, Ordering::Relaxed);
                if count < 2 {
                    (StatusCode::ACCEPTED, "warming up").into_response()
                } else {
                    (StatusCode::OK, "ready").into_response()
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let connection = CodeServerConnection {
        base_url: format!("http://{}", addr),
    };

    wait_for_ready(&client, &connection).await.unwrap();

    assert!(requests.load(Ordering::Relaxed) >= 3);
}

#[tokio::test]
async fn code_server_proxy_preserves_regular_cookies() {
    let upstream = Router::new().route(
        "/",
        any(|request: AxumRequest<Body>| async move {
            let cookie = request
                .headers()
                .get(axum::http::header::COOKIE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .to_string();
            let path = request
                .uri()
                .path_and_query()
                .map(|value| value.as_str().to_string())
                .unwrap_or_default();
            Response::builder()
                .status(StatusCode::OK)
                .header(axum::http::header::SET_COOKIE, "other-cookie=ok; Path=/")
                .header(axum::http::header::CONTENT_TYPE, "text/plain")
                .body(Body::from(format!(
                    "{path}\n{cookie}\n{}",
                    request
                        .headers()
                        .get(HOST)
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or("")
                )))
                .unwrap()
        }),
    );
    let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(upstream_listener, upstream).await.unwrap();
    });

    let launch: LaunchFn = Arc::new(move |_request| {
        Box::pin(async move {
            Ok(RunningCodeServer {
                connection: CodeServerConnection {
                    base_url: format!("http://{}", upstream_addr),
                },
                process: ManagedProcessRuntime::External,
            })
        })
    });

    let tmp = tempfile::TempDir::new().unwrap();
    let mut state = AppState::new(tmp.path().to_path_buf()).await;
    replace_code_server_runtime(
        &mut state,
        Arc::new(CodeServerManager::with_hooks(
            tmp.path().join("code-server"),
            static_fetch_latest("4.114.1"),
            static_download_runtime(tmp.path().to_path_buf()),
            launch,
        )),
    )
    .await;
    state
        .vscode
        .install(Some("4.114.1".to_string()), false)
        .await
        .unwrap();
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let client = reqwest::Client::new();
    let response = client
        .get(format!(
            "http://{addr}/code/code-server/?folder=%2Ftmp%2Fdemo"
        ))
        .header(HOST, format!("proxy.test:{}", addr.port()))
        .header(
            axum::http::header::COOKIE,
            "theme=dark; hubris-session=test",
        )
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let set_cookies = response.headers().get_all(axum::http::header::SET_COOKIE);
    let set_cookie_values = set_cookies
        .iter()
        .map(|value| value.to_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        set_cookie_values,
        vec!["other-cookie=ok; Path=/".to_string()]
    );

    let body = response.text().await.unwrap();
    let mut lines = body.lines();
    let expected_host = format!("proxy.test:{}", addr.port());
    assert_eq!(lines.next(), Some("/?folder=%2Ftmp%2Fdemo"));
    assert_eq!(lines.next(), Some("theme=dark; hubris-session=test"));
    assert_eq!(lines.next(), Some(expected_host.as_str()));
}

#[test]
fn forwarded_public_headers_override_host_and_origin() {
    let headers = HeaderMap::from_iter([
        (HOST, HeaderValue::from_static("proxy.test")),
        (ORIGIN, HeaderValue::from_static("https://proxy.test")),
        (
            axum::http::HeaderName::from_static(HUBRIS_PUBLIC_HOST_HEADER),
            HeaderValue::from_static("code-server.desktop.internal.hubris.build"),
        ),
        (
            axum::http::HeaderName::from_static(HUBRIS_PUBLIC_ORIGIN_HEADER),
            HeaderValue::from_static("https://code-server.desktop.internal.hubris.build"),
        ),
    ]);

    assert_eq!(
        forwarded_public_host(&headers),
        Some(&HeaderValue::from_static(
            "code-server.desktop.internal.hubris.build"
        ))
    );
    assert_eq!(
        forwarded_public_origin(&headers),
        Some(&HeaderValue::from_static(
            "https://code-server.desktop.internal.hubris.build"
        ))
    );
}

#[tokio::test]
async fn vscode_cli_proxy_overrides_stale_cookie_with_current_token() {
    let upstream = Router::new().route(
        "/code",
        any(|request: AxumRequest<Body>| async move {
            let path = request
                .uri()
                .path_and_query()
                .map(|value| value.as_str().to_string())
                .unwrap_or_default();
            let cookie = request
                .headers()
                .get(axum::http::header::COOKIE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .to_string();
            Response::builder()
                .status(StatusCode::OK)
                .header(axum::http::header::CONTENT_TYPE, "text/plain")
                .body(Body::from(format!("{path}\n{cookie}")))
                .unwrap()
        }),
    );
    let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(upstream_listener, upstream).await.unwrap();
    });

    let connection = VscodeConnection {
        runtime: VscodeRuntimeKind::VscodeCli,
        base_url: format!("http://{}", upstream_addr),
        ws_base_url: format!("ws://{}", upstream_addr),
        upstream_base_path: VSCODE_CLI_UPSTREAM_BASE_PATH.to_string(),
        connection_token: Some("fresh-token".to_string()),
    };

    let path = authorized_http_url(
        &connection,
        "/?folder=%2Ftmp&tkn=stale-query",
        &HeaderMap::from_iter([(
            axum::http::header::COOKIE,
            HeaderValue::from_static("vscode-tkn=stale-cookie; theme=dark"),
        )]),
    );

    assert_eq!(
        path,
        format!(
            "http://{}/code/vscode-cli/?folder=%2Ftmp&tkn=fresh-token",
            upstream_addr
        )
    );
}

#[tokio::test]
async fn removed_shared_code_path_returns_not_found() {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = AppState::new(tmp.path().to_path_buf()).await;
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let response = reqwest::get(format!("http://{addr}/code")).await.unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn vscode_status_endpoint_reports_not_installed() {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = AppState::new(tmp.path().to_path_buf()).await;
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let response = reqwest::get(format!("http://{addr}/api/vscode"))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["selectedRuntime"], "vscodeCli");
    assert_eq!(
        body["codeServer"]["installedVersion"],
        serde_json::Value::Null
    );
    assert_eq!(
        body["vscodeCli"]["installedVersion"],
        serde_json::Value::Null
    );
    assert_eq!(body["vscodeCli"]["processStatus"], "stopped");
}

#[tokio::test]
async fn vscode_install_endpoint_installs_and_starts_code_server_runtime() {
    let download: DownloadRuntimeFn = Arc::new(move |request: CodeServerDownloadRequest| {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let dir_name = runtime_dir_name(&request.version, request.platform);
            let runtime_dir = request.root_dir.join(RUNTIMES_DIR).join(&dir_name);
            tokio::fs::create_dir_all(runtime_dir.join("bin")).await?;
            tokio::fs::write(runtime_dir.join("bin").join("code-server"), "#!/bin/sh\n").await?;
            Ok(InstalledRuntime {
                version: request.version.clone(),
                version_semver: Version::parse(&request.version).unwrap(),
                platform: request.platform,
                runtime_dir: runtime_dir.clone(),
                binary_path: runtime_dir.join("bin").join("code-server"),
            })
        })
    });
    let launch: LaunchFn = Arc::new(move |request| {
        Box::pin(async move {
            Ok(RunningCodeServer {
                connection: CodeServerConnection {
                    base_url: format!("http://{}:{}", request.host, request.port),
                },
                process: ManagedProcessRuntime::External,
            })
        })
    });

    let tmp = tempfile::TempDir::new().unwrap();
    let mut state = AppState::new(tmp.path().to_path_buf()).await;
    replace_code_server_runtime(
        &mut state,
        Arc::new(CodeServerManager::with_hooks(
            tmp.path().join("code-server"),
            static_fetch_latest("4.114.1"),
            download,
            launch,
        )),
    )
    .await;
    select_code_server_runtime(&state).await;
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let client = reqwest::Client::new();
    let response = client
        .post(format!("http://{addr}/api/vscode/install"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["selectedRuntime"], "codeServer");
    assert_eq!(
        body["codeServer"]["installedVersion"],
        serde_json::Value::Null
    );
    assert!(
        body["codeServer"]["processStatus"] == "stopped"
            || body["codeServer"]["processStatus"] == "installing"
    );
    assert_eq!(
        body["codeServer"]["latest"]["latestVersion"],
        serde_json::Value::Null
    );

    let started = tokio::time::Instant::now();
    loop {
        let response = client
            .get(format!("http://{addr}/api/vscode"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let body: serde_json::Value = response.json().await.unwrap();
        if body["codeServer"]["processStatus"] == "running" {
            assert_eq!(body["codeServer"]["installedVersion"], "4.114.1");
            assert_eq!(
                body["codeServer"]["installProgress"],
                serde_json::Value::Null
            );
            break;
        }

        assert!(
            started.elapsed() < Duration::from_secs(2),
            "code-server install never reached running state: {body}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn vscode_install_endpoint_rejects_invalid_code_server_versions() {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = AppState::new(tmp.path().to_path_buf()).await;
    select_code_server_runtime(&state).await;
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let client = reqwest::Client::new();
    let response = client
        .post(format!("http://{addr}/api/vscode/install"))
        .json(&serde_json::json!({ "version": "latest" }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(
        body["message"],
        serde_json::Value::String("invalid code-server version: latest".to_string())
    );

    let status = client
        .get(format!("http://{addr}/api/vscode"))
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = status.json().await.unwrap();
    assert_eq!(body["selectedRuntime"], "codeServer");
    assert_eq!(body["codeServer"]["processStatus"], "stopped");
    assert_eq!(
        body["codeServer"]["installProgress"],
        serde_json::Value::Null
    );
}

#[tokio::test]
async fn force_reinstall_reuses_installed_version() {
    let requests = Arc::new(Mutex::new(Vec::<(String, bool)>::new()));
    let requests_for_download = requests.clone();
    let download: DownloadRuntimeFn = Arc::new(move |request: CodeServerDownloadRequest| {
        let requests = requests_for_download.clone();
        Box::pin(async move {
            requests
                .lock()
                .await
                .push((request.version.clone(), request.force));
            let dir_name = runtime_dir_name(&request.version, request.platform);
            let runtime_dir = request.root_dir.join(RUNTIMES_DIR).join(&dir_name);
            tokio::fs::create_dir_all(runtime_dir.join("bin")).await?;
            tokio::fs::write(runtime_dir.join("bin").join("code-server"), "#!/bin/sh\n").await?;
            Ok(InstalledRuntime {
                version: request.version.clone(),
                version_semver: Version::parse(&request.version).unwrap(),
                platform: request.platform,
                runtime_dir: runtime_dir.clone(),
                binary_path: runtime_dir.join("bin").join("code-server"),
            })
        })
    });
    let launch: LaunchFn = Arc::new(move |request| {
        Box::pin(async move {
            Ok(RunningCodeServer {
                connection: CodeServerConnection {
                    base_url: format!("http://{}:{}", request.host, request.port),
                },
                process: ManagedProcessRuntime::External,
            })
        })
    });
    let tmp = tempfile::TempDir::new().unwrap();
    let manager = CodeServerManager::with_hooks(
        tmp.path().join("code-server"),
        static_fetch_latest("9.9.9"),
        download,
        launch,
    );

    start_code_server_install_task(&manager, Some("4.114.1".to_string()), false).await;
    wait_for_running_status(&manager).await;

    start_code_server_install_task(&manager, None, true).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while tokio::time::Instant::now() < deadline {
        if requests.lock().await.len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    wait_for_running_status(&manager).await;

    let requests = requests.lock().await.clone();
    assert_eq!(
        requests,
        vec![
            ("4.114.1".to_string(), false),
            ("4.114.1".to_string(), true),
        ]
    );
}

#[tokio::test]
async fn install_emits_code_server_updated_events_with_progress() {
    let events = Arc::new(EventBus::new());
    let mut rx = events.subscribe();
    let download: DownloadRuntimeFn = Arc::new(move |request: CodeServerDownloadRequest| {
        Box::pin(async move {
            if let Some(progress) = &request.install_progress {
                progress(ManagerCodeServerInstallProgress {
                    phase: CodeServerInstallPhaseValue::Downloading,
                    percent: 42,
                    downloaded_bytes: Some(42),
                    total_bytes: Some(100),
                })
                .await;
            }

            let dir_name = runtime_dir_name(&request.version, request.platform);
            let runtime_dir = request.root_dir.join(RUNTIMES_DIR).join(&dir_name);
            tokio::fs::create_dir_all(runtime_dir.join("bin")).await?;
            tokio::fs::write(runtime_dir.join("bin").join("code-server"), "#!/bin/sh\n").await?;

            Ok(InstalledRuntime {
                version: request.version.clone(),
                version_semver: Version::parse(&request.version).unwrap(),
                platform: request.platform,
                runtime_dir: runtime_dir.clone(),
                binary_path: runtime_dir.join("bin").join("code-server"),
            })
        })
    });
    let launch: LaunchFn = Arc::new(move |_request| {
        Box::pin(async {
            Ok(RunningCodeServer {
                connection: CodeServerConnection {
                    base_url: "http://127.0.0.1:1234".into(),
                },
                process: ManagedProcessRuntime::External,
            })
        })
    });
    let tmp = tempfile::TempDir::new().unwrap();
    let code_server = Arc::new(CodeServerManager::with_hooks(
        tmp.path().join("code-server"),
        static_fetch_latest("4.114.1"),
        download,
        launch,
    ));
    code_server.clone().register_process_callback().await;
    let process_service = Arc::new(ManagedProcessService::new(events.clone()));

    let settings = Arc::new(
        SettingsManager::new(tmp.path().join("settings.toml"))
            .await
            .unwrap(),
    );
    settings
        .patch(SettingsPatch {
            appearance: None,
            terminal: None,
            editor: None,
            worktree: None,
            experimental: None,
            vscode: Some(VscodeSettingsPatch {
                runtime: Some(VscodeRuntimeKind::CodeServer),
            }),
            chat: None,
        })
        .await
        .unwrap();
    let vscode_cli = Arc::new(VscodeCliManager::new(
        tmp.path().join("vscode-cli"),
        events.clone(),
        process_service.clone(),
    ));
    vscode_cli.clone().register_process_callback().await;
    let tasks = Arc::new(TaskService::new(events.clone()));
    register_vscode_tasks(&tasks, code_server.clone(), vscode_cli.clone());
    let manager = Arc::new(VscodeManager::new(
        settings,
        events.clone(),
        tasks,
        code_server,
        vscode_cli,
    ));
    manager.clone().register_status_callbacks().await;

    let initial = manager
        .install(Some("4.114.1".to_string()), false)
        .await
        .unwrap();
    assert!(
        matches!(
            initial.code_server.process_status,
            CodeServerProcessStatusValue::Stopped
                | CodeServerProcessStatusValue::Installing
                | CodeServerProcessStatusValue::Running
        ),
        "install() should return a valid immediate snapshot while the task \
             races the status read"
    );

    let mut saw_preparing = false;
    let mut saw_downloading = false;
    let mut saw_task_backed_update = false;
    let mut saw_running = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);

    while tokio::time::Instant::now() < deadline && !saw_running {
        let timeout = deadline.saturating_duration_since(tokio::time::Instant::now());
        let event = tokio::time::timeout(timeout, rx.recv())
            .await
            .unwrap()
            .unwrap();

        let EventKind::VscodeUpdated(status) = &event.kind else {
            continue;
        };

        let code_server_status = &status.code_server;

        if code_server_status.process_status == VscodeProcessStatus::Installing {
            if code_server_status.active_task_id.is_some() {
                saw_task_backed_update = true;
            }

            if code_server_status
                .install_progress
                .as_ref()
                .is_some_and(|progress| progress.phase == VscodeInstallPhase::Preparing)
            {
                saw_preparing = true;
            }

            if code_server_status
                .install_progress
                .as_ref()
                .is_some_and(|progress| {
                    progress.phase == VscodeInstallPhase::Downloading
                        && progress.percent == 42
                        && progress.downloaded_bytes == Some(42)
                        && progress.total_bytes == Some(100)
                })
            {
                saw_downloading = true;
            }
        }

        if code_server_status.process_status == VscodeProcessStatus::Running {
            if code_server_status.active_task_id.is_some() {
                saw_task_backed_update = true;
            }

            if code_server_status.active_task_id.is_none()
                && code_server_status.install_progress.is_none()
            {
                assert_eq!(
                    code_server_status.installed_version.as_deref(),
                    Some("4.114.1")
                );
                saw_running = true;
            }
        }
    }

    assert!(
        saw_task_backed_update,
        "missing active task id during install"
    );
    assert!(saw_preparing, "missing preparing code-server event");
    assert!(saw_downloading, "missing downloading code-server event");
    assert!(saw_running, "missing running code-server event");
}

#[tokio::test]
async fn vscode_cli_install_stop_does_not_wait_on_its_own_install_state() {
    let events = Arc::new(EventBus::new());
    let process_service = Arc::new(ManagedProcessService::new(events.clone()));
    let manager = Arc::new(VscodeCliManager::new(
        tempfile::TempDir::new().unwrap().path().join("vscode-cli"),
        events,
        process_service,
    ));

    {
        let mut state = manager.inner.lock().await;
        state.runtime = VscodeCliRuntimeState::Installing;
    }

    tokio::time::timeout(
        Duration::from_millis(200),
        manager.stop_managed_process_for_install(),
    )
    .await
    .expect("install stop path should not block on current install state")
    .unwrap();
}

#[tokio::test]
async fn vscode_cli_stop_waits_for_in_progress_install() {
    let events = Arc::new(EventBus::new());
    let process_service = Arc::new(ManagedProcessService::new(events.clone()));
    let manager = Arc::new(VscodeCliManager::new(
        tempfile::TempDir::new().unwrap().path().join("vscode-cli"),
        events,
        process_service,
    ));

    {
        let mut state = manager.inner.lock().await;
        state.runtime = VscodeCliRuntimeState::Installing;
    }

    let manager_for_stop = manager.clone();
    let stop_task = tokio::spawn(async move { manager_for_stop.stop().await });

    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !stop_task.is_finished(),
        "stop should wait for install completion"
    );

    {
        let mut state = manager.inner.lock().await;
        state.runtime = VscodeCliRuntimeState::Idle;
    }
    manager.notify.notify_waiters();

    stop_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn vscode_cli_restart_waits_for_in_progress_install_before_starting() {
    let tmp = tempfile::TempDir::new().unwrap();
    let events = Arc::new(EventBus::new());
    let process_service = Arc::new(ManagedProcessService::new(events.clone()));
    let manager = Arc::new(VscodeCliManager::new(
        tmp.path().join("vscode-cli"),
        events,
        process_service,
    ));

    {
        let mut state = manager.inner.lock().await;
        state.runtime = VscodeCliRuntimeState::Installing;
    }

    let manager_for_restart = manager.clone();
    let restart_task = tokio::spawn(async move { manager_for_restart.restart().await });

    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !restart_task.is_finished(),
        "restart should wait for install completion before starting"
    );

    {
        let mut state = manager.inner.lock().await;
        state.runtime = VscodeCliRuntimeState::Idle;
    }
    manager.notify.notify_waiters();

    let error = restart_task.await.unwrap().unwrap_err();
    match detect_vscode_cli_platform() {
        Ok(_) => assert!(matches!(error, VscodeCliError::NotInstalled)),
        Err(VscodeCliError::UnsupportedPlatform(_)) => {
            assert!(matches!(error, VscodeCliError::UnsupportedPlatform(_)))
        }
        Err(other) => panic!("unexpected platform detection result: {other:?}"),
    }
}

#[tokio::test]
async fn unrelated_task_removals_do_not_publish_vscode_updates() {
    let tmp = tempfile::TempDir::new().unwrap();
    let events = Arc::new(EventBus::new());
    let process_service = Arc::new(ManagedProcessService::new(events.clone()));
    let settings = Arc::new(
        SettingsManager::new(tmp.path().join("settings.toml"))
            .await
            .unwrap(),
    );
    let tasks = Arc::new(TaskService::new(events.clone()));
    let code_server = Arc::new(CodeServerManager::new(
        tmp.path().join("code-server"),
        events.clone(),
        process_service.clone(),
    ));
    let vscode_cli = Arc::new(VscodeCliManager::new(
        tmp.path().join("vscode-cli"),
        events.clone(),
        process_service,
    ));
    let manager = Arc::new(VscodeManager::new(
        settings,
        events.clone(),
        tasks,
        code_server,
        vscode_cli,
    ));
    manager.clone().register_status_callbacks().await;

    let mut rx = events.subscribe();
    events.emit(EventKind::TaskRemoved(Box::new(TaskRemoved {
        id: "other-task".to_string(),
    })));

    let saw_vscode_update = tokio::time::timeout(Duration::from_millis(100), async {
        loop {
            let event = rx.recv().await.unwrap();
            if matches!(event.kind, EventKind::VscodeUpdated(_)) {
                return true;
            }
        }
    })
    .await
    .is_ok();

    assert!(!saw_vscode_update);
}

async fn wait_for_running_status(manager: &CodeServerManager) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while tokio::time::Instant::now() < deadline {
        let status = manager.status().await;
        if status.process_status == CodeServerProcessStatusValue::Running {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    panic!("code-server never reached running state");
}

async fn start_code_server_install_task(
    manager: &CodeServerManager,
    version: Option<String>,
    force: bool,
) {
    let events = Arc::new(EventBus::new());
    let tasks = TaskService::new(events.clone());
    let processes = Arc::new(ManagedProcessService::new(events));
    let runtime_root = manager
        .root_dir
        .parent()
        .unwrap_or(manager.root_dir.as_path())
        .to_path_buf();
    let vscode_cli = Arc::new(VscodeCliManager::new(
        runtime_root.join("vscode-cli-test"),
        Arc::new(EventBus::new()),
        processes,
    ));
    register_vscode_tasks(&tasks, Arc::new(manager.clone()), vscode_cli);
    tasks
        .start(
            TASK_VSCODE_INSTALL_RUNTIME,
            vscode_task_input(VscodeRuntimeKind::CodeServer, version, force),
        )
        .await
        .unwrap();
}
