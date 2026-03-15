use std::sync::Arc;

use hubris_server::{AppState, build_router};
use reqwest::StatusCode;
use serde_json::Value;
use tokio::sync::{Barrier, oneshot};

async fn start_test_server() -> (String, tempfile::TempDir, AppState) {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = AppState::new(tmp.path().to_path_buf());
    let app = build_router(state.clone());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (format!("http://{}", addr), tmp, state)
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
    let (base, _tmp, _state) = start_test_server().await;
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
    let (base, tmp, _state) = start_test_server().await;
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
    let appearance = persisted.get("appearance").and_then(Value::as_object);
    assert!(
        appearance
            .map(|appearance| !appearance.contains_key("colorScheme"))
            .unwrap_or(true)
    );
}

#[tokio::test]
async fn sequential_patches_merge_across_sections() {
    let (base, _tmp, _state) = start_test_server().await;
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
    let (base, _tmp, _state) = start_test_server().await;
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

#[tokio::test]
async fn legacy_null_sections_load_and_can_be_repaired() {
    let (base, tmp, _state) = start_test_server().await;
    let client = reqwest::Client::new();

    tokio::fs::write(
        tmp.path().join("settings.json"),
        serde_json::json!({
            "appearance": null,
            "terminal": {
                "fontSize": 16
            },
            "worktree": null
        })
        .to_string(),
    )
    .await
    .unwrap();

    let res = client
        .get(format!("{}/api/settings", base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let settings: Value = res.json().await.unwrap();
    assert_eq!(settings["appearance"]["colorScheme"], "auto");
    assert_eq!(settings["terminal"]["fontSize"], 16);
    assert_eq!(settings["worktree"]["locationMode"], "dataDir");

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
    let settings: Value = res.json().await.unwrap();
    assert_eq!(settings["appearance"]["colorScheme"], "dark");
}

#[tokio::test]
async fn corrupt_persisted_settings_return_internal_server_error() {
    let (base, tmp, _state) = start_test_server().await;
    let client = reqwest::Client::new();

    tokio::fs::write(
        tmp.path().join("settings.json"),
        serde_json::json!({
            "terminal": {
                "fontSize": "huge"
            }
        })
        .to_string(),
    )
    .await
    .unwrap();

    let res = client
        .get(format!("{}/api/settings", base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn concurrent_patches_merge_under_lock() {
    let (base, _tmp, state) = start_test_server().await;
    let client = reqwest::Client::new();
    let guard = state.settings_lock.lock().await;
    let barrier = Arc::new(Barrier::new(3));

    let first_url = format!("{}/api/settings", base);
    let first_client = client.clone();
    let first_barrier = barrier.clone();
    let first = tokio::spawn(async move {
        first_barrier.wait().await;
        first_client
            .patch(first_url)
            .json(&serde_json::json!({
                "appearance": {
                    "colorScheme": "dark"
                }
            }))
            .send()
            .await
            .unwrap()
    });

    let second_url = format!("{}/api/settings", base);
    let second_client = client.clone();
    let second_barrier = barrier.clone();
    let second = tokio::spawn(async move {
        second_barrier.wait().await;
        second_client
            .patch(second_url)
            .json(&serde_json::json!({
                "terminal": {
                    "fontSize": 18
                }
            }))
            .send()
            .await
            .unwrap()
    });

    barrier.wait().await;
    drop(guard);

    let (first, second) = tokio::join!(first, second);
    assert_eq!(first.unwrap().status(), StatusCode::OK);
    assert_eq!(second.unwrap().status(), StatusCode::OK);

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
async fn put_then_patch_preserves_put_state_under_contention() {
    let (base, _tmp, state) = start_test_server().await;
    let client = reqwest::Client::new();
    let guard = state.settings_lock.lock().await;
    let (put_start_tx, put_start_rx) = oneshot::channel();
    let (put_ready_tx, put_ready_rx) = oneshot::channel();
    let (patch_start_tx, patch_start_rx) = oneshot::channel();

    let put_url = format!("{}/api/settings", base);
    let put_client = client.clone();
    let put = tokio::spawn(async move {
        put_start_rx.await.unwrap();
        put_ready_tx.send(()).unwrap();
        put_client
            .put(put_url)
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
            .unwrap()
    });

    let patch_url = format!("{}/api/settings", base);
    let patch_client = client.clone();
    let patch = tokio::spawn(async move {
        patch_start_rx.await.unwrap();
        patch_client
            .patch(patch_url)
            .json(&serde_json::json!({
                "terminal": {
                    "fontSize": 20
                }
            }))
            .send()
            .await
            .unwrap()
    });

    drop(guard);
    put_start_tx.send(()).unwrap();
    put_ready_rx.await.unwrap();
    patch_start_tx.send(()).unwrap();

    let (put, patch) = tokio::join!(put, patch);
    assert_eq!(put.unwrap().status(), StatusCode::OK);
    assert_eq!(patch.unwrap().status(), StatusCode::OK);

    let res = client
        .get(format!("{}/api/settings", base))
        .send()
        .await
        .unwrap();
    let settings: Value = res.json().await.unwrap();
    assert_eq!(settings["appearance"]["colorScheme"], "dark");
    assert_eq!(settings["terminal"]["fontSize"], 20);
}
