use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::time::Duration;

use hubris_server::DESKTOP_BOOTSTRAP_PATH;
use reqwest::StatusCode;
use serde::Deserialize;
use tempfile::TempDir;

#[derive(Debug, Deserialize)]
struct StartupMessage {
    ready: bool,
    pid: u32,
    port: u16,
    error: Option<String>,
}

fn cookie_pair(response: &reqwest::Response) -> String {
    response
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

fn start_runtime() -> (std::process::Child, StartupMessage, TempDir, TempDir) {
    let data_tmp = TempDir::new().unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_hubris-desktop-runtime"))
        .env("HUBRIS_DATA_DIR", data_tmp.path())
        .env("HUBRIS_DESKTOP_SESSION_TOKEN", "session-token")
        .env("HUBRIS_DESKTOP_BOOTSTRAP_TOKEN", "bootstrap-token")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();

    let stdout = child.stdout.take().unwrap();
    let mut lines = BufReader::new(stdout).lines();
    let startup: StartupMessage = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();

    (child, startup, TempDir::new().unwrap(), data_tmp)
}

#[tokio::test]
async fn desktop_runtime_emits_startup_contract_and_serves_backend_after_bootstrap() {
    let (mut child, startup, _unused_tmp, _data_tmp) = start_runtime();
    assert!(startup.ready);
    assert!(startup.pid > 0);
    assert!(startup.port > 0);
    assert_eq!(startup.error, None);

    let base = format!("http://127.0.0.1:{}", startup.port);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    let unauthorized = client.get(&base).send().await.unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let bootstrap = client
        .get(format!(
            "{base}{DESKTOP_BOOTSTRAP_PATH}?token=bootstrap-token"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(bootstrap.status(), StatusCode::FOUND);
    let cookie = cookie_pair(&bootstrap);

    let api = client
        .get(format!("{base}/api/projects"))
        .header(reqwest::header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(api.status(), StatusCode::OK);

    let code_server = client
        .get(format!("{base}/_hubris/vscode/code-server/connection"))
        .header(reqwest::header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_ne!(code_server.status(), StatusCode::UNAUTHORIZED);

    child.kill().unwrap();
    let _ = child.wait();
}
