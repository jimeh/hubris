use std::path::Path;
use std::process::Command;
use std::time::Duration;

use hubris_server::api::worktrees::resolve_worktree;
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

async fn first_worktree_id(client: &reqwest::Client, base: &str, project_id: &str) -> String {
    list_worktrees(client, base, project_id).await["worktrees"][0]["id"]
        .as_str()
        .unwrap()
        .to_string()
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

fn run_git_output(repo_path: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .arg("-c")
        .arg("commit.gpgsign=false")
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "git failed: {:?}", args);
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

fn run_git_status(repo_path: &Path, args: &[&str]) -> std::process::ExitStatus {
    Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .arg("-c")
        .arg("commit.gpgsign=false")
        .args(args)
        .status()
        .unwrap()
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
async fn test_resolve_worktree_falls_back_after_cached_project_is_deleted() {
    let data_dir = tempfile::TempDir::new().unwrap();
    let state = AppState::new(data_dir.path().to_path_buf()).await;
    let deleted_repo = init_git_repo();
    let actual_repo = init_git_repo();
    let deleted_project = state
        .projects
        .add(
            deleted_repo.path().to_string_lossy().into_owned(),
            "deleted".to_string(),
        )
        .await
        .unwrap()
        .project;
    let actual_project = state
        .projects
        .add(
            actual_repo.path().to_string_lossy().into_owned(),
            "actual".to_string(),
        )
        .await
        .unwrap()
        .project;
    let worktree_id = hubris_server::git::worktree_id(actual_repo.path());
    state.remember_worktree_project(&worktree_id, &deleted_project.id);
    assert!(state.projects.remove(&deleted_project.id).await.unwrap());

    let resolved = resolve_worktree(&state, &worktree_id)
        .await
        .unwrap()
        .unwrap();
    let cached_project_id = state.project_id_for_worktree(&worktree_id);

    assert_eq!(
        (resolved.project_id.as_str(), cached_project_id.as_deref()),
        (actual_project.id.as_str(), Some(actual_project.id.as_str()),)
    );
}

#[tokio::test]
async fn test_resolve_worktree_falls_back_when_cached_project_lacks_worktree() {
    let data_dir = tempfile::TempDir::new().unwrap();
    let state = AppState::new(data_dir.path().to_path_buf()).await;
    let stale_repo = init_git_repo();
    let actual_repo = init_git_repo();
    let stale_project = state
        .projects
        .add(
            stale_repo.path().to_string_lossy().into_owned(),
            "stale".to_string(),
        )
        .await
        .unwrap()
        .project;
    let actual_project = state
        .projects
        .add(
            actual_repo.path().to_string_lossy().into_owned(),
            "actual".to_string(),
        )
        .await
        .unwrap()
        .project;
    let worktree_id = hubris_server::git::worktree_id(actual_repo.path());
    // Point the cache at a project that exists but does not contain
    // this worktree: the guarded-eviction branch, distinct from the
    // deleted-project branch covered above.
    state.remember_worktree_project(&worktree_id, &stale_project.id);

    let resolved = resolve_worktree(&state, &worktree_id)
        .await
        .unwrap()
        .unwrap();
    let cached_project_id = state.project_id_for_worktree(&worktree_id);

    assert_eq!(
        (resolved.project_id.as_str(), cached_project_id.as_deref()),
        (actual_project.id.as_str(), Some(actual_project.id.as_str()),)
    );
}

#[tokio::test]
async fn test_put_worktree_restore_state_rejects_project_worktree_mismatch() {
    let (base, _tmp, state) = start_test_server_with_state().await;
    let client = reqwest::Client::new();
    let repo_a = init_git_repo();
    let repo_b = init_git_repo();

    let project_a = create_project(&client, &base, repo_a.path().to_str().unwrap()).await;
    let project_b = create_project(&client, &base, repo_b.path().to_str().unwrap()).await;
    let worktree_a = first_worktree_id(&client, &base, &project_a).await;

    let res = client
        .put(format!(
            "{}/api/projects/{}/worktrees/{}/restore-state",
            base, project_b, worktree_a
        ))
        .json(&serde_json::json!({
            "activeTabId": "tab-1",
            "focusedPaneId": "pane-1",
            "paneMru": ["pane-1"],
            "tabMruByPane": { "pane-1": ["tab-1"] }
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        state.project_id_for_worktree(&worktree_a).as_deref(),
        Some(project_a.as_str()),
    );
    assert!(!state.restore_state_by_worktree.contains_key(&worktree_a));
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

async fn create_worktree(
    client: &reqwest::Client,
    base: &str,
    project_id: &str,
    branch: &str,
) -> Value {
    create_worktree_with_payload(
        client,
        base,
        project_id,
        serde_json::json!({ "branch": branch }),
    )
    .await
}

async fn create_worktree_with_payload(
    client: &reqwest::Client,
    base: &str,
    project_id: &str,
    payload: serde_json::Value,
) -> Value {
    let res = client
        .post(format!("{}/api/projects/{}/worktrees", base, project_id))
        .json(&payload)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    res.json().await.unwrap()
}

async fn get_worktree_git_status(
    client: &reqwest::Client,
    base: &str,
    project_id: &str,
    worktree_id: &str,
) -> Value {
    let res = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git-status",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    res.json().await.unwrap()
}

async fn get_worktree_commit_details(
    client: &reqwest::Client,
    base: &str,
    project_id: &str,
    worktree_id: &str,
    commit_id: &str,
) -> reqwest::Response {
    client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/commits/{}",
            base, project_id, worktree_id, commit_id
        ))
        .send()
        .await
        .unwrap()
}

async fn post_worktree_git_action(
    client: &reqwest::Client,
    base: &str,
    project_id: &str,
    worktree_id: &str,
    action: &str,
    path: &str,
) -> StatusCode {
    post_worktree_git_action_with_original_path(
        client,
        base,
        project_id,
        worktree_id,
        action,
        path,
        None,
    )
    .await
}

async fn post_worktree_git_action_with_original_path(
    client: &reqwest::Client,
    base: &str,
    project_id: &str,
    worktree_id: &str,
    action: &str,
    path: &str,
    original_path: Option<&str>,
) -> StatusCode {
    let mut payload = serde_json::json!({ "path": path });
    if let Some(original_path) = original_path {
        payload["originalPath"] = Value::String(original_path.to_string());
    }

    client
        .post(format!(
            "{}/api/projects/{}/worktrees/{}/git/{}",
            base, project_id, worktree_id, action
        ))
        .json(&payload)
        .send()
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn test_list_worktrees_contains_only_local_by_default() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let body = list_worktrees(&client, &base, &project_id).await;
    let worktrees = body["worktrees"].as_array().unwrap();
    assert_eq!(worktrees.len(), 1);
    assert_eq!(worktrees[0]["name"], "local");
    assert_eq!(worktrees[0]["isLocal"], true);
    assert_eq!(worktrees[0]["missingOnDisk"], false);
}

#[tokio::test]
async fn test_list_worktrees_ignores_non_hubris_external_worktrees() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

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

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let body = list_worktrees(&client, &base, &project_id).await;
    let worktrees = body["worktrees"].as_array().unwrap();
    assert_eq!(worktrees.len(), 1);
    assert_eq!(worktrees[0]["isLocal"], true);
}

#[tokio::test]
async fn test_list_worktrees_marks_missing_managed_worktree() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let created = create_worktree(&client, &base, &project_id, "feature-missing").await;
    let worktree_path = created["path"].as_str().unwrap();
    std::fs::remove_dir_all(worktree_path).unwrap();

    let body = list_worktrees(&client, &base, &project_id).await;
    let worktrees = body["worktrees"].as_array().unwrap();
    assert_eq!(worktrees.len(), 2);
    let managed = worktrees.iter().find(|wt| wt["isLocal"] == false).unwrap();
    assert_eq!(managed["missingOnDisk"], true);
}

#[tokio::test]
async fn test_delete_missing_managed_worktree_removes_metadata() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let created = create_worktree(&client, &base, &project_id, "feature-delete-missing").await;
    let worktree_id = created["id"].as_str().unwrap();
    let worktree_path = created["path"].as_str().unwrap();
    std::fs::remove_dir_all(worktree_path).unwrap();

    let res = client
        .delete(format!(
            "{}/api/projects/{}/worktrees/{}",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    let body = list_worktrees(&client, &base, &project_id).await;
    let worktrees = body["worktrees"].as_array().unwrap();
    assert_eq!(worktrees.len(), 1);
    assert_eq!(worktrees[0]["isLocal"], true);
}

#[tokio::test]
async fn test_delete_existing_managed_worktree_removes_from_git_and_api() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let created = create_worktree(&client, &base, &project_id, "feature-delete-existing").await;
    let worktree_id = created["id"].as_str().unwrap();
    let worktree_path = created["path"].as_str().unwrap();
    assert!(std::path::Path::new(worktree_path).exists());

    let res = client
        .delete(format!(
            "{}/api/projects/{}/worktrees/{}",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    assert!(!std::path::Path::new(worktree_path).exists());

    let body = list_worktrees(&client, &base, &project_id).await;
    let worktrees = body["worktrees"].as_array().unwrap();
    assert_eq!(worktrees.len(), 1);
    assert_eq!(worktrees[0]["isLocal"], true);
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

    assert_eq!(body["defaultStartPoint"], "main");
    assert!(body["gitError"].is_null());

    let start_points = body["startPoints"].as_array().unwrap();
    assert_eq!(start_points.len(), 1);
    let grouped = &start_points[0];
    assert_eq!(grouped["value"], "main");
    assert_eq!(grouped["localRef"], "main");
    assert!(grouped["sha"].as_str().is_some_and(|sha| !sha.is_empty()));

    let remote_refs = grouped["remoteRefs"].as_array().unwrap();
    assert_eq!(remote_refs.len(), 2);
    assert_eq!(remote_refs[0], "origin/main");
    assert_eq!(remote_refs[1], "upstream/main");
}

#[tokio::test]
async fn test_list_start_points_preserves_lossy_non_utf8_ref_names() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();
    let head_oid = run_git_output(repo.path(), &["rev-parse", "HEAD"]);
    let weird_ref = b"refs/heads/weird-\xff-branch";
    let packed_refs = repo.path().join(".git/packed-refs");

    std::fs::write(
        &packed_refs,
        [
            &b"# pack-refs with: peeled fully-peeled sorted\n"[..],
            head_oid.as_bytes(),
            b" ",
            weird_ref,
            b"\n",
        ]
        .concat(),
    )
    .unwrap();
    std::fs::write(
        repo.path().join(".git/HEAD"),
        [&b"ref: "[..], &weird_ref[..], &b"\n"[..]].concat(),
    )
    .unwrap();

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

    assert_eq!(body["defaultStartPoint"], "weird-\u{fffd}-branch");
    let start_points = body["startPoints"].as_array().unwrap();
    assert!(start_points.iter().any(|start_point| {
        start_point["value"] == "weird-\u{fffd}-branch"
            && start_point["localRef"] == "weird-\u{fffd}-branch"
    }));
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

    let start_points = body["startPoints"].as_array().unwrap();
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
            "startPoint": "release"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);

    let body: Value = res.json().await.unwrap();
    assert_eq!(body["branch"], "feature-from-release");
}

#[tokio::test]
async fn test_create_worktree_with_slash_branch_succeeds() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let body = create_worktree(&client, &base, &project_id, "feature/foo").await;

    assert_eq!(body["branch"], "feature/foo");
    assert!(Path::new(body["path"].as_str().unwrap()).exists());
}

