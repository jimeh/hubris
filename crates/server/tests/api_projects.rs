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

async fn create_project(client: &reqwest::Client, base: &str, path: &str) -> Value {
    let res = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": path }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    res.json().await.unwrap()
}

async fn create_worktree(
    client: &reqwest::Client,
    base: &str,
    project_id: &str,
    branch: &str,
) -> Value {
    let res = client
        .post(format!("{}/api/projects/{}/worktrees", base, project_id))
        .json(&serde_json::json!({ "branch": branch }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    res.json().await.unwrap()
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
async fn test_add_project_valid_git_repo() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let res = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": repo.path().to_string_lossy() }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);

    let body: Value = res.json().await.unwrap();
    let canonical = tokio::fs::canonicalize(repo.path()).await.unwrap();
    assert_eq!(body["path"], canonical.to_string_lossy().to_string());
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
async fn test_add_project_deduplicates() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let res1 = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": repo.path().to_string_lossy() }))
        .send()
        .await
        .unwrap();
    assert_eq!(res1.status(), StatusCode::CREATED);
    let p1: Value = res1.json().await.unwrap();

    let res2 = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": repo.path().to_string_lossy() }))
        .send()
        .await
        .unwrap();
    assert_eq!(res2.status(), StatusCode::OK);
    let p2: Value = res2.json().await.unwrap();

    assert_eq!(p1["id"], p2["id"]);

    let res = client
        .get(format!("{}/api/projects", base))
        .send()
        .await
        .unwrap();
    let body: Vec<Value> = res.json().await.unwrap();
    assert_eq!(body.len(), 1);
}

#[tokio::test]
async fn test_reorder_projects() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let repo1 = init_git_repo();
    let repo2 = init_git_repo();

    let res = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": repo1.path().to_string_lossy() }))
        .send()
        .await
        .unwrap();
    let p1: Value = res.json().await.unwrap();
    let p1_id = p1["id"].as_str().unwrap();

    let res = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": repo2.path().to_string_lossy() }))
        .send()
        .await
        .unwrap();
    let p2: Value = res.json().await.unwrap();
    let p2_id = p2["id"].as_str().unwrap();

    let res = client
        .put(format!("{}/api/projects/reorder", base))
        .json(&serde_json::json!({
            "project_ids": [p2_id, p1_id]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body: Vec<Value> = res.json().await.unwrap();
    assert_eq!(body[0]["id"], p2_id);
    assert_eq!(body[1]["id"], p1_id);
}

#[tokio::test]
async fn test_delete_project() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let res = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": repo.path().to_string_lossy() }))
        .send()
        .await
        .unwrap();
    let project: Value = res.json().await.unwrap();
    let id = project["id"].as_str().unwrap();

    let res = client
        .delete(format!("{}/api/projects/{}", base, id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    let res = client
        .get(format!("{}/api/projects", base))
        .send()
        .await
        .unwrap();
    let body: Vec<Value> = res.json().await.unwrap();
    assert!(body.is_empty());
}

#[tokio::test]
async fn test_sse_snapshot_includes_worktrees() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": repo.path().to_string_lossy() }))
        .send()
        .await
        .unwrap();

    let mut res = client
        .get(format!("{}/api/events", base))
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .unwrap();

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
    assert!(parsed["data"]["worktrees"].is_object());
}

#[tokio::test]
async fn test_update_project_name() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let id = project["id"].as_str().unwrap();

    let res = client
        .patch(format!("{}/api/projects/{}", base, id))
        .json(&serde_json::json!({ "name": "Renamed Project" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let updated: Value = res.json().await.unwrap();
    assert_eq!(updated["id"], id);
    assert_eq!(updated["name"], "Renamed Project");

    let res = client
        .get(format!("{}/api/projects", base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Vec<Value> = res.json().await.unwrap();
    assert_eq!(body.len(), 1);
    assert_eq!(body[0]["id"], id);
    assert_eq!(body[0]["name"], "Renamed Project");
}

#[tokio::test]
async fn test_delete_nonexistent_project() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .delete(format!("{}/api/projects/nonexistent-project-id", base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_reorder_projects_invalid_ids() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo1 = init_git_repo();
    let repo2 = init_git_repo();

    let p1 = create_project(&client, &base, repo1.path().to_str().unwrap()).await;
    create_project(&client, &base, repo2.path().to_str().unwrap()).await;
    let p1_id = p1["id"].as_str().unwrap();

    let res = client
        .put(format!("{}/api/projects/reorder", base))
        .json(&serde_json::json!({
            "project_ids": [p1_id, "not-a-real-id"]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_delete_project_succeeds_when_managed_worktree_missing_on_disk() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let id = project["id"].as_str().unwrap();

    let created = create_worktree(&client, &base, id, "feature-missing").await;
    let worktree_path = created["path"].as_str().unwrap();
    std::fs::remove_dir_all(worktree_path).unwrap();

    let res = client
        .delete(format!("{}/api/projects/{}", base, id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

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
async fn test_delete_project_respects_force_for_existing_dirty_worktree() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let id = project["id"].as_str().unwrap();

    let created = create_worktree(&client, &base, id, "feature-dirty").await;
    let worktree_path = created["path"].as_str().unwrap();
    std::fs::write(
        std::path::Path::new(worktree_path).join("dirty.txt"),
        "uncommitted\n",
    )
    .unwrap();

    let res = client
        .delete(format!("{}/api/projects/{}", base, id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);

    let res = client
        .delete(format!("{}/api/projects/{}?force=true", base, id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
}
