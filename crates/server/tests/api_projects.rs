use hubris_server::{AppState, build_router};
use reqwest::StatusCode;
use serde_json::Value;

/// Spin up a test server on a random port and return the base URL.
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

#[tokio::test]
async fn test_list_empty() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .get(format!("{}/api/projects", base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body: Vec<Value> = res.json().await.unwrap();
    assert!(body.is_empty());
}

#[tokio::test]
async fn test_add_project_valid() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    // Use /tmp as a known-existing directory
    let res = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": "/tmp" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);

    let body: Value = res.json().await.unwrap();
    assert_eq!(body["name"], "tmp");
    assert_eq!(body["path"], "/tmp");
    assert!(body["id"].is_string());
}

#[tokio::test]
async fn test_add_project_has_position() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": "/tmp" }))
        .send()
        .await
        .unwrap();
    let p1: Value = res.json().await.unwrap();
    assert_eq!(p1["position"], 1.0);

    let res = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": "/var" }))
        .send()
        .await
        .unwrap();
    let p2: Value = res.json().await.unwrap();
    assert_eq!(p2["position"], 2.0);
}

#[tokio::test]
async fn test_add_project_invalid_path() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({
            "path": "/nonexistent_path_xyz_12345"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_list_after_add() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    // Add two projects
    client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": "/tmp" }))
        .send()
        .await
        .unwrap();
    client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": "/var" }))
        .send()
        .await
        .unwrap();

    let res = client
        .get(format!("{}/api/projects", base))
        .send()
        .await
        .unwrap();
    let body: Vec<Value> = res.json().await.unwrap();
    assert_eq!(body.len(), 2);
}

#[tokio::test]
async fn test_projects_sorted_by_position() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    // Add two projects
    let res = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": "/tmp" }))
        .send()
        .await
        .unwrap();
    let p1: Value = res.json().await.unwrap();
    let p1_id = p1["id"].as_str().unwrap();

    client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": "/var" }))
        .send()
        .await
        .unwrap();

    // Move first project to position 10
    client
        .patch(format!("{}/api/projects/{}", base, p1_id))
        .json(&serde_json::json!({ "position": 10.0 }))
        .send()
        .await
        .unwrap();

    // List should now show /var first (pos 2.0) then /tmp (pos 10.0)
    let res = client
        .get(format!("{}/api/projects", base))
        .send()
        .await
        .unwrap();
    let body: Vec<Value> = res.json().await.unwrap();
    assert_eq!(body[0]["name"], "var");
    assert_eq!(body[1]["name"], "tmp");
}

#[tokio::test]
async fn test_update_project_position() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": "/tmp" }))
        .send()
        .await
        .unwrap();
    let project: Value = res.json().await.unwrap();
    let id = project["id"].as_str().unwrap();

    let res = client
        .patch(format!("{}/api/projects/{}", base, id))
        .json(&serde_json::json!({ "position": 5.5 }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body: Value = res.json().await.unwrap();
    assert_eq!(body["position"], 5.5);
    assert_eq!(body["name"], "tmp");
}

#[tokio::test]
async fn test_update_project_name() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": "/tmp" }))
        .send()
        .await
        .unwrap();
    let project: Value = res.json().await.unwrap();
    let id = project["id"].as_str().unwrap();

    let res = client
        .patch(format!("{}/api/projects/{}", base, id))
        .json(&serde_json::json!({ "name": "My Project" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body: Value = res.json().await.unwrap();
    assert_eq!(body["name"], "My Project");
}

#[tokio::test]
async fn test_update_nonexistent_project() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .patch(format!("{}/api/projects/nonexistent-id", base))
        .json(&serde_json::json!({ "position": 1.0 }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_delete_project() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    // Add project
    let res = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": "/tmp" }))
        .send()
        .await
        .unwrap();
    let project: Value = res.json().await.unwrap();
    let id = project["id"].as_str().unwrap();

    // Delete it
    let res = client
        .delete(format!("{}/api/projects/{}", base, id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    // Verify it's gone
    let res = client
        .get(format!("{}/api/projects", base))
        .send()
        .await
        .unwrap();
    let body: Vec<Value> = res.json().await.unwrap();
    assert!(body.is_empty());
}

#[tokio::test]
async fn test_delete_nonexistent() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .delete(format!("{}/api/projects/nonexistent-id", base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_sse_snapshot_includes_projects() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    // Add a project
    client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": "/tmp" }))
        .send()
        .await
        .unwrap();

    // Connect to SSE with a timeout (SSE is streaming)
    let mut res = client
        .get(format!("{}/api/events", base))
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .unwrap();

    // Read chunks until we have the snapshot
    let mut collected = Vec::new();
    while let Ok(Ok(Some(chunk))) =
        tokio::time::timeout(std::time::Duration::from_millis(500), res.chunk()).await
    {
        collected.extend_from_slice(&chunk);
        let text = String::from_utf8_lossy(&collected);
        if text.contains("data:") {
            break;
        }
    }

    let text = String::from_utf8(collected).unwrap();
    let data_line = text
        .lines()
        .find(|l| l.starts_with("data:"))
        .expect("no data line in SSE");
    let data_str = data_line.strip_prefix("data:").unwrap().trim();
    let parsed: Value = serde_json::from_str(data_str).unwrap();

    assert!(parsed["data"]["projects"].is_array());
    assert_eq!(parsed["data"]["projects"].as_array().unwrap().len(), 1);
    assert_eq!(parsed["data"]["projects"][0]["name"], "tmp");
}
