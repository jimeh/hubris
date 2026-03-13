use hubris_server::{AppState, build_router};
use reqwest::StatusCode;
use serde_json::Value;

async fn start_test_server() -> (String, tempfile::TempDir) {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = AppState::new(tmp.path().to_path_buf());
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

        let chunk = tokio::time::timeout(std::time::Duration::from_secs(2), res.chunk())
            .await
            .unwrap()
            .unwrap()
            .expect("SSE stream ended before next event");
        buffer.extend_from_slice(&chunk);
    }
}

#[tokio::test]
async fn patch_updates_nested_keys_without_dropping_siblings() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .put(format!("{}/api/settings", base))
        .json(&serde_json::json!({
            "appearance": {
                "colorScheme": "dark",
                "lightTheme": "hubris-light",
                "darkTheme": "hubris-dark"
            },
            "terminal": {
                "fontSource": "default",
                "systemFontFamily": "",
                "bundledFont": "jetbrainsmono-nf",
                "fontSize": 14
            },
            "worktree": {
                "locationMode": "dataDir"
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let res = client
        .patch(format!("{}/api/settings", base))
        .json(&serde_json::json!({
            "terminal": {
                "fontSize": 16
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let settings: Value = res.json().await.unwrap();
    assert_eq!(settings["appearance"]["colorScheme"], "dark");
    assert_eq!(settings["terminal"]["fontSize"], 16);
    assert_eq!(settings["worktree"]["locationMode"], "dataDir");
}

#[tokio::test]
async fn patch_null_reverts_to_default_and_removes_persisted_key() {
    let (base, tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .patch(format!("{}/api/settings", base))
        .json(&serde_json::json!({
            "appearance": {
                "colorScheme": "dark"
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let res = client
        .patch(format!("{}/api/settings", base))
        .json(&serde_json::json!({
            "appearance": {
                "colorScheme": null
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let settings: Value = res.json().await.unwrap();
    assert_eq!(settings["appearance"]["colorScheme"], "auto");

    let raw = tokio::fs::read_to_string(tmp.path().join("settings.json"))
        .await
        .unwrap();
    let persisted: Value = serde_json::from_str(&raw).unwrap();
    assert!(persisted["appearance"]["colorScheme"].is_null());
}

#[tokio::test]
async fn sequential_patches_merge_across_sections() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .patch(format!("{}/api/settings", base))
        .json(&serde_json::json!({
            "appearance": {
                "colorScheme": "dark"
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let res = client
        .patch(format!("{}/api/settings", base))
        .json(&serde_json::json!({
            "terminal": {
                "fontSize": 18
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let res = client
        .get(format!("{}/api/settings", base))
        .send()
        .await
        .unwrap();
    let settings: Value = res.json().await.unwrap();

    assert_eq!(settings["appearance"]["colorScheme"], "dark");
    assert_eq!(settings["terminal"]["fontSize"], 18);
}

#[tokio::test]
async fn sse_snapshot_includes_settings_and_writes_emit_settings_updated() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let mut stream = client
        .get(format!("{}/api/events", base))
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .unwrap();
    let mut buffer = Vec::new();

    let (event_name, snapshot) = next_sse_event(&mut stream, &mut buffer).await;
    assert_eq!(event_name, "snapshot");
    assert_eq!(snapshot["type"], "snapshot");
    assert_eq!(
        snapshot["data"]["settings"]["appearance"]["colorScheme"],
        "auto"
    );

    let res = client
        .put(format!("{}/api/settings", base))
        .json(&serde_json::json!({
            "appearance": {
                "colorScheme": "dark",
                "lightTheme": "hubris-light",
                "darkTheme": "hubris-dark"
            },
            "terminal": {
                "fontSource": "default",
                "systemFontFamily": "",
                "bundledFont": "jetbrainsmono-nf",
                "fontSize": 14
            },
            "worktree": {
                "locationMode": "dataDir"
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let (event_name, updated) = next_sse_event(&mut stream, &mut buffer).await;
    assert_eq!(event_name, "settings_updated");
    assert_eq!(updated["type"], "settings_updated");
    assert_eq!(updated["data"]["appearance"]["colorScheme"], "dark");

    let res = client
        .patch(format!("{}/api/settings", base))
        .json(&serde_json::json!({
            "terminal": {
                "fontSize": 20
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let (event_name, updated) = next_sse_event(&mut stream, &mut buffer).await;
    assert_eq!(event_name, "settings_updated");
    assert_eq!(updated["type"], "settings_updated");
    assert_eq!(updated["data"]["terminal"]["fontSize"], 20);
}
