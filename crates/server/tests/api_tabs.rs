use hubris_server::{AppState, build_router};
use reqwest::StatusCode;
use serde_json::Value;

/// Spin up a test server on a random port and return the
/// base URL.
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

/// Create a project and return its id.
async fn create_project(client: &reqwest::Client, base: &str) -> String {
    let res = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": "/tmp" }))
        .send()
        .await
        .unwrap();
    let body: Value = res.json().await.unwrap();
    body["id"].as_str().unwrap().to_string()
}

/// Create a tab for a project and return the response body.
async fn create_tab(client: &reqwest::Client, base: &str, project_id: &str) -> Value {
    let res = client
        .post(format!("{}/api/tabs", base))
        .json(&serde_json::json!({ "project_id": project_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    res.json().await.unwrap()
}

#[tokio::test]
async fn test_list_tabs_empty() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .get(format!("{}/api/tabs", base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body: Vec<Value> = res.json().await.unwrap();
    assert!(body.is_empty());
}

#[tokio::test]
async fn test_create_tab() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let project_id = create_project(&client, &base).await;
    let tab = create_tab(&client, &base, &project_id).await;

    assert!(tab["id"].is_string());
    assert_eq!(tab["session_id"], "default");
    assert_eq!(tab["project_id"], project_id);
    assert_eq!(tab["label"], "Terminal 1");
    assert_eq!(tab["type"], "terminal");
    assert!(tab["position"].is_f64());
    assert!(tab["created_at"].is_u64());
}

#[tokio::test]
async fn test_create_tab_invalid_project() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .post(format!("{}/api/tabs", base))
        .json(&serde_json::json!({
            "project_id": "nonexistent"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_list_after_create() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let project_id = create_project(&client, &base).await;
    create_tab(&client, &base, &project_id).await;
    create_tab(&client, &base, &project_id).await;

    let res = client
        .get(format!("{}/api/tabs", base))
        .send()
        .await
        .unwrap();
    let body: Vec<Value> = res.json().await.unwrap();
    assert_eq!(body.len(), 2);
}

#[tokio::test]
async fn test_delete_tab() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let project_id = create_project(&client, &base).await;
    let tab = create_tab(&client, &base, &project_id).await;
    let tab_id = tab["id"].as_str().unwrap();

    let res = client
        .delete(format!("{}/api/tabs/{}", base, tab_id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    // Verify it's gone
    let res = client
        .get(format!("{}/api/tabs", base))
        .send()
        .await
        .unwrap();
    let body: Vec<Value> = res.json().await.unwrap();
    assert!(body.is_empty());
}

#[tokio::test]
async fn test_delete_nonexistent_tab() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .delete(format!("{}/api/tabs/nonexistent-id", base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_tab_labels_increment() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let project_id = create_project(&client, &base).await;
    let tab1 = create_tab(&client, &base, &project_id).await;
    let tab2 = create_tab(&client, &base, &project_id).await;

    assert_eq!(tab1["label"], "Terminal 1");
    assert_eq!(tab2["label"], "Terminal 2");
}

#[tokio::test]
async fn test_tabs_sorted_by_position() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let project_id = create_project(&client, &base).await;
    create_tab(&client, &base, &project_id).await;
    create_tab(&client, &base, &project_id).await;
    create_tab(&client, &base, &project_id).await;

    let res = client
        .get(format!("{}/api/tabs", base))
        .send()
        .await
        .unwrap();
    let body: Vec<Value> = res.json().await.unwrap();

    let positions: Vec<f64> = body
        .iter()
        .map(|t| t["position"].as_f64().unwrap())
        .collect();
    for w in positions.windows(2) {
        assert!(w[0] <= w[1], "tabs not sorted by position");
    }
}

#[tokio::test]
async fn test_update_tab_position() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let project_id = create_project(&client, &base).await;
    let tab1 = create_tab(&client, &base, &project_id).await;
    let tab2 = create_tab(&client, &base, &project_id).await;
    let tab2_id = tab2["id"].as_str().unwrap();

    // Move tab2 before tab1
    let res = client
        .patch(format!("{}/api/tabs/{}", base, tab2_id))
        .json(&serde_json::json!({ "position": 0.5 }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let updated: Value = res.json().await.unwrap();
    assert_eq!(updated["position"], 0.5);

    // Verify list order changed
    let res = client
        .get(format!("{}/api/tabs", base))
        .send()
        .await
        .unwrap();
    let body: Vec<Value> = res.json().await.unwrap();
    assert_eq!(body[0]["id"], tab2["id"]);
    assert_eq!(body[1]["id"], tab1["id"]);
}

#[tokio::test]
async fn test_update_tab_label() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let project_id = create_project(&client, &base).await;
    let tab = create_tab(&client, &base, &project_id).await;
    let tab_id = tab["id"].as_str().unwrap();

    let res = client
        .patch(format!("{}/api/tabs/{}", base, tab_id))
        .json(&serde_json::json!({ "label": "My Shell" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let updated: Value = res.json().await.unwrap();
    assert_eq!(updated["label"], "My Shell");

    // Verify via list
    let res = client
        .get(format!("{}/api/tabs", base))
        .send()
        .await
        .unwrap();
    let body: Vec<Value> = res.json().await.unwrap();
    assert_eq!(body[0]["label"], "My Shell");
}

#[tokio::test]
async fn test_delete_project_cascades_tabs() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let project_id = create_project(&client, &base).await;
    create_tab(&client, &base, &project_id).await;
    create_tab(&client, &base, &project_id).await;

    // Verify 2 tabs exist
    let res = client
        .get(format!("{}/api/tabs", base))
        .send()
        .await
        .unwrap();
    let body: Vec<Value> = res.json().await.unwrap();
    assert_eq!(body.len(), 2);

    // Delete the project
    client
        .delete(format!("{}/api/projects/{}", base, project_id))
        .send()
        .await
        .unwrap();

    // Tabs should be gone
    let res = client
        .get(format!("{}/api/tabs", base))
        .send()
        .await
        .unwrap();
    let body: Vec<Value> = res.json().await.unwrap();
    assert!(body.is_empty());
}