#[tokio::test]
async fn test_create_worktree_persists_source_ref() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let body = create_worktree_with_payload(
        &client,
        &base,
        &project_id,
        serde_json::json!({
            "branch": "feature-source-ref",
            "startPoint": "main",
            "sourceRef": "origin/main"
        }),
    )
    .await;

    assert_eq!(body["sourceRef"], "origin/main");

    let listed = list_worktrees(&client, &base, &project_id).await;
    let worktrees = listed["worktrees"].as_array().unwrap();
    let created = worktrees
        .iter()
        .find(|worktree| worktree["branch"] == "feature-source-ref")
        .unwrap();
    assert_eq!(created["sourceRef"], "origin/main");
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
            "startPoint": "does/not/exist"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn test_list_worktrees_reads_legacy_meta_without_source_ref() {
    let (base, tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let legacy_path = tmp
        .path()
        .join("project-meta")
        .join(format!("{project_id}.json"));
    std::fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
    std::fs::write(
        &legacy_path,
        serde_json::json!({
            "worktree_order": ["legacy-id"],
            "managed_worktrees": [{
                "id": "legacy-id",
                "path": "/tmp/legacy-worktree",
                "branch": "legacy-branch",
                "name": "legacy-branch"
            }]
        })
        .to_string(),
    )
    .unwrap();

    let body = list_worktrees(&client, &base, &project_id).await;
    let worktrees = body["worktrees"].as_array().unwrap();
    let legacy = worktrees
        .iter()
        .find(|worktree| worktree["id"] == "legacy-id");

    assert!(legacy.is_some());
    assert!(legacy.unwrap()["sourceRef"].is_null());
}

#[tokio::test]
async fn test_worktree_git_status_reports_staged_unstaged_and_ahead() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let created = create_worktree_with_payload(
        &client,
        &base,
        &project_id,
        serde_json::json!({
            "branch": "feature-status",
            "startPoint": "main",
            "sourceRef": "main"
        }),
    )
    .await;
    let worktree_path = created["path"].as_str().unwrap();

    std::fs::write(Path::new(worktree_path).join("ahead.txt"), "ahead commit\n").unwrap();
    run_git(Path::new(worktree_path), &["add", "ahead.txt"]);
    run_git(
        Path::new(worktree_path),
        &["commit", "-q", "-m", "feat: ahead"],
    );

    std::fs::write(
        Path::new(worktree_path).join("staged.txt"),
        "staged change\n",
    )
    .unwrap();
    run_git(Path::new(worktree_path), &["add", "staged.txt"]);

    std::fs::write(
        Path::new(worktree_path).join("README.md"),
        "hello\nunstaged\n",
    )
    .unwrap();

    let res = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git-status",
            base,
            project_id,
            created["id"].as_str().unwrap()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value = res.json().await.unwrap();
    let expected_short_id =
        run_git_output(Path::new(worktree_path), &["rev-parse", "--short", "HEAD"]);

    assert_eq!(body["sourceRef"], "main");
    assert_eq!(body["aheadCount"], 1);
    assert_eq!(body["comparisonAvailable"], true);
    assert!(body["comparisonError"].is_null());
    assert_eq!(body["aheadCommits"][0]["summary"], "feat: ahead");
    assert_eq!(body["aheadCommits"][0]["shortId"], expected_short_id);
    assert_eq!(body["stagedFiles"][0]["path"], "staged.txt");
    assert_eq!(body["stagedFiles"][0]["changeType"], "added");
    assert_eq!(body["unstagedFiles"][0]["path"], "README.md");
    assert_eq!(body["unstagedFiles"][0]["changeType"], "modified");
}

