use hubris_server::{build_router, AppState};
use reqwest::StatusCode;
use serde_json::Value;

async fn start_test_server() -> (String, tempfile::TempDir) {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = AppState::new(tmp.path().to_path_buf());
    let app = build_router(state);

    let listener =
        tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (format!("http://{}", addr), tmp)
}

/// Create a project and return its id.
async fn create_project(
    client: &reqwest::Client,
    base: &str,
) -> String {
    let res = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": "/tmp" }))
        .send()
        .await
        .unwrap();
    let body: Value = res.json().await.unwrap();
    body["id"].as_str().unwrap().to_string()
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

    let res = client
        .post(format!("{}/api/tabs", base))
        .json(
            &serde_json::json!({ "project_id": project_id }),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);

    let body: Value = res.json().await.unwrap();
    assert!(body["id"].is_string());
    assert_eq!(body["session_id"], "default");
    assert_eq!(body["project_id"], project_id);
    assert_eq!(body["label"], "Terminal 1");
    assert_eq!(body["type"], "terminal");
    assert!(body["created_at"].is_u64());
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

    client
        .post(format!("{}/api/tabs", base))
        .json(
            &serde_json::json!({ "project_id": project_id }),
        )
        .send()
        .await
        .unwrap();
    client
        .post(format!("{}/api/tabs", base))
        .json(
            &serde_json::json!({ "project_id": project_id }),
        )
        .send()
        .await
        .unwrap();

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

    let res = client
        .post(format!("{}/api/tabs", base))
        .json(
            &serde_json::json!({ "project_id": project_id }),
        )
        .send()
        .await
        .unwrap();
    let tab: Value = res.json().await.unwrap();
    let tab_id = tab["id"].as_str().unwrap();

    let res = client
        .delete(format!("{}/api/tabs/{}", base, tab_id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

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
        .delete(format!("{}/api/tabs/fake-id", base))
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

    let mut labels = Vec::new();
    for _ in 0..3 {
        let res = client
            .post(format!("{}/api/tabs", base))
            .json(&serde_json::json!({
                "project_id": project_id
            }))
            .send()
            .await
            .unwrap();
        let body: Value = res.json().await.unwrap();
        labels.push(
            body["label"].as_str().unwrap().to_string(),
        );
    }

    assert_eq!(labels[0], "Terminal 1");
    assert_eq!(labels[1], "Terminal 2");
    assert_eq!(labels[2], "Terminal 3");
}

#[tokio::test]
async fn test_list_tabs_sorted_by_created_at() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let project_id =
        create_project(&client, &base).await;

    // Create 3 tabs sequentially
    for _ in 0..3 {
        client
            .post(format!("{}/api/tabs", base))
            .json(&serde_json::json!({
                "project_id": project_id
            }))
            .send()
            .await
            .unwrap();
    }

    // List should return them sorted by created_at
    let res = client
        .get(format!("{}/api/tabs", base))
        .send()
        .await
        .unwrap();
    let body: Vec<Value> = res.json().await.unwrap();
    assert_eq!(body.len(), 3);

    let timestamps: Vec<u64> = body
        .iter()
        .map(|t| t["created_at"].as_u64().unwrap())
        .collect();
    assert!(
        timestamps.windows(2).all(|w| w[0] <= w[1]),
        "tabs should be sorted by created_at: {:?}",
        timestamps
    );

    // Labels should also be in order
    assert_eq!(body[0]["label"], "Terminal 1");
    assert_eq!(body[1]["label"], "Terminal 2");
    assert_eq!(body[2]["label"], "Terminal 3");
}
