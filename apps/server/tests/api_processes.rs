#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::path::{Path, PathBuf};

use hubris_server::{AppState, build_router};
use reqwest::StatusCode;
use serde_json::Value;

pub mod support;

use support::start_test_server;

const RUNTIME_VERSION: &str = "1.2.3";

#[cfg(unix)]
async fn start_test_server_with_runtime() -> (String, tempfile::TempDir, PathBuf) {
    let tmp = tempfile::TempDir::new().unwrap();
    let marker = tmp.path().join("runtime-starts");
    install_fake_vscode_cli(tmp.path(), &marker).await;
    let state = AppState::new(tmp.path().to_path_buf()).await;
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (format!("http://{addr}"), tmp, marker)
}

#[cfg(unix)]
async fn install_fake_vscode_cli(data_dir: &Path, marker: &Path) {
    let (os, arch) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => ("linux", "x64"),
        ("macos", "aarch64") => ("darwin", "arm64"),
        ("macos", "x86_64") => ("darwin", "x64"),
        platform => panic!("unsupported test platform: {platform:?}"),
    };
    let runtime_dir = data_dir
        .join("vscode-cli")
        .join("runtimes")
        .join(format!("vscode-cli-{RUNTIME_VERSION}-{os}-{arch}"));
    tokio::fs::create_dir_all(&runtime_dir).await.unwrap();
    let binary = runtime_dir.join("code");
    let executable = shell_quote(&std::env::current_exe().unwrap());
    let marker = shell_quote(marker);
    let script = format!(
        "#!/bin/sh\n\
         port=\n\
         while [ \"$#\" -gt 0 ]; do\n\
           if [ \"$1\" = \"--port\" ]; then shift; port=\"$1\"; fi\n\
           shift\n\
         done\n\
         printf 'started\\n' >> {marker}\n\
         HUBRIS_FAKE_VSCODE_PORT=\"$port\" exec {executable} --ignored --exact \
         fake_vscode_cli_server_helper\n"
    );
    tokio::fs::write(&binary, script).await.unwrap();
    tokio::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755))
        .await
        .unwrap();
}

#[cfg(unix)]
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"))
}

#[cfg(unix)]
async fn wait_for_start_count(path: &Path, expected: usize) -> String {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if let Ok(contents) = tokio::fs::read_to_string(path).await
            && contents.lines().count() >= expected
            && !contents.trim().is_empty()
        {
            return contents;
        }

        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {} starts in {}",
            expected,
            path.display()
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

#[cfg(unix)]
#[tokio::test]
#[ignore]
async fn fake_vscode_cli_server_helper() {
    let Some(port) = std::env::var_os("HUBRIS_FAKE_VSCODE_PORT") else {
        return;
    };
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", port.to_string_lossy()))
        .await
        .unwrap();
    let app = axum::Router::new().fallback(|| async { StatusCode::OK });
    axum::serve(listener, app).await.unwrap();
}

#[tokio::test]
async fn test_list_processes_reports_real_app_state_registrations() {
    let (base, _tmp) = start_test_server().await;

    let response = reqwest::get(format!("{base}/api/processes")).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let processes: Vec<Value> = response.json().await.unwrap();
    let ids = processes
        .iter()
        .map(|process| process["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(ids, vec!["code_server", "vscode_cli"]);
    for process in processes {
        assert!(process["kind"].is_string());
        assert_eq!(process["lifecycleState"], "stopped");
        assert!(process["pid"].is_null());
    }
}

#[tokio::test]
async fn test_get_process_uses_contract_shape() {
    let (base, _tmp) = start_test_server().await;

    let response = reqwest::get(format!("{base}/api/processes/vscode_cli"))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["id"], "vscode_cli");
    assert_eq!(body["kind"], "vscode-cli");
    assert_eq!(body["lifecycleState"], "stopped");
    assert!(body["startedAt"].is_null());
    assert!(body["lastExit"].is_null());
    assert!(body["lastError"].is_null());
}

#[tokio::test]
async fn test_get_process_returns_not_found_for_unknown_id() {
    let (base, _tmp) = start_test_server().await;

    let response = reqwest::get(format!("{base}/api/processes/missing"))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["message"], "unknown managed process: missing");
}

#[cfg(unix)]
#[tokio::test]
async fn test_start_restart_and_stop_process_control_real_runtime() {
    let (base, _tmp, marker) = start_test_server_with_runtime().await;
    let client = reqwest::Client::new();

    let response = client
        .post(format!("{base}/api/processes/vscode_cli/start"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let started: Value = response.json().await.unwrap();
    assert_eq!(started["id"], "vscode_cli");
    assert_eq!(started["lifecycleState"], "running");
    assert!(started["pid"].is_number());
    assert!(started["startedAt"].is_string());
    wait_for_start_count(&marker, 1).await;

    let response = client
        .post(format!("{base}/api/processes/vscode_cli/restart"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let restarted: Value = response.json().await.unwrap();
    assert_eq!(restarted["lifecycleState"], "running");
    assert!(restarted["pid"].is_number());
    wait_for_start_count(&marker, 2).await;

    let response = client
        .post(format!("{base}/api/processes/vscode_cli/stop"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let stopped: Value = response.json().await.unwrap();
    assert_eq!(stopped["id"], "vscode_cli");
    assert_eq!(stopped["lifecycleState"], "stopped");
    assert!(stopped["pid"].is_null());
}

#[tokio::test]
async fn test_process_actions_return_not_found_for_unknown_id() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    for action in ["start", "stop", "restart"] {
        let response = client
            .post(format!("{base}/api/processes/missing/{action}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{action}");
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["message"], "unknown managed process: missing");
    }
}