#[tokio::test]
async fn test_worktree_git_status_reports_staged_files_in_mixed_nested_tree() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let local_worktree_id = list_worktrees(&client, &base, &project_id).await["worktrees"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    for path in [
        "tmp2/bar/baz/baz copy/baz/baz copy/baz.txt",
        "tmp2/bar/baz/baz copy/baz/baz copy/fox.txt",
        "tmp2/bar/baz/baz copy/fox.txt",
    ] {
        let full_path = repo.path().join(path);
        std::fs::create_dir_all(full_path.parent().unwrap()).unwrap();
        std::fs::write(&full_path, "").unwrap();
    }
    run_git(
        repo.path(),
        &[
            "add",
            "--",
            "tmp2/bar/baz/baz copy/baz/baz copy/baz.txt",
            "tmp2/bar/baz/baz copy/baz/baz copy/fox.txt",
            "tmp2/bar/baz/baz copy/fox.txt",
        ],
    );

    for path in [
        "tmp2/bar.txt",
        "tmp2/bar/bar.txt",
        "tmp2/bar/baz/baz copy/baz.txt",
        "tmp2/bar/baz/baz copy/baz/baz.txt",
        "tmp2/bar/baz/baz copy/baz/fox.txt",
        "tmp2/bar/baz/baz.txt",
        "tmp2/bar/baz/fox.txt",
        "tmp2/foo.txt",
    ] {
        let full_path = repo.path().join(path);
        std::fs::create_dir_all(full_path.parent().unwrap()).unwrap();
        std::fs::write(full_path, "").unwrap();
    }
    std::fs::write(repo.path().join("README.md"), "hello\nunstaged\n").unwrap();

    let status = get_worktree_git_status(&client, &base, &project_id, &local_worktree_id).await;
    let staged_files = status["stagedFiles"].as_array().unwrap();
    let unstaged_files = status["unstagedFiles"].as_array().unwrap();

    assert!(
        !staged_files.is_empty(),
        "expected staged files in mixed nested tree, got status: {status:#}"
    );
    assert!(
        !unstaged_files.is_empty(),
        "expected unstaged files in mixed nested tree, got status: {status:#}"
    );
    assert!(staged_files.iter().any(|file| {
        file["path"] == "tmp2/bar/baz/baz copy/baz/baz copy/baz.txt"
            && file["changeType"] == "added"
    }));
    assert!(
        unstaged_files
            .iter()
            .any(|file| file["path"] == "tmp2/bar/baz/baz.txt")
    );
}

