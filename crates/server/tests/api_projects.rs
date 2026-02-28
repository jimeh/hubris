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
