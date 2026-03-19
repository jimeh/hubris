use std::path::Path;
use std::process::Command;
use std::time::Duration;

use hubris_server::events::EventKind;
use hubris_server::{AppState, build_router};
use reqwest::StatusCode;
use serde_json::Value;

async fn start_test_server() -> (String, tempfile::TempDir) {
    let (base, tmp, _state) = start_test_server_with_state().await;
    (base, tmp)
}

async fn start_test_server_with_state() -> (String, tempfile::TempDir, AppState) {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = AppState::new(tmp.path().to_path_buf()).await;
    let app = build_router(state.clone());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (format!("http://{}", addr), tmp, state)
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

async fn local_worktree_id(client: &reqwest::Client, base: &str, project_id: &str) -> String {
    let res = client
        .get(format!("{}/api/projects/{}/worktrees", base, project_id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value = res.json().await.unwrap();
    body["worktrees"][0]["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn test_list_files_default_path() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .get(format!("{}/api/files", base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body: Value = res.json().await.unwrap();
    assert!(body["path"].is_string());
    assert!(body["entries"].is_array());
    assert!(body["home_dir"].is_string());
}

#[tokio::test]
async fn test_list_files_explicit_path() {
    let (base, tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    // Create subdirectories
    std::fs::create_dir(tmp.path().join("mydir")).unwrap();
    let git_dir = tmp.path().join("myrepo");
    std::fs::create_dir(&git_dir).unwrap();
    std::fs::create_dir(git_dir.join(".git")).unwrap();
    // Hidden dir (should be excluded by default)
    std::fs::create_dir(tmp.path().join(".hidden")).unwrap();
    // Regular file (should be excluded)
    std::fs::write(tmp.path().join("file.txt"), "hi").unwrap();

    let res = client
        .get(format!("{}/api/files?path={}", base, tmp.path().display()))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body: Value = res.json().await.unwrap();
    let entries = body["entries"].as_array().unwrap();

    // Should have mydir and myrepo only
    assert_eq!(entries.len(), 2);

    let names: Vec<&str> = entries
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"mydir"));
    assert!(names.contains(&"myrepo"));

    // myrepo should be detected as git repo
    let myrepo = entries.iter().find(|e| e["name"] == "myrepo").unwrap();
    assert_eq!(myrepo["is_git_repo"], true);

    let mydir = entries.iter().find(|e| e["name"] == "mydir").unwrap();
    assert_eq!(mydir["is_git_repo"], false);
}

#[tokio::test]
async fn test_list_files_show_hidden() {
    let (base, tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    std::fs::create_dir(tmp.path().join(".hidden")).unwrap();
    std::fs::create_dir(tmp.path().join("visible")).unwrap();

    let res = client
        .get(format!(
            "{}/api/files?path={}&show_hidden=true",
            base,
            tmp.path().display()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body: Value = res.json().await.unwrap();
    let entries = body["entries"].as_array().unwrap();
    let names: Vec<&str> = entries
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&".hidden"));
    assert!(names.contains(&"visible"));
}

#[tokio::test]
async fn test_list_files_nonexistent_path() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .get(format!("{}/api/files?path=/nonexistent_xyz_12345", base,))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_list_files_path_is_file() {
    let (base, tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let file_path = tmp.path().join("notadir.txt");
    std::fs::write(&file_path, "content").unwrap();

    let res = client
        .get(format!("{}/api/files?path={}", base, file_path.display()))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_list_files_sorted_alphabetically() {
    let (base, tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    std::fs::create_dir(tmp.path().join("Zebra")).unwrap();
    std::fs::create_dir(tmp.path().join("alpha")).unwrap();
    std::fs::create_dir(tmp.path().join("Beta")).unwrap();

    let res = client
        .get(format!("{}/api/files?path={}", base, tmp.path().display()))
        .send()
        .await
        .unwrap();
    let body: Value = res.json().await.unwrap();
    let names: Vec<&str> = body["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["alpha", "Beta", "Zebra"]);
}

#[tokio::test]
async fn test_list_worktree_files_lists_root_and_nested_entries() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::create_dir_all(repo.path().join("src/nested")).unwrap();
    std::fs::write(repo.path().join("src/lib.rs"), "pub fn demo() {}\n").unwrap();
    std::fs::write(repo.path().join(".env"), "A=1\n").unwrap();
    std::fs::create_dir(repo.path().join(".git-hidden")).unwrap();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let root = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/files",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(root.status(), StatusCode::OK);
    let root_body: Value = root.json().await.unwrap();
    let root_entries = root_body["entries"].as_array().unwrap();
    let root_names: Vec<&str> = root_entries
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert!(root_names.contains(&".env"));
    assert!(root_names.contains(&".git-hidden"));
    assert!(root_names.contains(&"src"));
    assert!(!root_names.contains(&".git"));

    let nested = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/files?path=src",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(nested.status(), StatusCode::OK);
    let nested_body: Value = nested.json().await.unwrap();
    assert_eq!(nested_body["path"], "src");
    assert!(
        nested_body["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"] == "src/lib.rs" && entry["kind"] == "file")
    );
    assert!(
        nested_body["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"] == "src/nested" && entry["kind"] == "directory")
    );
}

#[tokio::test]
async fn test_rename_worktree_file_succeeds_for_file_and_directory() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join("old-name.txt"), "rename me\n").unwrap();
    std::fs::create_dir(repo.path().join("old-dir")).unwrap();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let file_res = client
        .post(format!(
            "{}/api/projects/{}/worktrees/{}/files/rename",
            base, project_id, worktree_id
        ))
        .json(&serde_json::json!({
            "path": "old-name.txt",
            "new_name": "new-name.txt"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(file_res.status(), StatusCode::OK);
    let file_body: Value = file_res.json().await.unwrap();
    assert_eq!(file_body["path"], "new-name.txt");
    assert!(repo.path().join("new-name.txt").exists());

    let dir_res = client
        .post(format!(
            "{}/api/projects/{}/worktrees/{}/files/rename",
            base, project_id, worktree_id
        ))
        .json(&serde_json::json!({
            "path": "old-dir",
            "new_name": "new-dir"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(dir_res.status(), StatusCode::OK);
    let dir_body: Value = dir_res.json().await.unwrap();
    assert_eq!(dir_body["path"], "new-dir");
    assert!(repo.path().join("new-dir").is_dir());
}

#[tokio::test]
async fn test_rename_worktree_file_rejects_invalid_requests() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join("file.txt"), "rename me\n").unwrap();
    std::fs::write(repo.path().join("taken.txt"), "exists\n").unwrap();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let invalid_path = client
        .post(format!(
            "{}/api/projects/{}/worktrees/{}/files/rename",
            base, project_id, worktree_id
        ))
        .json(&serde_json::json!({
            "path": "../file.txt",
            "new_name": "renamed.txt"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid_path.status(), StatusCode::BAD_REQUEST);

    let invalid_name = client
        .post(format!(
            "{}/api/projects/{}/worktrees/{}/files/rename",
            base, project_id, worktree_id
        ))
        .json(&serde_json::json!({
            "path": "file.txt",
            "new_name": "nested/name.txt"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid_name.status(), StatusCode::BAD_REQUEST);

    let empty_name = client
        .post(format!(
            "{}/api/projects/{}/worktrees/{}/files/rename",
            base, project_id, worktree_id
        ))
        .json(&serde_json::json!({
            "path": "file.txt",
            "new_name": ""
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(empty_name.status(), StatusCode::BAD_REQUEST);

    let conflict = client
        .post(format!(
            "{}/api/projects/{}/worktrees/{}/files/rename",
            base, project_id, worktree_id
        ))
        .json(&serde_json::json!({
            "path": "file.txt",
            "new_name": "taken.txt"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn test_worktree_file_watcher_emits_update_event() {
    let (base, _tmp, state) = start_test_server_with_state().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let list_res = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/files",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(list_res.status(), StatusCode::OK);

    let mut rx = state.events.subscribe();
    std::fs::write(repo.path().join("watch-me.txt"), "hello\n").unwrap();

    let event = tokio::time::timeout(Duration::from_secs(3), async move {
        loop {
            let event = rx.recv().await.unwrap();
            if let EventKind::WorktreeFilesUpdated {
                project_id: event_project_id,
                worktree_id: event_worktree_id,
                generation,
                paths,
            } = &event.kind
                && event_project_id == &project_id
                && event_worktree_id == &worktree_id
            {
                return (*generation, paths.clone());
            }
        }
    })
    .await
    .unwrap();

    assert!(event.0 >= 2);
    assert_eq!(event.1, vec!["".to_string(), "watch-me.txt".to_string()]);
}

#[tokio::test]
async fn test_worktree_file_watcher_reports_nested_parent_paths() {
    let (base, _tmp, state) = start_test_server_with_state().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::create_dir_all(repo.path().join("src/nested")).unwrap();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let list_res = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/files?path=src",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(list_res.status(), StatusCode::OK);

    let mut rx = state.events.subscribe();
    std::fs::write(repo.path().join("src/nested/watch-me.txt"), "hello\n").unwrap();

    let event = tokio::time::timeout(Duration::from_secs(3), async move {
        loop {
            let event = rx.recv().await.unwrap();
            if let EventKind::WorktreeFilesUpdated {
                project_id: event_project_id,
                worktree_id: event_worktree_id,
                generation,
                paths,
            } = &event.kind
                && event_project_id == &project_id
                && event_worktree_id == &worktree_id
            {
                return (*generation, paths.clone());
            }
        }
    })
    .await
    .unwrap();

    assert!(event.0 >= 2);
    assert_eq!(
        event.1,
        vec![
            "src/nested".to_string(),
            "src/nested/watch-me.txt".to_string(),
        ]
    );
}
