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

fn run_git_env(repo_path: &Path, args: &[&str], env: &[(&str, &str)]) {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo_path)
        .arg("-c")
        .arg("commit.gpgsign=false")
        .args(args);
    for (key, value) in env {
        cmd.env(key, value);
    }
    let status = cmd.status().unwrap();
    assert!(status.success(), "git failed: {:?}", args);
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

async fn create_project(client: &reqwest::Client, base: &str, path: &str) -> String {
    let res = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({ "path": path }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let body: Value = res.json().await.unwrap();
    body["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn test_list_start_points_returns_local_and_remote() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    // Add remote refs without requiring a real remote.
    run_git(
        repo.path(),
        &["update-ref", "refs/remotes/origin/main", "HEAD"],
    );
    run_git(
        repo.path(),
        &["update-ref", "refs/remotes/upstream/main", "HEAD"],
    );
    run_git(
        repo.path(),
        &["update-ref", "refs/remotes/origin/HEAD", "HEAD"],
    );

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let res = client
        .get(format!(
            "{}/api/projects/{}/worktrees/start-points",
            base, project_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value = res.json().await.unwrap();

    assert_eq!(body["default_start_point"], "main");
    assert!(body["git_error"].is_null());

    let start_points = body["start_points"].as_array().unwrap();
    assert_eq!(start_points.len(), 1);
    let grouped = &start_points[0];
    assert_eq!(grouped["value"], "main");
    assert_eq!(grouped["local_ref"], "main");
    assert!(grouped["sha"].as_str().is_some_and(|sha| !sha.is_empty()));

    let remote_refs = grouped["remote_refs"].as_array().unwrap();
    assert_eq!(remote_refs.len(), 2);
    assert_eq!(remote_refs[0], "origin/main");
    assert_eq!(remote_refs[1], "upstream/main");
}

#[tokio::test]
async fn test_list_start_points_sorted_by_recent_commit() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    run_git(repo.path(), &["branch", "stale"]);
    std::fs::write(repo.path().join("README.md"), "hello\nnewer\n").unwrap();
    run_git(repo.path(), &["add", "README.md"]);
    run_git_env(
        repo.path(),
        &["commit", "-q", "-m", "newer commit"],
        &[
            ("GIT_AUTHOR_DATE", "2099-01-01T00:00:00Z"),
            ("GIT_COMMITTER_DATE", "2099-01-01T00:00:00Z"),
        ],
    );

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let res = client
        .get(format!(
            "{}/api/projects/{}/worktrees/start-points",
            base, project_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value = res.json().await.unwrap();

    let start_points = body["start_points"].as_array().unwrap();
    assert_eq!(start_points.len(), 2);
    assert_eq!(start_points[0]["value"], "main");
    assert_eq!(start_points[1]["value"], "stale");
}

#[tokio::test]
async fn test_create_worktree_with_start_point_succeeds() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();
    run_git(repo.path(), &["branch", "release"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let res = client
        .post(format!("{}/api/projects/{}/worktrees", base, project_id))
        .json(&serde_json::json!({
            "branch": "feature-from-release",
            "start_point": "release"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);

    let body: Value = res.json().await.unwrap();
    assert_eq!(body["branch"], "feature-from-release");
}

#[tokio::test]
async fn test_create_worktree_with_invalid_start_point_conflicts() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let res = client
        .post(format!("{}/api/projects/{}/worktrees", base, project_id))
        .json(&serde_json::json!({
            "branch": "feature-invalid-start",
            "start_point": "does/not/exist"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn test_list_start_points_returns_git_error_on_failure() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    std::fs::remove_dir_all(repo.path()).unwrap();

    let res = client
        .get(format!(
            "{}/api/projects/{}/worktrees/start-points",
            base, project_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["start_points"], serde_json::json!([]));
    assert!(body["git_error"].is_string());
}
