use std::time::Duration;

use hubris_server::{AppState, build_router};
use reqwest::StatusCode;
use serde_json::Value;

async fn start_test_server(initial_keybindings: Option<&str>) -> (String, tempfile::TempDir) {
    let tmp = tempfile::TempDir::new().unwrap();
    if let Some(keybindings) = initial_keybindings {
        std::fs::write(tmp.path().join("keybindings.toml"), keybindings).unwrap();
    }

    let state = AppState::new(tmp.path().to_path_buf()).await;
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (format!("http://{}", addr), tmp)
}

fn find_sse_separator(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .or_else(|| buffer.windows(4).position(|window| window == b"\r\n\r\n"))
}

async fn next_sse_event(res: &mut reqwest::Response, buffer: &mut Vec<u8>) -> (String, Value) {
    loop {
        if let Some(separator) = find_sse_separator(buffer) {
            let separator_len = if buffer.get(separator..separator + 4) == Some(b"\r\n\r\n") {
                4
            } else {
                2
            };
            let raw = buffer
                .drain(..separator + separator_len)
                .collect::<Vec<_>>();
            let text = String::from_utf8(raw).unwrap();

            let mut event_name = None;
            let mut data = None;

            for line in text.lines() {
                if let Some(value) = line.strip_prefix("event:") {
                    event_name = Some(value.trim().to_string());
                } else if let Some(value) = line.strip_prefix("data:") {
                    data = Some(serde_json::from_str(value.trim()).unwrap());
                }
            }

            if let (Some(event_name), Some(data)) = (event_name, data) {
                return (event_name, data);
            }
        }

        let chunk = tokio::time::timeout(Duration::from_secs(2), res.chunk())
            .await
            .unwrap()
            .unwrap()
            .expect("SSE stream ended before next event");
        buffer.extend_from_slice(&chunk);
    }
}

async fn wait_for_keybindings(
    client: &reqwest::Client,
    base: &str,
    timeout: Duration,
    interval: Duration,
    failure_message: &str,
    mut predicate: impl FnMut(&Value) -> bool,
) -> Value {
    let attempts = (timeout.as_millis() / interval.as_millis()).max(1) as usize;
    let mut last_body = None;

    for _ in 0..attempts {
        let res = client
            .get(format!("{}/api/keybindings", base))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body: Value = res.json().await.unwrap();
        if predicate(&body) {
            return body;
        }
        last_body = Some(body);
        tokio::time::sleep(interval).await;
    }

    match last_body {
        Some(body) => panic!("{failure_message}; last response: {body}"),
        None => panic!("{failure_message}; keybindings were never fetched"),
    }
}

#[tokio::test]
async fn get_keybindings_returns_file_backed_entries() {
    let (base, _tmp) = start_test_server(Some(
        r#"[[keybindings]]
key = "cmd+shift+p"
command = "app.openCommandPalette"
when = "isMacOS"
"#,
    ))
    .await;
    let client = reqwest::Client::new();

    let res = client
        .get(format!("{}/api/keybindings", base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value = res.json().await.unwrap();

    assert_eq!(body["keybindings"][0]["key"], "cmd+shift+p");
    assert_eq!(body["keybindings"][0]["command"], "app.openCommandPalette");
    assert_eq!(body["keybindings"][0]["when"], "isMacOS");
    assert_eq!(body["status"]["kind"], "ok");
}

#[tokio::test]
async fn put_keybindings_writes_file_and_emits_sse_update() {
    let (base, tmp) = start_test_server(None).await;
    let client = reqwest::Client::new();
    let mut events = client
        .get(format!("{}/api/events", base))
        .send()
        .await
        .unwrap();
    assert_eq!(events.status(), StatusCode::OK);
    let mut buffer = Vec::new();
    let (event_name, snapshot) = next_sse_event(&mut events, &mut buffer).await;
    assert_eq!(event_name, "snapshot");
    assert_eq!(snapshot["data"]["keybindings"].as_array().unwrap().len(), 0);
    assert_eq!(snapshot["data"]["keybindingsStatus"]["kind"], "ok");

    let res = client
        .put(format!("{}/api/keybindings", base))
        .json(&serde_json::json!([
            {
                "key": "cmd+alt+b",
                "command": "tab.newBrowser",
                "args": { "url": "http://localhost:5173" },
                "when": "selectedWorktree"
            }
        ]))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["keybindings"][0]["command"], "tab.newBrowser");

    let written = std::fs::read_to_string(tmp.path().join("keybindings.toml")).unwrap();
    assert!(written.contains("key = \"cmd+alt+b\""));
    assert!(written.contains("command = \"tab.newBrowser\""));
    assert!(written.contains("url = \"http://localhost:5173\""));

    let (event_name, update) = next_sse_event(&mut events, &mut buffer).await;
    assert_eq!(event_name, "keybindings_updated");
    assert_eq!(
        update["data"]["keybindings"][0]["command"],
        "tab.newBrowser"
    );
    assert_eq!(update["data"]["status"]["kind"], "ok");
}

#[tokio::test]
async fn put_keybindings_returns_conflict_while_file_is_malformed() {
    let (base, tmp) = start_test_server(Some(
        r#"[[keybindings]]
key = "cmd+shift+p"
command = "app.openCommandPalette"
"#,
    ))
    .await;
    let client = reqwest::Client::new();

    std::fs::write(tmp.path().join("keybindings.toml"), "[keybindings\n").unwrap();

    wait_for_keybindings(
        &client,
        &base,
        Duration::from_secs(1),
        Duration::from_millis(50),
        "keybindings status never became invalidFile",
        |body| body["status"]["kind"] == "invalidFile",
    )
    .await;

    let res = client
        .put(format!("{}/api/keybindings", base))
        .json(&serde_json::json!([]))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);
}
