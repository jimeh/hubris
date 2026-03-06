use std::path::Path;
use std::process::Command;

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

fn init_git_repo() -> tempfile::TempDir {
    let repo = tempfile::TempDir::new().unwrap();
    run_git(repo.path(), &["init", "-q"]);
    run_git(repo.path(), &["config", "user.email", "test@example.com"]);
    run_git(repo.path(), &["config", "user.name", "Hubris Test"]);
    std::fs::write(repo.path().join("README.md"), "hello\n").unwrap();
    run_git(repo.path(), &["add", "README.md"]);
    run_git(repo.path(), &["commit", "-q", "-m", "init"]);
    run_git(repo.path(), &["branch", "-M", "main"]);
    repo
}

fn run_git(repo_path: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .arg("-c")
        .arg("commit.gpgsign=false")
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git failed: {:?}", args);
}

async fn create_project(client: &reqwest::Client, base: &str, path: &str) -> String {
    let res = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": path }))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success());
    let body: Value = res.json().await.unwrap();
    body["id"].as_str().unwrap().to_string()
}

async fn first_worktree_id(client: &reqwest::Client, base: &str, project_id: &str) -> String {
    let res = client
        .get(format!("{}/api/projects/{}/worktrees", base, project_id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value = res.json().await.unwrap();
    body["worktrees"][0]["id"].as_str().unwrap().to_string()
}

async fn create_tab(client: &reqwest::Client, base: &str, worktree_id: &str) -> Value {
    let res = client
        .post(format!("{}/api/tabs", base))
        .json(&serde_json::json!({ "worktree_id": worktree_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    res.json().await.unwrap()
}

async fn list_tabs(client: &reqwest::Client, base: &str) -> Vec<Value> {
    let res = client
        .get(format!("{}/api/tabs", base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
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
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;
    let tab = create_tab(&client, &base, &worktree_id).await;

    assert!(tab["id"].is_string());
    assert_eq!(tab["session_id"], "default");
    assert_eq!(tab["worktree_id"], worktree_id);
    assert_eq!(tab["label"], "Terminal 1");
    assert_eq!(tab["type"], "terminal");
    assert!(tab["position"].is_f64());
    assert!(tab["created_at"].is_u64());
}

#[tokio::test]
async fn test_create_tab_invalid_worktree() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .post(format!("{}/api/tabs", base))
        .json(&serde_json::json!({
            "worktree_id": "nonexistent"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_create_tab_for_external_non_managed_worktree_returns_not_found() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();
    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    assert!(!project_id.is_empty());

    let external = tempfile::TempDir::new().unwrap();
    let external_path = external.path().join("outside-worktree");
    let external_path_str = external_path.to_string_lossy().to_string();
    run_git(
        repo.path(),
        &[
            "worktree",
            "add",
            "-b",
            "outside-branch",
            &external_path_str,
        ],
    );
    let external_id = hubris_server::git::worktree_id(&external_path);

    let res = client
        .post(format!("{}/api/tabs", base))
        .json(&serde_json::json!({ "worktree_id": external_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_delete_project_cascades_tabs() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;

    create_tab(&client, &base, &worktree_id).await;
    create_tab(&client, &base, &worktree_id).await;

    let res = client
        .get(format!("{}/api/tabs", base))
        .send()
        .await
        .unwrap();
    let body: Vec<Value> = res.json().await.unwrap();
    assert_eq!(body.len(), 2);

    let res = client
        .delete(format!("{}/api/projects/{}", base, project_id))
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
async fn test_delete_tab() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;
    let tab = create_tab(&client, &base, &worktree_id).await;
    let tab_id = tab["id"].as_str().unwrap();

    let res = client
        .delete(format!("{}/api/tabs/{}", base, tab_id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    let body = list_tabs(&client, &base).await;
    assert!(body.is_empty());

    let res = client
        .delete(format!("{}/api/tabs/{}", base, tab_id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_update_tab() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;
    let tab = create_tab(&client, &base, &worktree_id).await;
    let tab_id = tab["id"].as_str().unwrap();

    let res = client
        .patch(format!("{}/api/tabs/{}", base, tab_id))
        .json(&serde_json::json!({
            "label": "Renamed tab",
            "position": 42.5
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let updated: Value = res.json().await.unwrap();
    assert_eq!(updated["id"], tab_id);
    assert_eq!(updated["label"], "Renamed tab");
    assert_eq!(updated["position"], 42.5);

    let body = list_tabs(&client, &base).await;
    assert_eq!(body.len(), 1);
    assert_eq!(body[0]["id"], tab_id);
    assert_eq!(body[0]["label"], "Renamed tab");
    assert_eq!(body[0]["position"], 42.5);
}

#[tokio::test]
async fn test_list_tabs_sorted_by_position() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;
    let first = create_tab(&client, &base, &worktree_id).await;
    let second = create_tab(&client, &base, &worktree_id).await;
    let first_id = first["id"].as_str().unwrap();
    let second_id = second["id"].as_str().unwrap();

    let res = client
        .patch(format!("{}/api/tabs/{}", base, second_id))
        .json(&serde_json::json!({ "position": 0.5 }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = list_tabs(&client, &base).await;
    assert_eq!(body.len(), 2);
    assert_eq!(body[0]["id"], second_id);
    assert_eq!(body[1]["id"], first_id);
}

#[tokio::test]
async fn test_reorder_tabs() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;

    let t1 = create_tab(&client, &base, &worktree_id).await;
    let t2 = create_tab(&client, &base, &worktree_id).await;
    let t3 = create_tab(&client, &base, &worktree_id).await;
    let id1 = t1["id"].as_str().unwrap();
    let id2 = t2["id"].as_str().unwrap();
    let id3 = t3["id"].as_str().unwrap();

    // Reorder: 3, 1, 2
    let res = client
        .put(format!("{}/api/tabs/reorder", base))
        .json(&serde_json::json!({
            "worktree_id": worktree_id,
            "tab_ids": [id3, id1, id2]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Vec<Value> = res.json().await.unwrap();
    assert_eq!(body.len(), 3);
    assert_eq!(body[0]["id"], id3);
    assert_eq!(body[1]["id"], id1);
    assert_eq!(body[2]["id"], id2);

    // Verify list returns same order
    let body = list_tabs(&client, &base).await;
    assert_eq!(body[0]["id"], id3);
    assert_eq!(body[1]["id"], id1);
    assert_eq!(body[2]["id"], id2);
}

#[tokio::test]
async fn test_reorder_tabs_wrong_ids() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;

    create_tab(&client, &base, &worktree_id).await;
    create_tab(&client, &base, &worktree_id).await;

    // Missing one tab
    let res = client
        .put(format!("{}/api/tabs/reorder", base))
        .json(&serde_json::json!({
            "worktree_id": worktree_id,
            "tab_ids": ["nonexistent"]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // Includes unknown ID
    let res = client
        .put(format!("{}/api/tabs/reorder", base))
        .json(&serde_json::json!({
            "worktree_id": worktree_id,
            "tab_ids": ["nonexistent", "also-nonexistent"]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_create_tab_label_increments() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;

    let first = create_tab(&client, &base, &worktree_id).await;
    let second = create_tab(&client, &base, &worktree_id).await;

    assert_eq!(first["label"], "Terminal 1");
    assert_eq!(second["label"], "Terminal 2");
}
