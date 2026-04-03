use std::path::Path;
use std::process::Command;
use std::time::Duration;

use hubris_server::events::EventKind;
use hubris_server::{AppState, build_router};
use reqwest::StatusCode;
use serde_json::Value;

const DISALLOWED_PATH_MESSAGE: &str = "This path resolves outside the allowed roots. Only files inside this \
     worktree or symlinks into the repository root can be opened.";

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

fn init_empty_git_repo() -> tempfile::TempDir {
    let repo = tempfile::TempDir::new().unwrap();
    run_git(repo.path(), &["init", "-q"]);
    run_git(repo.path(), &["config", "user.email", "test@example.com"]);
    run_git(repo.path(), &["config", "user.name", "Hubris Test"]);
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
    let linked_git_dir = tmp.path().join("linkedrepo");
    std::fs::create_dir(&linked_git_dir).unwrap();
    std::fs::write(linked_git_dir.join(".git"), "gitdir: /tmp/elsewhere\n").unwrap();
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

    // Should have mydir, myrepo, and linkedrepo only
    assert_eq!(entries.len(), 3);

    let names: Vec<&str> = entries
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"mydir"));
    assert!(names.contains(&"myrepo"));
    assert!(names.contains(&"linkedrepo"));

    // myrepo should be detected as git repo
    let myrepo = entries.iter().find(|e| e["name"] == "myrepo").unwrap();
    assert_eq!(myrepo["is_git_repo"], true);

    let linkedrepo = entries.iter().find(|e| e["name"] == "linkedrepo").unwrap();
    assert_eq!(linkedrepo["is_git_repo"], true);

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
async fn test_worktree_file_content_can_be_saved_and_detects_conflicts() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join("notes.txt"), "first\n").unwrap();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let loaded = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/files/content?path=notes.txt",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(loaded.status(), StatusCode::OK);
    let loaded_body: Value = loaded.json().await.unwrap();
    assert_eq!(loaded_body["content"], "first\n");
    let original_token = loaded_body["version_token"].as_str().unwrap().to_string();

    let saved = client
        .put(format!(
            "{}/api/projects/{}/worktrees/{}/files/content",
            base, project_id, worktree_id
        ))
        .json(&serde_json::json!({
            "path": "notes.txt",
            "content": "second\n",
            "expected_version_token": original_token,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::OK);
    let saved_body: Value = saved.json().await.unwrap();
    let updated_token = saved_body["version_token"].as_str().unwrap();
    assert_ne!(updated_token, loaded_body["version_token"]);
    assert_eq!(
        std::fs::read_to_string(repo.path().join("notes.txt")).unwrap(),
        "second\n"
    );
    let temp_entries = std::fs::read_dir(repo.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("notes.txt.tmp.")
        })
        .count();
    assert_eq!(temp_entries, 0);

    let conflict = client
        .put(format!(
            "{}/api/projects/{}/worktrees/{}/files/content",
            base, project_id, worktree_id
        ))
        .json(&serde_json::json!({
            "path": "notes.txt",
            "content": "third\n",
            "expected_version_token": loaded_body["version_token"],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    assert_eq!(
        std::fs::read_to_string(repo.path().join("notes.txt")).unwrap(),
        "second\n"
    );
}

#[tokio::test]
async fn test_worktree_file_content_noop_save_returns_same_token() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join("notes.txt"), "first\n").unwrap();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let loaded = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/files/content?path=notes.txt",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(loaded.status(), StatusCode::OK);
    let loaded_body: Value = loaded.json().await.unwrap();

    let saved = client
        .put(format!(
            "{}/api/projects/{}/worktrees/{}/files/content",
            base, project_id, worktree_id
        ))
        .json(&serde_json::json!({
            "path": "notes.txt",
            "content": "first\n",
            "expected_version_token": loaded_body["version_token"],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::OK);
    let saved_body: Value = saved.json().await.unwrap();
    assert_eq!(saved_body["version_token"], loaded_body["version_token"]);
    assert_eq!(
        std::fs::read_to_string(repo.path().join("notes.txt")).unwrap(),
        "first\n"
    );
}

#[tokio::test]
async fn test_binary_worktree_file_content_is_read_only_and_cannot_be_saved() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join("binary.bin"), [0_u8, 159, 146, 150]).unwrap();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let loaded = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/files/content?path=binary.bin",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(loaded.status(), StatusCode::OK);
    let loaded_body: Value = loaded.json().await.unwrap();
    assert_eq!(loaded_body["content"], "");
    assert_eq!(loaded_body["read_only"], true);
    assert_eq!(
        loaded_body["unsupported_reason"],
        "Binary files are read-only."
    );

    let save = client
        .put(format!(
            "{}/api/projects/{}/worktrees/{}/files/content",
            base, project_id, worktree_id
        ))
        .json(&serde_json::json!({
            "path": "binary.bin",
            "content": "text\n",
            "expected_version_token": loaded_body["version_token"],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(save.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        std::fs::read(repo.path().join("binary.bin")).unwrap(),
        vec![0_u8, 159, 146, 150]
    );
}

#[tokio::test]
async fn test_worktree_file_content_infers_monaco_languages() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let cases = [
        ("notes.mdx", "# heading\n", "mdx"),
        ("package.json", "{\"name\":\"hubris\"}\n", "json"),
        ("Dockerfile", "FROM scratch\n", "dockerfile"),
        (".editorconfig", "root = true\n", "ini"),
        ("hello.cpp", "int main() { return 0; }\n", "cpp"),
        (
            "script",
            "#!/usr/bin/env node\nconsole.log('ok');\n",
            "javascript",
        ),
        ("runner", "#!/usr/bin/python3\nprint('ok')\n", "python"),
        ("vector", "<svg viewBox=\"0 0 10 10\"></svg>\n", "xml"),
        ("notes.unknown", "plain text\n", "plaintext"),
    ];

    for (path, content, _) in cases {
        std::fs::write(repo.path().join(path), content).unwrap();
    }

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    for (path, _, expected_language) in cases {
        let loaded = client
            .get(format!(
                "{}/api/projects/{}/worktrees/{}/files/content?path={}",
                base, project_id, worktree_id, path
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(loaded.status(), StatusCode::OK, "path={path}");
        let body: Value = loaded.json().await.unwrap();
        assert_eq!(body["language"], expected_language, "path={path}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn test_worktree_file_content_rejects_symlink_escape_on_load() {
    use std::os::unix::fs::symlink;

    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();
    let outside = tempfile::NamedTempFile::new().unwrap();

    symlink(outside.path(), repo.path().join("escape-link")).unwrap();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let loaded = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/files/content?path=escape-link",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(loaded.status(), StatusCode::FORBIDDEN);
    let body: Value = loaded.json().await.unwrap();
    assert_eq!(body["message"], DISALLOWED_PATH_MESSAGE);
}

#[cfg(unix)]
#[tokio::test]
async fn test_worktree_file_content_rejects_symlink_escape_on_save() {
    use std::os::unix::fs::symlink;

    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();
    let outside = tempfile::NamedTempFile::new().unwrap();

    std::fs::write(outside.path(), "outside\n").unwrap();
    symlink(outside.path(), repo.path().join("escape-link")).unwrap();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let save = client
        .put(format!(
            "{}/api/projects/{}/worktrees/{}/files/content",
            base, project_id, worktree_id
        ))
        .json(&serde_json::json!({
            "path": "escape-link",
            "content": "inside\n",
            "expected_version_token": "ignored",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(save.status(), StatusCode::FORBIDDEN);
    let body: Value = save.json().await.unwrap();
    assert_eq!(body["message"], DISALLOWED_PATH_MESSAGE);
    assert_eq!(
        std::fs::read_to_string(outside.path()).unwrap(),
        "outside\n"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn test_linked_worktree_symlink_into_repo_root_is_allowed_for_content_and_diff() {
    use std::os::unix::fs::symlink;

    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join(".env.local"), "ROOT=one\n").unwrap();
    std::fs::create_dir(repo.path().join("shared")).unwrap();
    std::fs::write(repo.path().join("shared/config.txt"), "shared\n").unwrap();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let created = create_worktree(&client, &base, &project_id, "feature-shared").await;
    let worktree_id = created["id"].as_str().unwrap();
    let worktree_path = created["path"].as_str().unwrap();

    symlink(
        repo.path().join(".env.local"),
        Path::new(worktree_path).join(".env.local"),
    )
    .unwrap();
    symlink(
        repo.path().join("shared"),
        Path::new(worktree_path).join("shared-link"),
    )
    .unwrap();

    let loaded = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/files/content?path=.env.local",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(loaded.status(), StatusCode::OK);
    let loaded_body: Value = loaded.json().await.unwrap();
    assert_eq!(loaded_body["content"], "ROOT=one\n");

    let saved = client
        .put(format!(
            "{}/api/projects/{}/worktrees/{}/files/content",
            base, project_id, worktree_id
        ))
        .json(&serde_json::json!({
            "path": ".env.local",
            "content": "ROOT=two\n",
            "expected_version_token": loaded_body["version_token"],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::OK);
    assert_eq!(
        std::fs::read_to_string(repo.path().join(".env.local")).unwrap(),
        "ROOT=two\n"
    );

    let diff = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/diff?path=.env.local&scope=unstaged",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let diff_body: Value = diff.json().await.unwrap();
    assert_eq!(diff_body["left_content"], "");
    assert_eq!(diff_body["right_content"], "ROOT=two\n");

    let listing = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/files",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(listing.status(), StatusCode::OK);
    let listing_body: Value = listing.json().await.unwrap();
    assert!(
        listing_body["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| {
                entry["path"] == ".env.local"
                    && entry["kind"] == "file"
                    && entry["is_symlink"] == true
            })
    );
    assert!(
        listing_body["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| {
                entry["path"] == "shared-link"
                    && entry["kind"] == "directory"
                    && entry["is_symlink"] == true
            })
    );

    let nested_listing = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/files?path=shared-link",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(nested_listing.status(), StatusCode::OK);
    let nested_body: Value = nested_listing.json().await.unwrap();
    assert!(
        nested_body["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"] == "shared-link/config.txt")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn test_worktree_file_content_save_failure_does_not_truncate_original() {
    use std::os::unix::fs::PermissionsExt;

    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join("notes.txt"), "first\n").unwrap();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let loaded = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/files/content?path=notes.txt",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(loaded.status(), StatusCode::OK);
    let loaded_body: Value = loaded.json().await.unwrap();

    let metadata = std::fs::metadata(repo.path()).unwrap();
    let original_mode = metadata.permissions().mode();
    let mut read_only_permissions = metadata.permissions();
    read_only_permissions.set_mode(0o555);
    std::fs::set_permissions(repo.path(), read_only_permissions).unwrap();

    let save = client
        .put(format!(
            "{}/api/projects/{}/worktrees/{}/files/content",
            base, project_id, worktree_id
        ))
        .json(&serde_json::json!({
            "path": "notes.txt",
            "content": "second\n",
            "expected_version_token": loaded_body["version_token"],
        }))
        .send()
        .await
        .unwrap();

    let mut restored_permissions = std::fs::metadata(repo.path()).unwrap().permissions();
    restored_permissions.set_mode(original_mode);
    std::fs::set_permissions(repo.path(), restored_permissions).unwrap();

    assert_eq!(save.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        std::fs::read_to_string(repo.path().join("notes.txt")).unwrap(),
        "first\n"
    );
}

#[tokio::test]
async fn test_unstaged_git_diff_for_missing_worktree_file_returns_empty_right_side() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    std::fs::remove_file(repo.path().join("README.md")).unwrap();

    let diff = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/diff?path=README.md&scope=unstaged",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let body: Value = diff.json().await.unwrap();
    assert_eq!(body["left_content"], "hello\n");
    assert_eq!(body["right_content"], "");
    assert_eq!(body["right_label"], "Working Tree");
    assert_eq!(body["read_only"], true);
    assert!(body["modified_version_token"].is_null());
}

#[tokio::test]
async fn test_unstaged_git_diff_for_text_worktree_file_is_editable() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join("README.md"), "hello world\n").unwrap();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let diff = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/diff?path=README.md&scope=unstaged",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let body: Value = diff.json().await.unwrap();
    assert_eq!(body["left_content"], "hello\n");
    assert_eq!(body["right_content"], "hello world\n");
    assert_eq!(body["read_only"], false);
    assert!(body["modified_version_token"].as_str().is_some());
}

#[tokio::test]
async fn test_staged_git_diff_for_new_file_returns_empty_left_side() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join("new.txt"), "new file\n").unwrap();
    run_git(repo.path(), &["add", "new.txt"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let diff = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/diff?path=new.txt&scope=staged",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let body: Value = diff.json().await.unwrap();
    assert_eq!(body["left_content"], "");
    assert_eq!(body["right_content"], "new file\n");
    assert_eq!(body["read_only"], true);
    assert!(body["modified_version_token"].is_null());
    assert!(body["unsupported_reason"].is_null());
}

#[tokio::test]
async fn test_staged_git_diff_infers_monaco_languages() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let cases = [
        ("package.json", "{\"name\":\"hubris\"}\n", "json"),
        ("schema.proto", "syntax = \"proto3\";\n", "proto"),
        ("Gemfile", "source \"https://rubygems.org\"\n", "ruby"),
        ("hello.hpp", "#pragma once\n", "cpp"),
        ("runner", "#!/usr/bin/python3\nprint('ok')\n", "python"),
        ("main.tf", "terraform {}\n", "hcl"),
        ("notes.unknown", "plain text\n", "plaintext"),
    ];

    for (path, content, _) in cases {
        std::fs::write(repo.path().join(path), content).unwrap();
        run_git(repo.path(), &["add", path]);
    }

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    for (path, content, expected_language) in cases {
        let diff = client
            .get(format!(
                "{}/api/projects/{}/worktrees/{}/git/diff?path={}&scope=staged",
                base, project_id, worktree_id, path
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(diff.status(), StatusCode::OK, "path={path}");
        let body: Value = diff.json().await.unwrap();
        assert_eq!(body["left_content"], "", "path={path}");
        assert_eq!(body["right_content"], content, "path={path}");
        assert_eq!(body["language"], expected_language, "path={path}");
        assert!(body["unsupported_reason"].is_null(), "path={path}");
    }
}

#[tokio::test]
async fn test_staged_git_diff_for_binary_index_blob_is_unsupported() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join("binary.bin"), [0_u8, 159, 146, 150]).unwrap();
    run_git(repo.path(), &["add", "binary.bin"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let diff = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/diff?path=binary.bin&scope=staged",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let body: Value = diff.json().await.unwrap();
    assert_eq!(
        body["unsupported_reason"],
        "Binary diffs are not supported."
    );
    assert_eq!(body["left_content"], "");
    assert_eq!(body["right_content"], "");
}

#[tokio::test]
async fn test_unstaged_git_diff_for_binary_index_blob_is_unsupported() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join("README.md"), [0_u8, 159, 146, 150]).unwrap();
    run_git(repo.path(), &["add", "README.md"]);
    std::fs::write(repo.path().join("README.md"), "worktree\n").unwrap();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let diff = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/diff?path=README.md&scope=unstaged",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let body: Value = diff.json().await.unwrap();
    assert_eq!(
        body["unsupported_reason"],
        "Binary diffs are not supported."
    );
    assert_eq!(body["left_content"], "");
    assert_eq!(body["right_content"], "worktree\n");
    assert_eq!(body["read_only"], true);
    assert!(body["modified_version_token"].is_null());
}

#[tokio::test]
async fn test_staged_git_diff_uses_original_path_for_left_side() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join("renamed.md"), "updated\n").unwrap();
    run_git(repo.path(), &["add", "renamed.md"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let diff = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/diff?path=renamed.md&scope=staged&original_path=README.md",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let body: Value = diff.json().await.unwrap();
    assert_eq!(body["left_content"], "hello\n");
    assert_eq!(body["right_content"], "updated\n");
}

#[tokio::test]
async fn test_commit_git_diff_returns_parent_to_commit_content() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join("README.md"), "hello world\n").unwrap();
    run_git(repo.path(), &["add", "README.md"]);
    run_git(repo.path(), &["commit", "-q", "-m", "feat: update readme"]);
    let commit_id = run_git_output(repo.path(), &["rev-parse", "HEAD"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let diff = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/diff?path=README.md&scope=commit&commit_id={}",
            base, project_id, worktree_id, commit_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let body: Value = diff.json().await.unwrap();
    assert_eq!(body["left_content"], "hello\n");
    assert_eq!(body["right_content"], "hello world\n");
    assert_eq!(body["left_label"], "Parent");
    assert_eq!(body["right_label"], "Commit");
    assert_eq!(body["read_only"], true);
    assert!(body["modified_version_token"].is_null());
    assert_eq!(body["commit_id"], commit_id);
}

#[tokio::test]
async fn test_commit_git_diff_handles_root_commit_diff() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();
    let root_commit_id = run_git_output(repo.path(), &["rev-list", "--max-parents=0", "HEAD"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let diff = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/diff?path=README.md&scope=commit&commit_id={}",
            base, project_id, worktree_id, root_commit_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let body: Value = diff.json().await.unwrap();
    assert_eq!(body["left_content"], "");
    assert_eq!(body["right_content"], "hello\n");
}

#[tokio::test]
async fn test_commit_git_diff_uses_first_parent_for_merge_commits() {
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
    let merge_commit_id = run_git_output(repo.path(), &["rev-parse", "HEAD"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let diff = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/diff?path=feature.txt&scope=commit&commit_id={}",
            base, project_id, worktree_id, merge_commit_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let body: Value = diff.json().await.unwrap();
    assert_eq!(body["left_content"], "");
    assert_eq!(body["right_content"], "feature\n");
}

#[tokio::test]
async fn test_commit_git_diff_uses_original_path_for_left_side() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    run_git(repo.path(), &["mv", "README.md", "renamed.md"]);
    std::fs::write(repo.path().join("renamed.md"), "updated\n").unwrap();
    run_git(repo.path(), &["add", "renamed.md"]);
    run_git(repo.path(), &["commit", "-q", "-m", "feat: rename readme"]);
    let commit_id = run_git_output(repo.path(), &["rev-parse", "HEAD"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let diff = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/diff?path=renamed.md&scope=commit&commit_id={}&original_path=README.md",
            base, project_id, worktree_id, commit_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let body: Value = diff.json().await.unwrap();
    assert_eq!(body["left_content"], "hello\n");
    assert_eq!(body["right_content"], "updated\n");
}

#[tokio::test]
async fn test_commit_git_diff_for_deleted_file_returns_empty_right_side() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join("extra.txt"), "extra\n").unwrap();
    run_git(repo.path(), &["add", "extra.txt"]);
    run_git(repo.path(), &["commit", "-q", "-m", "feat: add extra"]);
    std::fs::remove_file(repo.path().join("extra.txt")).unwrap();
    run_git(repo.path(), &["add", "extra.txt"]);
    run_git(repo.path(), &["commit", "-q", "-m", "feat: remove extra"]);
    let commit_id = run_git_output(repo.path(), &["rev-parse", "HEAD"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let diff = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/diff?path=extra.txt&scope=commit&commit_id={}",
            base, project_id, worktree_id, commit_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let body: Value = diff.json().await.unwrap();
    assert_eq!(body["left_content"], "extra\n");
    assert_eq!(body["right_content"], "");
}

#[tokio::test]
async fn test_commit_git_diff_for_binary_blob_is_unsupported() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::write(repo.path().join("binary.bin"), [0_u8, 159, 146, 150]).unwrap();
    run_git(repo.path(), &["add", "binary.bin"]);
    run_git(repo.path(), &["commit", "-q", "-m", "feat: add binary"]);
    let commit_id = run_git_output(repo.path(), &["rev-parse", "HEAD"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let diff = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/diff?path=binary.bin&scope=commit&commit_id={}",
            base, project_id, worktree_id, commit_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let body: Value = diff.json().await.unwrap();
    assert_eq!(
        body["unsupported_reason"],
        "Binary diffs are not supported."
    );
    assert_eq!(body["left_content"], "");
    assert_eq!(body["right_content"], "");
}

#[tokio::test]
async fn test_commit_git_diff_for_large_blob_is_unsupported() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();
    let large = "a".repeat(1024 * 1024 + 1);

    std::fs::write(repo.path().join("large.txt"), large).unwrap();
    run_git(repo.path(), &["add", "large.txt"]);
    run_git(repo.path(), &["commit", "-q", "-m", "feat: add large"]);
    let commit_id = run_git_output(repo.path(), &["rev-parse", "HEAD"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let diff = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/diff?path=large.txt&scope=commit&commit_id={}",
            base, project_id, worktree_id, commit_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let body: Value = diff.json().await.unwrap();
    assert_eq!(
        body["unsupported_reason"],
        "Diffs larger than 1 MiB are read-only."
    );
    assert_eq!(body["left_content"], "");
    assert_eq!(body["right_content"], "");
}

#[tokio::test]
async fn test_staged_git_diff_in_unborn_repo_returns_empty_head_side() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_empty_git_repo();

    std::fs::write(repo.path().join("new.txt"), "new file\n").unwrap();
    run_git(repo.path(), &["add", "new.txt"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let diff = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/diff?path=new.txt&scope=staged",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let body: Value = diff.json().await.unwrap();
    assert_eq!(body["left_content"], "");
    assert_eq!(body["right_content"], "new file\n");
    assert!(body["unsupported_reason"].is_null());
}

#[tokio::test]
async fn test_unstaged_git_diff_for_large_worktree_file_is_unsupported() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();
    let large = "a".repeat(1024 * 1024 + 1);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    std::fs::write(repo.path().join("README.md"), large).unwrap();

    let diff = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/diff?path=README.md&scope=unstaged",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let body: Value = diff.json().await.unwrap();
    assert_eq!(
        body["unsupported_reason"],
        "Diffs larger than 1 MiB are read-only."
    );
    assert_eq!(body["left_content"], "hello\n");
    assert_eq!(body["right_content"], "");
    assert_eq!(body["read_only"], true);
    assert!(body["modified_version_token"].is_null());
}

#[tokio::test]
async fn test_staged_git_diff_for_large_index_blob_is_unsupported() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();
    let large = "a".repeat(1024 * 1024 + 1);

    std::fs::write(repo.path().join("large.txt"), large).unwrap();
    run_git(repo.path(), &["add", "large.txt"]);

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let diff = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/diff?path=large.txt&scope=staged",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let body: Value = diff.json().await.unwrap();
    assert_eq!(
        body["unsupported_reason"],
        "Diffs larger than 1 MiB are read-only."
    );
    assert_eq!(body["left_content"], "");
    assert_eq!(body["right_content"], "");
}

#[cfg(unix)]
#[tokio::test]
async fn test_unstaged_git_diff_rejects_symlink_escape() {
    use std::os::unix::fs::symlink;

    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();
    let outside = tempfile::NamedTempFile::new().unwrap();

    symlink(outside.path(), repo.path().join("escape-link")).unwrap();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;

    let diff = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git/diff?path=escape-link&scope=unstaged",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::FORBIDDEN);
    let body: Value = diff.json().await.unwrap();
    assert_eq!(body["message"], DISALLOWED_PATH_MESSAGE);
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
    std::fs::create_dir(repo.path().join("source-dir")).unwrap();
    std::fs::create_dir(repo.path().join("taken-dir")).unwrap();

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

    let dir_conflict = client
        .post(format!(
            "{}/api/projects/{}/worktrees/{}/files/rename",
            base, project_id, worktree_id
        ))
        .json(&serde_json::json!({
            "path": "source-dir",
            "new_name": "taken-dir"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(dir_conflict.status(), StatusCode::CONFLICT);

    let nul_path = client
        .post(format!(
            "{}/api/projects/{}/worktrees/{}/files/rename",
            base, project_id, worktree_id
        ))
        .json(&serde_json::json!({
            "path": "file.txt\u{0000}evil",
            "new_name": "renamed.txt"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(nul_path.status(), StatusCode::BAD_REQUEST);

    let nul_name = client
        .post(format!(
            "{}/api/projects/{}/worktrees/{}/files/rename",
            base, project_id, worktree_id
        ))
        .json(&serde_json::json!({
            "path": "file.txt",
            "new_name": "renamed\u{0000}.txt"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(nul_name.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_rename_worktree_file_emits_immediate_invalidation_for_old_and_new_paths() {
    let (base, _tmp, state) = start_test_server_with_state().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    std::fs::create_dir_all(repo.path().join("old")).unwrap();
    std::fs::create_dir_all(repo.path().join("new")).unwrap();
    std::fs::write(repo.path().join("old/file.txt"), "rename me\n").unwrap();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = local_worktree_id(&client, &base, &project_id).await;
    let mut rx = state.events.subscribe();

    let rename_res = client
        .post(format!(
            "{}/api/projects/{}/worktrees/{}/files/rename",
            base, project_id, worktree_id
        ))
        .json(&serde_json::json!({
            "path": "old/file.txt",
            "new_name": "renamed.txt"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(rename_res.status(), StatusCode::OK);

    let event = tokio::time::timeout(Duration::from_secs(3), async move {
        loop {
            let event = rx.recv().await.unwrap();
            if let EventKind::WorktreeFilesUpdated {
                project_id: event_project_id,
                worktree_id: event_worktree_id,
                changed_paths,
                listing_paths,
                ..
            } = &event.kind
                && event_project_id == &project_id
                && event_worktree_id == &worktree_id
            {
                return (changed_paths.clone(), listing_paths.clone());
            }
        }
    })
    .await
    .unwrap();

    assert!(event.0.contains(&"old/file.txt".to_string()));
    assert!(event.0.contains(&"old/renamed.txt".to_string()));
    assert!(event.1.contains(&"old".to_string()));
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
                changed_paths,
                listing_paths,
            } = &event.kind
                && event_project_id == &project_id
                && event_worktree_id == &worktree_id
            {
                return (*generation, changed_paths.clone(), listing_paths.clone());
            }
        }
    })
    .await
    .unwrap();

    assert!(event.0 >= 2);
    assert_eq!(event.1, vec!["watch-me.txt".to_string()]);
    assert_eq!(event.2, vec!["".to_string()]);
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
                changed_paths,
                listing_paths,
            } = &event.kind
                && event_project_id == &project_id
                && event_worktree_id == &worktree_id
            {
                return (*generation, changed_paths.clone(), listing_paths.clone());
            }
        }
    })
    .await
    .unwrap();

    assert!(event.0 >= 2);
    assert_eq!(event.1, vec!["src/nested/watch-me.txt".to_string()]);
    assert_eq!(event.2, vec!["src/nested".to_string()]);
}

#[tokio::test]
async fn test_linked_worktree_git_metadata_watcher_emits_git_status_event() {
    let (base, _tmp, state) = start_test_server_with_state().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let created = create_worktree(&client, &base, &project_id, "feature").await;
    let worktree_id = created["id"].as_str().unwrap().to_string();
    let linked_path = Path::new(created["path"].as_str().unwrap()).to_path_buf();

    let status_res = client
        .get(format!(
            "{}/api/projects/{}/worktrees/{}/git-status",
            base, project_id, worktree_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(status_res.status(), StatusCode::OK);

    let mut rx = state.events.subscribe();
    run_git(
        linked_path.as_path(),
        &["commit", "--allow-empty", "-q", "-m", "external"],
    );

    let event = tokio::time::timeout(Duration::from_secs(3), async move {
        loop {
            let event = rx.recv().await.unwrap();
            match &event.kind {
                EventKind::WorktreeGitStatusUpdated {
                    project_id: event_project_id,
                    worktree_id: event_worktree_id,
                    generation,
                } if event_project_id == &project_id && event_worktree_id == &worktree_id => {
                    return ("git", *generation);
                }
                EventKind::WorktreeFilesUpdated {
                    project_id: event_project_id,
                    worktree_id: event_worktree_id,
                    ..
                } if event_project_id == &project_id && event_worktree_id == &worktree_id => {
                    continue;
                }
                _ => {}
            }
        }
    })
    .await
    .unwrap();

    assert_eq!(event.0, "git");
    assert!(event.1 >= 2);
}
