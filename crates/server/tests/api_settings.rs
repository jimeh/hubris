use std::time::Duration;

use hubris_server::{AppState, build_router};
use reqwest::StatusCode;
use serde_json::Value;

async fn start_test_server(initial_settings: Option<&str>) -> (String, tempfile::TempDir) {
    let tmp = tempfile::TempDir::new().unwrap();
    if let Some(settings) = initial_settings {
        std::fs::write(tmp.path().join("settings.toml"), settings).unwrap();
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

async fn start_test_server_in_data_dir(data_dir: &std::path::Path) -> String {
    let state = AppState::new(data_dir.to_path_buf()).await;
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    format!("http://{}", addr)
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

async fn wait_for_settings_generation(
    client: &reqwest::Client,
    base: &str,
    expected_generation: &str,
) -> Value {
    for _ in 0..20 {
        let res = client
            .get(format!("{}/api/settings", base))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body: Value = res.json().await.unwrap();
        if body["generation"] == expected_generation {
            return body;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    panic!("settings generation never reached {expected_generation}");
}

fn assert_default_settings(body: &Value) {
    assert_eq!(body["settings"]["appearance"]["colorScheme"], "auto");
    assert_eq!(body["settings"]["appearance"]["lightTheme"], "hubris-light");
    assert_eq!(body["settings"]["appearance"]["darkTheme"], "hubris-dark");
    assert_eq!(body["settings"]["terminal"]["fontSource"], "default");
    assert_eq!(
        body["settings"]["terminal"]["bundledFont"],
        "jetbrainsmono-nf"
    );
    assert_eq!(body["settings"]["terminal"]["fontSize"], 14);
    assert_eq!(body["settings"]["worktree"]["locationMode"], "dataDir");
}

fn assert_ok_status(body: &Value) {
    assert_eq!(body["status"]["kind"], "ok");
    assert_eq!(body["status"]["writesBlocked"], false);
    assert!(body["status"]["message"].is_null());
}

fn assert_invalid_status(body: &Value) {
    assert_eq!(body["status"]["kind"], "invalidFile");
    assert_eq!(body["status"]["writesBlocked"], true);
    assert!(body["status"]["message"].is_string());
}

fn assert_no_temp_files(dir: &std::path::Path) {
    let entries = std::fs::read_dir(dir).unwrap();
    let temp_files = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("settings.toml.tmp.")
        })
        .count();
    assert_eq!(temp_files, 0);
}

#[tokio::test]
async fn patch_preserves_comments_and_unknown_keys() {
    let (base, tmp) = start_test_server(Some(
        r#"# user comment
[appearance]
colorScheme = "auto"
lightTheme = "hubris-light"
darkTheme = "hubris-dark"
customKey = "keep-me"

[terminal]
fontSource = "default"
fontSize = 14
"#,
    ))
    .await;
    let client = reqwest::Client::new();

    let first = client
        .patch(format!("{}/api/settings", base))
        .json(&serde_json::json!({
            "appearance": {
                "colorScheme": "dark"
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_body: Value = first.json().await.unwrap();

    let second = client
        .patch(format!("{}/api/settings", base))
        .json(&serde_json::json!({
            "terminal": {
                "fontSize": 16
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    let second_body: Value = second.json().await.unwrap();

    let first_generation = first_body["generation"]
        .as_str()
        .unwrap()
        .parse::<u128>()
        .unwrap();
    let second_generation = second_body["generation"]
        .as_str()
        .unwrap()
        .parse::<u128>()
        .unwrap();
    assert!(second_generation > first_generation);

    let contents = std::fs::read_to_string(tmp.path().join("settings.toml")).unwrap();
    assert!(contents.contains("# user comment"));
    assert!(contents.contains("customKey = \"keep-me\""));
    assert!(contents.contains("colorScheme = \"dark\""));
    assert!(contents.contains("fontSize = 16"));
    assert_no_temp_files(tmp.path());
}

#[tokio::test]
async fn put_preserves_unknown_keys() {
    let (base, tmp) = start_test_server(Some(
        r#"[appearance]
colorScheme = "auto"
lightTheme = "hubris-light"
darkTheme = "hubris-dark"
customKey = "still-here"

[worktree]
locationMode = "dataDir"
extraMode = "keep"
"#,
    ))
    .await;
    let client = reqwest::Client::new();

    let res = client
        .put(format!("{}/api/settings", base))
        .json(&serde_json::json!({
            "appearance": {
                "colorScheme": "light",
                "lightTheme": "hubris-light",
                "darkTheme": "hubris-dark"
            },
            "terminal": {
                "fontSource": "bundled",
                "systemFontFamily": "",
                "bundledFont": "hack-nf",
                "fontSize": 15
            },
            "worktree": {
                "locationMode": "repoLocalDotHubris"
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let contents = std::fs::read_to_string(tmp.path().join("settings.toml")).unwrap();
    assert!(contents.contains("customKey = \"still-here\""));
    assert!(contents.contains("extraMode = \"keep\""));
    assert!(contents.contains("locationMode = \"repoLocalDotHubris\""));
    assert!(contents.contains("bundledFont = \"hack-nf\""));
    assert_no_temp_files(tmp.path());
}

#[tokio::test]
async fn snapshot_and_external_reload_include_settings_generation() {
    let (base, tmp) = start_test_server(Some(
        r#"[appearance]
colorScheme = "auto"
lightTheme = "hubris-light"
darkTheme = "hubris-dark"
"#,
    ))
    .await;
    let client = reqwest::Client::new();

    let mut res = client
        .get(format!("{}/api/events", base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let mut buffer = Vec::new();
    let (event_name, snapshot) = next_sse_event(&mut res, &mut buffer).await;
    assert_eq!(event_name, "snapshot");
    assert_eq!(snapshot["type"], "snapshot");
    assert_eq!(
        snapshot["data"]["settings"]["appearance"]["colorScheme"],
        "auto"
    );
    assert_eq!(snapshot["data"]["settings_status"]["kind"], "ok");
    let initial_generation = snapshot["data"]["settings_generation"]
        .as_str()
        .unwrap()
        .to_string();

    std::fs::write(
        tmp.path().join("settings.toml"),
        r#"[appearance]
colorScheme = "dark"
lightTheme = "hubris-light"
darkTheme = "hubris-dark"
"#,
    )
    .unwrap();

    let (event_name, update) = next_sse_event(&mut res, &mut buffer).await;
    assert_eq!(event_name, "settings_updated");
    assert_eq!(update["type"], "settings_updated");
    assert_eq!(
        update["data"]["settings"]["appearance"]["colorScheme"],
        "dark"
    );
    assert_eq!(update["data"]["status"]["kind"], "ok");
    let next_generation = update["data"]["generation"].as_str().unwrap();
    assert!(next_generation.parse::<u128>().unwrap() > initial_generation.parse::<u128>().unwrap());

    let current = wait_for_settings_generation(&client, &base, next_generation).await;
    assert_eq!(current["settings"]["appearance"]["colorScheme"], "dark");
}

#[tokio::test]
async fn invalid_external_toml_blocks_writes_and_keeps_last_good_settings() {
    let (base, tmp) = start_test_server(Some(
        r#"[appearance]
colorScheme = "auto"
lightTheme = "hubris-light"
darkTheme = "hubris-dark"
"#,
    ))
    .await;
    let client = reqwest::Client::new();

    let initial = client
        .get(format!("{}/api/settings", base))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_ok_status(&initial);
    let initial_generation = initial["generation"].as_str().unwrap().to_string();

    std::fs::write(
        tmp.path().join("settings.toml"),
        "[appearance\ncolorScheme = \"dark\"\n",
    )
    .unwrap();

    let current = loop {
        let current = client
            .get(format!("{}/api/settings", base))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        if current["status"]["kind"] == "invalidFile" {
            break current;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };

    assert_eq!(current["settings"], initial["settings"]);
    assert_eq!(current["generation"], initial_generation);
    assert_invalid_status(&current);

    let patch = client
        .patch(format!("{}/api/settings", base))
        .json(&serde_json::json!({
            "appearance": {
                "colorScheme": "dark"
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(patch.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn startup_invalid_toml_uses_defaults_and_blocks_writes() {
    let (base, _tmp) = start_test_server(Some("[appearance\ncolorScheme = \"dark\"\n")).await;
    let client = reqwest::Client::new();

    let current = client
        .get(format!("{}/api/settings", base))
        .send()
        .await
        .unwrap();
    assert_eq!(current.status(), StatusCode::OK);
    let current: Value = current.json().await.unwrap();
    assert_default_settings(&current);
    assert_invalid_status(&current);

    let patch = client
        .patch(format!("{}/api/settings", base))
        .json(&serde_json::json!({
            "appearance": {
                "colorScheme": "dark"
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(patch.status(), StatusCode::CONFLICT);

    let put = client
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
    assert_eq!(put.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn startup_invalid_toml_recovers_after_valid_file_is_written() {
    let (base, tmp) = start_test_server(Some("[appearance\ncolorScheme = \"dark\"\n")).await;
    let client = reqwest::Client::new();

    let mut res = client
        .get(format!("{}/api/events", base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let mut buffer = Vec::new();
    let (event_name, snapshot) = next_sse_event(&mut res, &mut buffer).await;
    assert_eq!(event_name, "snapshot");
    let initial_generation = snapshot["data"]["settings_generation"]
        .as_str()
        .unwrap()
        .to_string();
    assert_default_settings(&snapshot["data"]);
    assert_eq!(snapshot["data"]["settings_status"]["kind"], "invalidFile");

    std::fs::write(
        tmp.path().join("settings.toml"),
        r#"[appearance]
colorScheme = "dark"
lightTheme = "hubris-light"
darkTheme = "hubris-dark"
"#,
    )
    .unwrap();

    let (event_name, update) = next_sse_event(&mut res, &mut buffer).await;
    assert_eq!(event_name, "settings_updated");
    assert_eq!(
        update["data"]["settings"]["appearance"]["colorScheme"],
        "dark"
    );
    assert_eq!(update["data"]["status"]["kind"], "ok");
    let recovered_generation = update["data"]["generation"].as_str().unwrap();
    assert!(
        recovered_generation.parse::<u128>().unwrap() > initial_generation.parse::<u128>().unwrap()
    );

    let patched = client
        .patch(format!("{}/api/settings", base))
        .json(&serde_json::json!({
            "terminal": {
                "fontSize": 16
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(patched.status(), StatusCode::OK);
    let patched: Value = patched.json().await.unwrap();
    assert_eq!(patched["settings"]["terminal"]["fontSize"], 16);
    assert_ok_status(&patched);
}

#[tokio::test]
async fn runtime_invalid_toml_recovers_after_file_is_fixed() {
    let (base, tmp) = start_test_server(Some(
        r#"[appearance]
colorScheme = "dark"
lightTheme = "hubris-light"
darkTheme = "hubris-dark"
"#,
    ))
    .await;
    let client = reqwest::Client::new();

    let initial = client
        .get(format!("{}/api/settings", base))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_ok_status(&initial);
    let initial_generation = initial["generation"].as_str().unwrap().to_string();

    std::fs::write(
        tmp.path().join("settings.toml"),
        "[appearance\ncolorScheme = \"dark\"\n",
    )
    .unwrap();

    for _ in 0..20 {
        let current = client
            .get(format!("{}/api/settings", base))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        if current["status"]["kind"] == "invalidFile" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    std::fs::write(
        tmp.path().join("settings.toml"),
        r#"[appearance]
colorScheme = "dark"
lightTheme = "hubris-light"
darkTheme = "hubris-dark"
"#,
    )
    .unwrap();

    for _ in 0..20 {
        let current = client
            .get(format!("{}/api/settings", base))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        if current["status"]["kind"] == "ok" {
            assert_eq!(current["generation"], initial_generation);
            assert_eq!(current["settings"]["appearance"]["colorScheme"], "dark");
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    panic!("settings status never recovered");
}

#[tokio::test]
async fn polling_recovers_settings_when_notify_watch_setup_fails() {
    let tmp = tempfile::TempDir::new().unwrap();
    let data_dir = tmp.path().join("missing-data-dir");
    let base = start_test_server_in_data_dir(&data_dir).await;
    let client = reqwest::Client::new();

    let initial = client
        .get(format!("{}/api/settings", base))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_default_settings(&initial);
    assert_ok_status(&initial);

    std::fs::create_dir_all(&data_dir).unwrap();
    std::fs::write(
        data_dir.join("settings.toml"),
        r#"[appearance]
colorScheme = "dark"
lightTheme = "hubris-light"
darkTheme = "hubris-dark"
"#,
    )
    .unwrap();

    for _ in 0..20 {
        let current = client
            .get(format!("{}/api/settings", base))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        if current["settings"]["appearance"]["colorScheme"] == "dark" {
            assert_ok_status(&current);
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    panic!("settings poller never reloaded the new file");
}
