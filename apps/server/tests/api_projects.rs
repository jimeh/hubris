use std::path::Path;
use std::process::Command;

use hubris_server::{AppState, build_router};
use reqwest::StatusCode;
use serde_json::Value;

async fn start_test_server() -> (String, tempfile::TempDir) {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = AppState::new(tmp.path().to_path_buf()).await;
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

async fn list_worktrees(client: &reqwest::Client, base: &str, project_id: &str) -> Value {
    let res = client
        .get(format!("{}/api/projects/{}/worktrees", base, project_id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    res.json().await.unwrap()
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
async fn test_add_project_rejects_file_path() {
    let (base, tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let file_path = tmp.path().join("not-a-directory");
    std::fs::write(&file_path, "hello\n").unwrap();

    let res = client
        .post(format!("{}/api/projects", base))
        .json(&serde_json::json!({
            "path": file_path.to_string_lossy()
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
async fn test_worktree_ui_mode_defaults_to_hubris_and_persists_patch() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let project_id = project["id"].as_str().unwrap();

    let listed = list_worktrees(&client, &base, project_id).await;
    let local = &listed["worktrees"][0];
    assert_eq!(local["ui_mode"], "hubris");

    let res = client
        .patch(format!(
            "{}/api/projects/{}/worktrees/{}",
            base,
            project_id,
            local["id"].as_str().unwrap()
        ))
        .json(&serde_json::json!({ "ui_mode": "vscode" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let updated: Value = res.json().await.unwrap();
    assert_eq!(updated["ui_mode"], "vscode");

    let listed = list_worktrees(&client, &base, project_id).await;
    assert_eq!(listed["worktrees"][0]["ui_mode"], "vscode");
}

#[tokio::test]
async fn test_worktree_ui_mode_normalization_prunes_stale_entries() {
    let (base, tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let project_id = project["id"].as_str().unwrap();

    let listed = list_worktrees(&client, &base, project_id).await;
    let local_id = listed["worktrees"][0]["id"].as_str().unwrap();

    let managed = create_worktree(&client, &base, project_id, "feature-prune-ui-mode").await;
    let managed_id = managed["id"].as_str().unwrap();

    let response = client
        .patch(format!(
            "{}/api/projects/{}/worktrees/{}",
            base, project_id, managed_id
        ))
        .json(&serde_json::json!({ "ui_mode": "vscode" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let meta_path = tmp
        .path()
        .join("project-meta")
        .join(format!("{project_id}.json"));
    std::fs::write(
        &meta_path,
        serde_json::to_string_pretty(&serde_json::json!({
            "managed_worktrees": [{
                "id": managed_id,
                "path": managed["path"],
                "branch": managed["branch"],
                "name": managed["name"],
                "source_ref": managed["source_ref"],
            }],
            "worktree_order": [managed_id],
            "worktree_ui_modes": {
                local_id: "hubris",
                managed_id: "vscode",
                "stale-worktree": "vscode",
            },
        }))
        .unwrap(),
    )
    .unwrap();

    let response = client
        .patch(format!(
            "{}/api/projects/{}/worktrees/{}",
            base, project_id, local_id
        ))
        .json(&serde_json::json!({ "ui_mode": "hubris" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let meta: Value = serde_json::from_str(&std::fs::read_to_string(&meta_path).unwrap()).unwrap();
    let ui_modes = meta["worktree_ui_modes"].as_object().unwrap();
    assert_eq!(
        ui_modes.get(local_id),
        Some(&Value::String("hubris".into()))
    );
    assert_eq!(
        ui_modes.get(managed_id),
        Some(&Value::String("vscode".into()))
    );
    assert!(!ui_modes.contains_key("stale-worktree"));

    let listed = list_worktrees(&client, &base, project_id).await;
    let worktrees = listed["worktrees"].as_array().unwrap();
    let local = worktrees
        .iter()
        .find(|worktree| worktree["id"] == local_id)
        .unwrap();
    let managed = worktrees
        .iter()
        .find(|worktree| worktree["id"] == managed_id)
        .unwrap();
    assert_eq!(local["ui_mode"], "hubris");
    assert_eq!(managed["ui_mode"], "vscode");
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
async fn test_delete_project_keeps_project_when_save_fails() {
    let (base, tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let id = project["id"].as_str().unwrap();

    // Replace projects.json with a directory so the atomic
    // persist (temp file + rename) fails at the rename step.
    let projects_file = tmp.path().join("projects.json");
    let original_contents = std::fs::read_to_string(&projects_file).unwrap();
    std::fs::remove_file(&projects_file).unwrap();
    std::fs::create_dir(&projects_file).unwrap();

    let res = client
        .delete(format!("{}/api/projects/{}", base, id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);

    std::fs::remove_dir(&projects_file).unwrap();
    std::fs::write(&projects_file, original_contents).unwrap();

    let res = client
        .get(format!("{}/api/projects", base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body: Vec<Value> = res.json().await.unwrap();
    assert_eq!(body.len(), 1);
    assert_eq!(body[0]["id"], id);
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
async fn test_add_project_emits_initial_worktrees_update() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let mut res = client
        .get(format!("{}/api/events", base))
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .unwrap();
    let mut buffer = Vec::new();

    let (event_name, snapshot) = next_sse_event(&mut res, &mut buffer).await;
    assert_eq!(event_name, "snapshot");
    assert_eq!(snapshot["type"], "snapshot");

    let created = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let project_id = created["id"].as_str().unwrap();

    let (event_name, project_added) = next_sse_event(&mut res, &mut buffer).await;
    assert_eq!(event_name, "project_added");
    assert_eq!(project_added["type"], "project_added");
    assert_eq!(project_added["data"]["id"], project_id);

    let (event_name, worktrees_updated) = next_sse_event(&mut res, &mut buffer).await;
    assert_eq!(event_name, "project_worktrees_updated");
    assert_eq!(worktrees_updated["type"], "project_worktrees_updated");
    assert_eq!(worktrees_updated["data"]["project_id"], project_id);
    assert!(worktrees_updated["data"]["git_error"].is_null());

    let worktrees = worktrees_updated["data"]["worktrees"].as_array().unwrap();
    assert_eq!(worktrees.len(), 1);
    assert_eq!(worktrees[0]["project_id"], project_id);
    assert_eq!(worktrees[0]["is_local"], true);
    assert_eq!(worktrees[0]["name"], "local");
    assert_eq!(worktrees[0]["missing_on_disk"], false);
    assert_eq!(worktrees[0]["position"].as_f64(), Some(1.0));
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
async fn test_delete_project_remove_only_leaves_managed_worktree_on_disk() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let id = project["id"].as_str().unwrap();

    let created = create_worktree(&client, &base, id, "feature-keep").await;
    let worktree_path = created["path"].as_str().unwrap();

    let res = client
        .delete(format!("{}/api/projects/{}", base, id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert!(std::path::Path::new(worktree_path).exists());
}

#[tokio::test]
async fn test_delete_project_delete_managed_removes_only_managed_worktrees() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let id = project["id"].as_str().unwrap();

    let managed = create_worktree(&client, &base, id, "feature-managed").await;
    let managed_path = managed["path"].as_str().unwrap().to_string();

    let external_path = repo.path().join("external-linked");
    run_git(
        repo.path(),
        &[
            "worktree",
            "add",
            "-b",
            "feature-external",
            external_path.to_str().unwrap(),
        ],
    );

    let res = client
        .delete(format!(
            "{}/api/projects/{}?delete_managed_worktrees=true",
            base, id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert!(!std::path::Path::new(&managed_path).exists());
    assert!(external_path.exists());
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
        .delete(format!(
            "{}/api/projects/{}?delete_managed_worktrees=true",
            base, id
        ))
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
async fn test_delete_project_remove_only_ignores_dirty_managed_worktrees() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let id = project["id"].as_str().unwrap();

    let created = create_worktree(&client, &base, id, "feature-dirty-keep").await;
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
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert!(std::path::Path::new(worktree_path).exists());
}

#[tokio::test]
async fn test_delete_project_respects_force_for_existing_dirty_managed_worktree() {
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
        .delete(format!(
            "{}/api/projects/{}?delete_managed_worktrees=true",
            base, id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);

    let res = client
        .delete(format!(
            "{}/api/projects/{}?delete_managed_worktrees=true&force=true",
            base, id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
}