#[tokio::test]
async fn test_worktree_git_status_reports_staged_files_with_tmp_ignore_prefix() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join(".gitignore"), "/tmp/\n").unwrap();
    run_git(repo.path(), &["add", ".gitignore"]);
    run_git(repo.path(), &["commit", "-q", "-m", "add tmp ignore"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let local_worktree_id = list_worktrees(&client, &base, &project_id).await["worktrees"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    for path in [
        "tmp2/bar/baz/baz copy/baz/baz copy/baz.txt",
        "tmp2/bar/baz/baz copy/baz/baz copy/fox.txt",
        "tmp2/bar/baz/baz copy/fox.txt",
    ] {
        let full_path = repo.path().join(path);
        std::fs::create_dir_all(full_path.parent().unwrap()).unwrap();
        std::fs::write(&full_path, "").unwrap();
    }
    run_git(
        repo.path(),
        &[
            "add",
            "--",
            "tmp2/bar/baz/baz copy/baz/baz copy/baz.txt",
            "tmp2/bar/baz/baz copy/baz/baz copy/fox.txt",
            "tmp2/bar/baz/baz copy/fox.txt",
        ],
    );

    for path in [
        "tmp2/bar.txt",
        "tmp2/bar/bar.txt",
        "tmp2/bar/baz/baz copy/baz.txt",
        "tmp2/bar/baz/baz copy/baz/baz.txt",
        "tmp2/bar/baz/baz copy/baz/fox.txt",
        "tmp2/bar/baz/baz.txt",
        "tmp2/bar/baz/fox.txt",
        "tmp2/foo.txt",
    ] {
        let full_path = repo.path().join(path);
        std::fs::create_dir_all(full_path.parent().unwrap()).unwrap();
        std::fs::write(full_path, "").unwrap();
    }
    std::fs::write(repo.path().join("README.md"), "hello\nunstaged\n").unwrap();

    let status = get_worktree_git_status(&client, &base, &project_id, &local_worktree_id).await;
    let staged_files = status["stagedFiles"].as_array().unwrap();
    let unstaged_files = status["unstagedFiles"].as_array().unwrap();

    assert!(
        !staged_files.is_empty(),
        "expected staged files with /tmp/ ignore prefix, got status: {status:#}"
    );
    assert!(
        !unstaged_files.is_empty(),
        "expected unstaged files with /tmp/ ignore prefix, got status: {status:#}"
    );
    assert!(staged_files.iter().any(|file| {
        file["path"] == "tmp2/bar/baz/baz copy/baz/baz copy/baz.txt"
            && file["changeType"] == "added"
    }));
}

#[tokio::test]
async fn test_worktree_commit_details_returns_metadata_and_changed_files() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join("details.txt"), "hello\n").unwrap();
    run_git(repo.path(), &["add", "details.txt"]);
    run_git_env(
        repo.path(),
        &[
            "commit",
            "-q",
            "-m",
            "feat: details",
            "-m",
            "body line one\nbody line two",
        ],
        &[
            ("GIT_AUTHOR_NAME", "Author Example"),
            ("GIT_AUTHOR_EMAIL", "author@example.com"),
            ("GIT_COMMITTER_NAME", "Committer Example"),
            ("GIT_COMMITTER_EMAIL", "committer@example.com"),
        ],
    );

    let commit_id = String::from_utf8(
        Command::new("git")
            .arg("-C")
            .arg(repo.path())
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktrees = list_worktrees(&client, &base, &project_id).await;
    let local = worktrees["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|worktree| worktree["isLocal"] == true)
        .unwrap();

    let res = get_worktree_commit_details(
        &client,
        &base,
        &project_id,
        local["id"].as_str().unwrap(),
        &commit_id,
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);

    let body: Value = res.json().await.unwrap();
    let expected_short_id = run_git_output(repo.path(), &["rev-parse", "--short", &commit_id]);
    assert_eq!(body["id"], commit_id);
    assert_eq!(body["shortId"], expected_short_id);
    assert_eq!(body["summary"], "feat: details");
    assert!(body["message"].as_str().unwrap().contains("body line one"));
    assert_eq!(body["author"]["name"], "Author Example");
    assert_eq!(body["author"]["email"], "author@example.com");
    assert_eq!(body["committer"]["name"], "Committer Example");
    assert_eq!(body["committer"]["email"], "committer@example.com");
    assert_eq!(body["files"][0]["path"], "details.txt");
    assert_eq!(body["files"][0]["changeType"], "added");
}

#[tokio::test]
async fn test_worktree_commit_details_handles_root_commit_diff() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let root_commit_id = String::from_utf8(
        Command::new("git")
            .arg("-C")
            .arg(repo.path())
            .args(["rev-list", "--max-parents=0", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktrees = list_worktrees(&client, &base, &project_id).await;
    let local = worktrees["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|worktree| worktree["isLocal"] == true)
        .unwrap();

    let res = get_worktree_commit_details(
        &client,
        &base,
        &project_id,
        local["id"].as_str().unwrap(),
        &root_commit_id,
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);

    let body: Value = res.json().await.unwrap();
    let files = body["files"].as_array().unwrap();
    assert!(
        files
            .iter()
            .any(|file| file["path"] == "README.md" && file["changeType"] == "added")
    );
}

#[tokio::test]
async fn test_worktree_commit_details_uses_first_parent_for_merge_commits() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    run_git(repo.path(), &["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.path().join("feature.txt"), "feature\n").unwrap();
    run_git(repo.path(), &["add", "feature.txt"]);
    run_git(repo.path(), &["commit", "-q", "-m", "feat: branch change"]);

    run_git(repo.path(), &["checkout", "-q", "main"]);
    std::fs::write(repo.path().join("main.txt"), "main\n").unwrap();
    run_git(repo.path(), &["add", "main.txt"]);
    run_git(repo.path(), &["commit", "-q", "-m", "feat: main change"]);
    run_git(
        repo.path(),
        &["merge", "--no-ff", "-m", "merge feature", "feature"],
    );

    let merge_commit_id = String::from_utf8(
        Command::new("git")
            .arg("-C")
            .arg(repo.path())
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktrees = list_worktrees(&client, &base, &project_id).await;
    let local = worktrees["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|worktree| worktree["isLocal"] == true)
        .unwrap();

    let res = get_worktree_commit_details(
        &client,
        &base,
        &project_id,
        local["id"].as_str().unwrap(),
        &merge_commit_id,
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);

    let body: Value = res.json().await.unwrap();
    let files = body["files"].as_array().unwrap();
    assert!(
        files
            .iter()
            .any(|file| file["path"] == "feature.txt" && file["changeType"] == "added")
    );
    assert!(!files.iter().any(|file| file["path"] == "main.txt"));
}

#[tokio::test]
async fn test_worktree_commit_details_returns_404_for_unknown_commit() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktrees = list_worktrees(&client, &base, &project_id).await;
    let local = worktrees["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|worktree| worktree["isLocal"] == true)
        .unwrap();

    let res = get_worktree_commit_details(
        &client,
        &base,
        &project_id,
        local["id"].as_str().unwrap(),
        "deadbeef",
    )
    .await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_worktree_git_status_marks_missing_source_ref_as_unavailable() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let created = create_worktree(&client, &base, &project_id, "feature-no-source");

    let res = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git-status",
            base,
            project_id,
            created.await["id"].as_str().unwrap()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value = res.json().await.unwrap();

    assert_eq!(body["comparisonAvailable"], false);
    assert!(body["comparisonError"].is_null());
    assert!(body["aheadCommits"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn test_worktree_git_status_returns_comparison_error_for_bad_source_ref() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let created = create_worktree_with_payload(
        &client,
        &base,
        &project_id,
        serde_json::json!({
            "branch": "feature-bad-source",
            "sourceRef": "does/not/exist"
        }),
    )
    .await;
    let worktree_path = created["path"].as_str().unwrap();

    std::fs::write(
        Path::new(worktree_path).join("README.md"),
        "hello\nstill works\n",
    )
    .unwrap();

    let res = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git-status",
            base,
            project_id,
            created["id"].as_str().unwrap()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value = res.json().await.unwrap();

    assert_eq!(body["comparisonAvailable"], true);
    assert!(body["comparisonError"].is_string());
    assert_eq!(body["unstagedFiles"][0]["path"], "README.md");
}

#[tokio::test]
async fn test_worktree_git_status_reports_renamed_and_copied_files() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join("rename-source.txt"), "rename me\n").unwrap();
    std::fs::write(repo.path().join("copy-source.txt"), "copy me\n").unwrap();
    run_git(
        repo.path(),
        &["add", "rename-source.txt", "copy-source.txt"],
    );
    run_git(repo.path(), &["commit", "-q", "-m", "add source files"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let created = create_worktree_with_payload(
        &client,
        &base,
        &project_id,
        serde_json::json!({
            "branch": "feature-rewrites",
            "startPoint": "main",
            "sourceRef": "main"
        }),
    )
    .await;
    let worktree_path = Path::new(created["path"].as_str().unwrap());

    run_git(
        worktree_path,
        &["mv", "rename-source.txt", "rename-target.txt"],
    );
    std::fs::copy(
        worktree_path.join("copy-source.txt"),
        worktree_path.join("copied-target.txt"),
    )
    .unwrap();
    run_git(worktree_path, &["add", "copied-target.txt"]);

    let res = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git-status",
            base,
            project_id,
            created["id"].as_str().unwrap()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value = res.json().await.unwrap();
    let staged_files = body["stagedFiles"].as_array().unwrap();
    assert!(staged_files.iter().any(|file| {
        file["path"] == "copied-target.txt"
            && file["changeType"] == "copied"
            && file["originalPath"] == "copy-source.txt"
    }));
    assert!(staged_files.iter().any(|file| {
        file["path"] == "rename-target.txt"
            && file["changeType"] == "renamed"
            && file["originalPath"] == "rename-source.txt"
    }));
}

#[tokio::test]
async fn test_worktree_git_status_returns_500_for_missing_worktree_path() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let created = create_worktree_with_payload(
        &client,
        &base,
        &project_id,
        serde_json::json!({
            "branch": "feature-status-missing",
            "sourceRef": "main"
        }),
    )
    .await;

    std::fs::remove_dir_all(created["path"].as_str().unwrap()).unwrap();

    let res = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git-status",
            base,
            project_id,
            created["id"].as_str().unwrap()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn test_worktree_git_status_reports_conflicts() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let created = create_worktree_with_payload(
        &client,
        &base,
        &project_id,
        serde_json::json!({
            "branch": "feature-conflict",
            "startPoint": "main",
            "sourceRef": "main"
        }),
    )
    .await;
    let worktree_path = Path::new(created["path"].as_str().unwrap());

    std::fs::write(repo.path().join("README.md"), "hello\nmain change\n").unwrap();
    run_git(repo.path(), &["add", "README.md"]);
    run_git(repo.path(), &["commit", "-q", "-m", "main change"]);

    std::fs::write(worktree_path.join("README.md"), "hello\nfeature change\n").unwrap();
    run_git(worktree_path, &["add", "README.md"]);
    run_git(worktree_path, &["commit", "-q", "-m", "feature change"]);

    let status = run_git_status(worktree_path, &["merge", "main"]);
    assert!(!status.success());

    let res = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git-status",
            base,
            project_id,
            created["id"].as_str().unwrap()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value = res.json().await.unwrap();

    let unstaged_files = body["unstagedFiles"].as_array().unwrap();
    assert!(
        unstaged_files
            .iter()
            .any(|file| { file["path"] == "README.md" && file["changeType"] == "conflict" })
    );
}

#[tokio::test]
async fn test_worktree_git_stage_and_unstage_actions_refresh_cached_git_status() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let local_worktree_id = list_worktrees(&client, &base, &project_id).await["worktrees"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    std::fs::write(repo.path().join("README.md"), "hello\nstage me\n").unwrap();

    let initial_status =
        get_worktree_git_status(&client, &base, &project_id, &local_worktree_id).await;
    assert_eq!(initial_status["unstagedFiles"][0]["path"], "README.md");
    assert_eq!(initial_status["stagedFiles"], serde_json::json!([]));

    let stage_status = post_worktree_git_action(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "stage",
        "README.md",
    )
    .await;
    assert_eq!(stage_status, StatusCode::NO_CONTENT);

    let staged_status =
        get_worktree_git_status(&client, &base, &project_id, &local_worktree_id).await;
    assert_eq!(staged_status["unstagedFiles"], serde_json::json!([]));
    assert_eq!(staged_status["stagedFiles"][0]["path"], "README.md");
    assert_eq!(staged_status["stagedFiles"][0]["changeType"], "modified");

    let unstage_status = post_worktree_git_action(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "unstage",
        "README.md",
    )
    .await;
    assert_eq!(unstage_status, StatusCode::NO_CONTENT);

    let unstaged_status =
        get_worktree_git_status(&client, &base, &project_id, &local_worktree_id).await;
    assert_eq!(unstaged_status["stagedFiles"], serde_json::json!([]));
    assert_eq!(unstaged_status["unstagedFiles"][0]["path"], "README.md");
    assert_eq!(
        unstaged_status["unstagedFiles"][0]["changeType"],
        "modified"
    );
}

#[tokio::test]
async fn test_worktree_git_actions_treat_metachar_paths_literally() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let local_worktree_id = list_worktrees(&client, &base, &project_id).await["worktrees"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    std::fs::write(repo.path().join("foo[1].txt"), "literal target\n").unwrap();
    std::fs::write(repo.path().join("foo1.txt"), "sibling\n").unwrap();

    let stage_status = post_worktree_git_action(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "stage",
        "foo[1].txt",
    )
    .await;
    assert_eq!(stage_status, StatusCode::NO_CONTENT);

    let staged_status =
        get_worktree_git_status(&client, &base, &project_id, &local_worktree_id).await;
    let staged_files = staged_status["stagedFiles"].as_array().unwrap();
    assert_eq!(staged_files.len(), 1);
    assert_eq!(staged_files[0]["path"], "foo[1].txt");
    let unstaged_files = staged_status["unstagedFiles"].as_array().unwrap();
    assert_eq!(unstaged_files.len(), 1);
    assert_eq!(unstaged_files[0]["path"], "foo1.txt");

    let unstage_status = post_worktree_git_action(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "unstage",
        "foo[1].txt",
    )
    .await;
    assert_eq!(unstage_status, StatusCode::NO_CONTENT);

    let unstaged_status =
        get_worktree_git_status(&client, &base, &project_id, &local_worktree_id).await;
    assert_eq!(unstaged_status["stagedFiles"], serde_json::json!([]));
    let unstaged_files = unstaged_status["unstagedFiles"].as_array().unwrap();
    assert!(
        unstaged_files
            .iter()
            .any(|file| file["path"] == "foo[1].txt")
    );
    assert!(unstaged_files.iter().any(|file| file["path"] == "foo1.txt"));

    let discard_status = post_worktree_git_action(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "discard",
        "foo[1].txt",
    )
    .await;
    assert_eq!(discard_status, StatusCode::NO_CONTENT);

    assert!(!repo.path().join("foo[1].txt").exists());
    assert!(repo.path().join("foo1.txt").exists());

    let final_status =
        get_worktree_git_status(&client, &base, &project_id, &local_worktree_id).await;
    assert_eq!(final_status["stagedFiles"], serde_json::json!([]));
    let final_unstaged = final_status["unstagedFiles"].as_array().unwrap();
    assert_eq!(final_unstaged.len(), 1);
    assert_eq!(final_unstaged[0]["path"], "foo1.txt");
}

#[tokio::test]
async fn test_worktree_git_actions_accept_directory_paths() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::create_dir_all(repo.path().join("src/nested")).unwrap();
    std::fs::write(repo.path().join("src/lib.rs"), "pub fn a() {}\n").unwrap();
    std::fs::write(repo.path().join("src/nested/mod.rs"), "pub fn b() {}\n").unwrap();
    run_git(repo.path(), &["add", "src/lib.rs", "src/nested/mod.rs"]);
    run_git(repo.path(), &["commit", "-q", "-m", "add src tree"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let local_worktree_id = list_worktrees(&client, &base, &project_id).await["worktrees"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    std::fs::write(
        repo.path().join("src/lib.rs"),
        "pub fn a() { println!(\"a\"); }\n",
    )
    .unwrap();
    std::fs::write(
        repo.path().join("src/nested/mod.rs"),
        "pub fn b() { println!(\"b\"); }\n",
    )
    .unwrap();

    let stage_status = post_worktree_git_action(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "stage",
        "src",
    )
    .await;
    assert_eq!(stage_status, StatusCode::NO_CONTENT);

    let staged_status =
        get_worktree_git_status(&client, &base, &project_id, &local_worktree_id).await;
    let staged_files = staged_status["stagedFiles"].as_array().unwrap();
    assert!(staged_files.iter().any(|file| file["path"] == "src/lib.rs"));
    assert!(
        staged_files
            .iter()
            .any(|file| file["path"] == "src/nested/mod.rs")
    );

    let unstage_status = post_worktree_git_action(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "unstage",
        "src",
    )
    .await;
    assert_eq!(unstage_status, StatusCode::NO_CONTENT);

    let unstaged_status =
        get_worktree_git_status(&client, &base, &project_id, &local_worktree_id).await;
    let unstaged_files = unstaged_status["unstagedFiles"].as_array().unwrap();
    assert!(
        unstaged_files
            .iter()
            .any(|file| file["path"] == "src/lib.rs")
    );
    assert!(
        unstaged_files
            .iter()
            .any(|file| file["path"] == "src/nested/mod.rs")
    );
}

#[tokio::test]
async fn test_worktree_git_stage_and_unstage_actions_accept_original_path_for_rewrites() {
    let (base, _tmp, state) = start_test_server_with_state().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::create_dir_all(repo.path().join("old")).unwrap();
    std::fs::create_dir_all(repo.path().join("new")).unwrap();
    std::fs::write(repo.path().join("old/source.txt"), "rename me\n").unwrap();
    run_git(repo.path(), &["add", "old/source.txt"]);
    run_git(repo.path(), &["commit", "-q", "-m", "add rename source"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let local_worktree_id = list_worktrees(&client, &base, &project_id).await["worktrees"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    std::fs::rename(
        repo.path().join("old/source.txt"),
        repo.path().join("new/target.txt"),
    )
    .unwrap();

    let mut rx = state.events.subscribe();
    let expected_project_id = project_id.clone();
    let expected_worktree_id = local_worktree_id.clone();
    let stage_status = post_worktree_git_action_with_original_path(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "stage",
        "new/target.txt",
        Some("old/source.txt"),
    )
    .await;
    assert_eq!(stage_status, StatusCode::NO_CONTENT);

    let event = tokio::time::timeout(Duration::from_secs(3), async move {
        loop {
            let event = rx.recv().await.unwrap();
            if let EventKind::WorktreeFilesUpdated {
                project_id: observed_project_id,
                worktree_id: observed_worktree_id,
                changed_paths,
                listing_paths,
                ..
            } = &event.kind
                && observed_project_id == &expected_project_id
                && observed_worktree_id == &expected_worktree_id
            {
                return (changed_paths.clone(), listing_paths.clone());
            }
        }
    })
    .await
    .unwrap();

    assert!(event.0.contains(&"old/source.txt".to_string()));
    assert!(event.0.contains(&"new/target.txt".to_string()));
    assert!(event.0.contains(&"old".to_string()));
    assert!(event.0.contains(&"new".to_string()));
    assert!(event.1.contains(&"old".to_string()));
    assert!(event.1.contains(&"new".to_string()));

    let staged_status =
        get_worktree_git_status(&client, &base, &project_id, &local_worktree_id).await;
    let staged_files = staged_status["stagedFiles"].as_array().unwrap();
    assert!(staged_files.iter().any(|file| {
        file["path"] == "new/target.txt"
            && file["changeType"] == "renamed"
            && file["originalPath"] == "old/source.txt"
    }));

    let unstage_status = post_worktree_git_action_with_original_path(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "unstage",
        "new/target.txt",
        Some("old/source.txt"),
    )
    .await;
    assert_eq!(unstage_status, StatusCode::NO_CONTENT);

    let unstaged_status =
        get_worktree_git_status(&client, &base, &project_id, &local_worktree_id).await;
    let unstaged_files = unstaged_status["unstagedFiles"].as_array().unwrap();
    assert!(unstaged_files.iter().any(|file| {
        file["path"] == "new/target.txt"
            && file["changeType"] == "renamed"
            && file["originalPath"] == "old/source.txt"
    }));
}

#[tokio::test]
async fn test_worktree_git_stage_and_unstage_actions_accept_original_path_for_copies() {
    let (base, _tmp, state) = start_test_server_with_state().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::create_dir_all(repo.path().join("old")).unwrap();
    std::fs::create_dir_all(repo.path().join("new")).unwrap();
    std::fs::write(repo.path().join("old/source.txt"), "copy me\n").unwrap();
    run_git(repo.path(), &["add", "old/source.txt"]);
    run_git(repo.path(), &["commit", "-q", "-m", "add copy source"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let local_worktree_id = list_worktrees(&client, &base, &project_id).await["worktrees"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    std::fs::copy(
        repo.path().join("old/source.txt"),
        repo.path().join("new/copied.txt"),
    )
    .unwrap();

    let mut rx = state.events.subscribe();
    let expected_project_id = project_id.clone();
    let expected_worktree_id = local_worktree_id.clone();
    let stage_status = post_worktree_git_action_with_original_path(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "stage",
        "new/copied.txt",
        Some("old/source.txt"),
    )
    .await;
    assert_eq!(stage_status, StatusCode::NO_CONTENT);

    let event = tokio::time::timeout(Duration::from_secs(3), async move {
        loop {
            let event = rx.recv().await.unwrap();
            if let EventKind::WorktreeFilesUpdated {
                project_id: observed_project_id,
                worktree_id: observed_worktree_id,
                changed_paths,
                ..
            } = &event.kind
                && observed_project_id == &expected_project_id
                && observed_worktree_id == &expected_worktree_id
            {
                return changed_paths.clone();
            }
        }
    })
    .await
    .unwrap();

    assert!(event.contains(&"old/source.txt".to_string()));
    assert!(event.contains(&"new/copied.txt".to_string()));

    let staged_status =
        get_worktree_git_status(&client, &base, &project_id, &local_worktree_id).await;
    let staged_files = staged_status["stagedFiles"].as_array().unwrap();
    assert!(staged_files.iter().any(|file| {
        file["path"] == "new/copied.txt"
            && file["changeType"] == "copied"
            && file["originalPath"] == "old/source.txt"
    }));

    let unstage_status = post_worktree_git_action_with_original_path(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "unstage",
        "new/copied.txt",
        Some("old/source.txt"),
    )
    .await;
    assert_eq!(unstage_status, StatusCode::NO_CONTENT);

    let unstaged_status =
        get_worktree_git_status(&client, &base, &project_id, &local_worktree_id).await;
    let unstaged_files = unstaged_status["unstagedFiles"].as_array().unwrap();
    assert!(unstaged_files.iter().any(|file| {
        file["path"] == "new/copied.txt"
            && file["changeType"] == "copied"
            && file["originalPath"] == "old/source.txt"
    }));
}

#[tokio::test]
async fn test_worktree_git_discard_action_restores_tracked_and_removes_untracked_content() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::create_dir_all(repo.path().join("docs")).unwrap();
    std::fs::write(repo.path().join("docs/guide.md"), "original\n").unwrap();
    run_git(repo.path(), &["add", "docs/guide.md"]);
    run_git(repo.path(), &["commit", "-q", "-m", "add docs"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let local_worktree_id = list_worktrees(&client, &base, &project_id).await["worktrees"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    std::fs::write(repo.path().join("docs/guide.md"), "changed\n").unwrap();
    std::fs::write(repo.path().join("docs/scratch.txt"), "scratch\n").unwrap();
    std::fs::create_dir_all(repo.path().join("docs/drafts")).unwrap();
    std::fs::write(repo.path().join("docs/drafts/extra.md"), "extra\n").unwrap();

    let discard_status = post_worktree_git_action(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "discard",
        "docs",
    )
    .await;
    assert_eq!(discard_status, StatusCode::NO_CONTENT);

    assert_eq!(
        std::fs::read_to_string(repo.path().join("docs/guide.md")).unwrap(),
        "original\n"
    );
    assert!(!repo.path().join("docs/scratch.txt").exists());
    assert!(!repo.path().join("docs/drafts").exists());

    let status = get_worktree_git_status(&client, &base, &project_id, &local_worktree_id).await;
    assert_eq!(status["unstagedFiles"], serde_json::json!([]));
    assert_eq!(status["stagedFiles"], serde_json::json!([]));
}

#[tokio::test]
async fn test_worktree_git_discard_action_removes_requested_empty_directory() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::create_dir_all(repo.path().join("docs/drafts")).unwrap();
    std::fs::write(repo.path().join("docs/drafts/extra.md"), "extra\n").unwrap();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let local_worktree_id = list_worktrees(&client, &base, &project_id).await["worktrees"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let discard_status = post_worktree_git_action(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "discard",
        "docs/drafts",
    )
    .await;
    assert_eq!(discard_status, StatusCode::NO_CONTENT);

    assert!(!repo.path().join("docs/drafts").exists());
    assert!(repo.path().join("docs").exists());
}

#[tokio::test]
async fn test_worktree_git_discard_action_removes_preexisting_empty_directory() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::create_dir_all(repo.path().join("docs/drafts")).unwrap();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let local_worktree_id = list_worktrees(&client, &base, &project_id).await["worktrees"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let discard_status = post_worktree_git_action(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "discard",
        "docs/drafts",
    )
    .await;
    assert_eq!(discard_status, StatusCode::NO_CONTENT);

    assert!(!repo.path().join("docs/drafts").exists());
    assert!(repo.path().join("docs").exists());
}

#[tokio::test]
async fn test_worktree_git_discard_action_preserves_staged_tracked_content() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let local_worktree_id = list_worktrees(&client, &base, &project_id).await["worktrees"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    std::fs::write(repo.path().join("README.md"), "hello\nstaged\n").unwrap();
    run_git(repo.path(), &["add", "README.md"]);
    std::fs::write(repo.path().join("README.md"), "hello\nstaged\nunstaged\n").unwrap();

    let discard_status = post_worktree_git_action(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "discard",
        "README.md",
    )
    .await;
    assert_eq!(discard_status, StatusCode::NO_CONTENT);

    assert_eq!(
        std::fs::read_to_string(repo.path().join("README.md")).unwrap(),
        "hello\nstaged\n"
    );

    let status = get_worktree_git_status(&client, &base, &project_id, &local_worktree_id).await;
    assert_eq!(status["unstagedFiles"], serde_json::json!([]));
    let staged_files = status["stagedFiles"].as_array().unwrap();
    assert_eq!(staged_files.len(), 1);
    assert_eq!(staged_files[0]["path"], "README.md");
    assert_eq!(staged_files[0]["changeType"], "modified");
}

#[tokio::test]
async fn test_worktree_git_discard_action_preserves_staged_added_content() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let local_worktree_id = list_worktrees(&client, &base, &project_id).await["worktrees"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    std::fs::write(repo.path().join("added.txt"), "staged add\n").unwrap();
    run_git(repo.path(), &["add", "added.txt"]);
    std::fs::write(repo.path().join("added.txt"), "staged add\nunstaged edit\n").unwrap();

    let discard_status = post_worktree_git_action(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "discard",
        "added.txt",
    )
    .await;
    assert_eq!(discard_status, StatusCode::NO_CONTENT);

    assert_eq!(
        std::fs::read_to_string(repo.path().join("added.txt")).unwrap(),
        "staged add\n"
    );

    let status = get_worktree_git_status(&client, &base, &project_id, &local_worktree_id).await;
    assert_eq!(status["unstagedFiles"], serde_json::json!([]));
    let staged_files = status["stagedFiles"].as_array().unwrap();
    assert_eq!(staged_files.len(), 1);
    assert_eq!(staged_files[0]["path"], "added.txt");
    assert_eq!(staged_files[0]["changeType"], "added");
}

#[tokio::test]
async fn test_worktree_git_discard_action_rejects_unmerged_conflicts() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join("conflict.txt"), "base\n").unwrap();
    run_git(repo.path(), &["add", "conflict.txt"]);
    run_git(repo.path(), &["commit", "-q", "-m", "add conflict file"]);

    run_git(repo.path(), &["checkout", "-q", "-b", "side"]);
    std::fs::remove_file(repo.path().join("conflict.txt")).unwrap();
    run_git(repo.path(), &["add", "-A"]);
    run_git(repo.path(), &["commit", "-q", "-m", "delete on side"]);

    run_git(repo.path(), &["checkout", "-q", "main"]);
    std::fs::write(repo.path().join("conflict.txt"), "main\n").unwrap();
    run_git(repo.path(), &["add", "conflict.txt"]);
    run_git(repo.path(), &["commit", "-q", "-m", "edit on main"]);

    let merge_status = run_git_status(repo.path(), &["merge", "side"]);
    assert!(!merge_status.success());

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let local_worktree_id = list_worktrees(&client, &base, &project_id).await["worktrees"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let discard_status = post_worktree_git_action(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "discard",
        "conflict.txt",
    )
    .await;
    assert_eq!(discard_status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn test_worktree_git_actions_reject_invalid_paths() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let local_worktree_id = list_worktrees(&client, &base, &project_id).await["worktrees"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let status = post_worktree_git_action(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "stage",
        "../README.md",
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_worktree_git_actions_reject_nul_paths() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let local_worktree_id = list_worktrees(&client, &base, &project_id).await["worktrees"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let status = post_worktree_git_action(
        &client,
        &base,
        &project_id,
        &local_worktree_id,
        "stage",
        "README.md\0evil",
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
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
    assert_eq!(body["startPoints"], serde_json::json!([]));
    assert!(body["gitError"].is_string());
}
