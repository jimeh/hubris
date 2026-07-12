#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::path::{Path, PathBuf};

use hubris_server::{AppState, build_router};
use reqwest::StatusCode;
use serde_json::Value;

const RUNTIME_VERSION: &str = "1.2.3";

async fn start_test_server() -> (String, tempfile::TempDir) {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = AppState::new(tmp.path().to_path_buf()).await;
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (format!("http://{addr}"), tmp)
}

#[cfg(unix)]
async fn start_test_server_with_runtime() -> (String, tempfile::TempDir, PathBuf) {
    let tmp = tempfile::TempDir::new().unwrap();
    let marker = tmp.path().join("runtime-starts");
    install_fake_vscode_cli(tmp.path(), &marker, None).await;
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
async fn start_test_server_with_gated_runtime() -> (String, tempfile::TempDir, PathBuf, PathBuf) {
    let tmp = tempfile::TempDir::new().unwrap();
    let marker = tmp.path().join("runtime-starts");
    let gate = tmp.path().join("runtime-ready");
    install_fake_vscode_cli(tmp.path(), &marker, Some(&gate)).await;
    let state = AppState::new(tmp.path().to_path_buf()).await;
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (format!("http://{addr}"), tmp, marker, gate)
}

#[cfg(unix)]
async fn install_fake_vscode_cli(data_dir: &Path, marker: &Path, gate: Option<&Path>) {
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
    let gate = gate.map(shell_quote).unwrap_or_default();
    let script = format!(
        "#!/bin/sh\n\
         port=\n\
         while [ \"$#\" -gt 0 ]; do\n\
           if [ \"$1\" = \"--port\" ]; then shift; port=\"$1\"; fi\n\
           shift\n\
         done\n\
         printf 'started\\n' >> {marker}\n\
         HUBRIS_FAKE_VSCODE_GATE={gate} HUBRIS_FAKE_VSCODE_PORT=\"$port\" \
         exec {executable} --ignored --exact \
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

async fn wait_for_process_status(client: &reqwest::Client, base: &str, expected: &str) -> Value {
    wait_for_vscode_state(client, base, |body| {
        body["vscodeCli"]["processStatus"] == expected
    })
    .await
}

/// Poll /api/vscode until the whole install task has settled: the
/// process status matches AND the task bookkeeping (installProgress,
/// activeTaskId) is cleared. Asserting bookkeeping fields the moment
/// the process turns running races the task's final updates on slow
/// runners.
async fn wait_for_settled_process_status(
    client: &reqwest::Client,
    base: &str,
    expected: &str,
) -> Value {
    wait_for_vscode_state(client, base, |body| {
        body["vscodeCli"]["processStatus"] == expected
            && body["vscodeCli"]["installProgress"].is_null()
            && body["vscodeCli"]["activeTaskId"].is_null()
    })
    .await
}

async fn wait_for_vscode_state(
    client: &reqwest::Client,
    base: &str,
    reached: impl Fn(&Value) -> bool,
) -> Value {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let response = client
            .get(format!("{base}/api/vscode"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        if reached(&body) {
            return body;
        }

        assert!(
            tokio::time::Instant::now() < deadline,
            "VS Code CLI did not reach the expected state: {body}"
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
    if let Some(gate) = std::env::var_os("HUBRIS_FAKE_VSCODE_GATE")
        && !gate.is_empty()
    {
        let gate = PathBuf::from(gate);
        loop {
            if let Ok(contents) = tokio::fs::read_to_string(&gate).await
                && !contents.trim().is_empty()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", port.to_string_lossy()))
        .await
        .unwrap();
    let app = axum::Router::new().fallback(|| async { StatusCode::OK });
    axum::serve(listener, app).await.unwrap();
}

#[tokio::test]
async fn test_get_vscode_reports_contract_shape() {
    let (base, _tmp) = start_test_server().await;

    let response = reqwest::get(format!("{base}/api/vscode")).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["selectedRuntime"], "vscodeCli");
    for runtime in ["codeServer", "vscodeCli"] {
        assert!(body[runtime]["supported"].is_boolean());
        assert!(body[runtime]["installedVersion"].is_null());
        assert_eq!(body[runtime]["processStatus"], "stopped");
        assert!(body[runtime]["installProgress"].is_null());
        assert!(body[runtime]["activeTaskId"].is_null());
    }
}

#[tokio::test]
async fn test_vscode_route_rejects_unsupported_method() {
    let (base, _tmp) = start_test_server().await;

    let response = reqwest::Client::new()
        .post(format!("{base}/api/vscode"))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
}

#[cfg(unix)]
#[tokio::test]
async fn test_install_start_stop_and_restart_control_local_runtime() {
    let (base, _tmp, marker) = start_test_server_with_runtime().await;
    let client = reqwest::Client::new();

    let response = client
        .post(format!("{base}/api/vscode/install"))
        .json(&serde_json::json!({ "version": RUNTIME_VERSION }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let accepted: Value = response.json().await.unwrap();
    assert_eq!(accepted["selectedRuntime"], "vscodeCli");
    assert!(accepted["vscodeCli"]["activeTaskId"].is_string());

    let installed = wait_for_settled_process_status(&client, &base, "running").await;
    assert_eq!(installed["vscodeCli"]["installedVersion"], RUNTIME_VERSION);
    wait_for_start_count(&marker, 1).await;

    let response = client
        .post(format!("{base}/api/vscode/stop"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let stopped: Value = response.json().await.unwrap();
    assert_eq!(stopped["vscodeCli"]["processStatus"], "stopped");
    assert_eq!(stopped["vscodeCli"]["installedVersion"], RUNTIME_VERSION);

    let response = client
        .post(format!("{base}/api/vscode/start"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let started: Value = response.json().await.unwrap();
    assert_eq!(started["vscodeCli"]["processStatus"], "running");
    wait_for_start_count(&marker, 2).await;

    let response = client
        .post(format!("{base}/api/vscode/restart"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let restarted: Value = response.json().await.unwrap();
    assert_eq!(restarted["vscodeCli"]["processStatus"], "running");
    wait_for_start_count(&marker, 3).await;

    let response = client
        .post(format!("{base}/api/vscode/stop"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[cfg(unix)]
#[tokio::test]
async fn test_check_update_rejects_busy_runtime_scope() {
    let (base, _tmp, marker, gate) = start_test_server_with_gated_runtime().await;
    let client = reqwest::Client::new();

    let install = client
        .post(format!("{base}/api/vscode/install"))
        .json(&serde_json::json!({ "version": RUNTIME_VERSION }))
        .send()
        .await
        .unwrap();
    assert_eq!(install.status(), StatusCode::ACCEPTED);
    wait_for_start_count(&marker, 1).await;

    let response = client
        .post(format!("{base}/api/vscode/check-update"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body: Value = response.json().await.unwrap();
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("vscode-runtime:vscodeCli is already busy")
    );

    tokio::fs::write(&gate, "ready\n").await.unwrap();
    wait_for_process_status(&client, &base, "running").await;
    let stopped = client
        .post(format!("{base}/api/vscode/stop"))
        .send()
        .await
        .unwrap();
    assert_eq!(stopped.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_install_rejects_invalid_version() {
    let (base, _tmp) = start_test_server().await;

    let response = reqwest::Client::new()
        .post(format!("{base}/api/vscode/install"))
        .json(&serde_json::json!({ "version": "latest" }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["message"], "invalid VS Code version: latest");
}

#[tokio::test]
async fn test_install_rejects_malformed_payload() {
    let (base, _tmp) = start_test_server().await;

    let response = reqwest::Client::new()
        .post(format!("{base}/api/vscode/install"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body("{")
        .send()
        .await
        .unwrap();

    assert!(response.status().is_client_error());
}

#[tokio::test]
async fn test_start_and_restart_reject_missing_runtime() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    for action in ["start", "restart"] {
        let response = client
            .post(format!("{base}/api/vscode/{action}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{action}");
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["message"], "VS Code CLI is not installed");
    }
}

#[tokio::test]
async fn test_stop_succeeds_when_runtime_is_already_stopped() {
    let (base, _tmp) = start_test_server().await;

    let response = reqwest::Client::new()
        .post(format!("{base}/api/vscode/stop"))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["selectedRuntime"], "vscodeCli");
    assert_eq!(body["vscodeCli"]["processStatus"], "stopped");
}

#[tokio::test]
async fn test_action_routes_reject_unsupported_methods() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    for action in ["check-update", "install", "start", "stop", "restart"] {
        let response = client
            .get(format!("{base}/api/vscode/{action}"))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::METHOD_NOT_ALLOWED,
            "{action}"
        );
    }
}
