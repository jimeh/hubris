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
    client
        .post(format!(
            "{}/api/projects/{}/worktrees/{}/git/{}",
            base, project_id, worktree_id, action
        ))
        .json(&serde_json::json!({ "path": path }))
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
    assert_eq!(worktrees[0]["is_local"], true);
    assert_eq!(worktrees[0]["missing_on_disk"], false);
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
    assert_eq!(worktrees[0]["is_local"], true);
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
    let managed = worktrees.iter().find(|wt| wt["is_local"] == false).unwrap();
    assert_eq!(managed["missing_on_disk"], true);
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
    assert_eq!(worktrees[0]["is_local"], true);
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
    assert_eq!(worktrees[0]["is_local"], true);
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
            "start_point": "main",
            "source_ref": "origin/main"
        }),
    )
    .await;

    assert_eq!(body["source_ref"], "origin/main");

    let listed = list_worktrees(&client, &base, &project_id).await;
    let worktrees = listed["worktrees"].as_array().unwrap();
    let created = worktrees
        .iter()
        .find(|worktree| worktree["branch"] == "feature-source-ref")
        .unwrap();
    assert_eq!(created["source_ref"], "origin/main");
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
    assert!(legacy.unwrap()["source_ref"].is_null());
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
            "start_point": "main",
            "source_ref": "main"
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

    assert_eq!(body["source_ref"], "main");
    assert_eq!(body["ahead_count"], 1);
    assert_eq!(body["comparison_available"], true);
    assert!(body["comparison_error"].is_null());
    assert_eq!(body["ahead_commits"][0]["summary"], "feat: ahead");
    assert_eq!(body["staged_files"][0]["path"], "staged.txt");
    assert_eq!(body["staged_files"][0]["change_type"], "added");
    assert_eq!(body["unstaged_files"][0]["path"], "README.md");
    assert_eq!(body["unstaged_files"][0]["change_type"], "modified");
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
        .find(|worktree| worktree["is_local"] == true)
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
    assert_eq!(body["id"], commit_id);
    assert_eq!(body["summary"], "feat: details");
    assert!(body["message"].as_str().unwrap().contains("body line one"));
    assert_eq!(body["author"]["name"], "Author Example");
    assert_eq!(body["author"]["email"], "author@example.com");
    assert_eq!(body["committer"]["name"], "Committer Example");
    assert_eq!(body["committer"]["email"], "committer@example.com");
    assert_eq!(body["files"][0]["path"], "details.txt");
    assert_eq!(body["files"][0]["change_type"], "added");
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
        .find(|worktree| worktree["is_local"] == true)
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
            .any(|file| file["path"] == "README.md" && file["change_type"] == "added")
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
        .find(|worktree| worktree["is_local"] == true)
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
            .any(|file| file["path"] == "feature.txt" && file["change_type"] == "added")
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
        .find(|worktree| worktree["is_local"] == true)
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

    assert_eq!(body["comparison_available"], false);
    assert!(body["comparison_error"].is_null());
    assert!(body["ahead_commits"].as_array().unwrap().is_empty());
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
            "source_ref": "does/not/exist"
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

    assert_eq!(body["comparison_available"], true);
    assert!(body["comparison_error"].is_string());
    assert_eq!(body["unstaged_files"][0]["path"], "README.md");
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
            "start_point": "main",
            "source_ref": "main"
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

    let staged_files = body["staged_files"].as_array().unwrap();
    assert!(
        staged_files
            .iter()
            .any(|file| { file["path"] == "copied-target.txt" && file["change_type"] == "copied" })
    );
    assert!(
        staged_files.iter().any(|file| {
            file["path"] == "rename-target.txt" && file["change_type"] == "renamed"
        })
    );
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
            "source_ref": "main"
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
            "start_point": "main",
            "source_ref": "main"
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

    let unstaged_files = body["unstaged_files"].as_array().unwrap();
    assert!(
        unstaged_files
            .iter()
            .any(|file| { file["path"] == "README.md" && file["change_type"] == "conflict" })
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
    assert_eq!(initial_status["unstaged_files"][0]["path"], "README.md");
    assert_eq!(initial_status["staged_files"], serde_json::json!([]));

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
    assert_eq!(staged_status["unstaged_files"], serde_json::json!([]));
    assert_eq!(staged_status["staged_files"][0]["path"], "README.md");
    assert_eq!(staged_status["staged_files"][0]["change_type"], "modified");

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
    assert_eq!(unstaged_status["staged_files"], serde_json::json!([]));
    assert_eq!(unstaged_status["unstaged_files"][0]["path"], "README.md");
    assert_eq!(
        unstaged_status["unstaged_files"][0]["change_type"],
        "modified"
    );
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
    let staged_files = staged_status["staged_files"].as_array().unwrap();
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
    let unstaged_files = unstaged_status["unstaged_files"].as_array().unwrap();
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
    assert_eq!(status["unstaged_files"], serde_json::json!([]));
    assert_eq!(status["staged_files"], serde_json::json!([]));
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
    assert_eq!(status["unstaged_files"], serde_json::json!([]));
    let staged_files = status["staged_files"].as_array().unwrap();
    assert_eq!(staged_files.len(), 1);
    assert_eq!(staged_files[0]["path"], "README.md");
    assert_eq!(staged_files[0]["change_type"], "modified");
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
    assert_eq!(status["unstaged_files"], serde_json::json!([]));
    let staged_files = status["staged_files"].as_array().unwrap();
    assert_eq!(staged_files.len(), 1);
    assert_eq!(staged_files[0]["path"], "added.txt");
    assert_eq!(staged_files[0]["change_type"], "added");
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
