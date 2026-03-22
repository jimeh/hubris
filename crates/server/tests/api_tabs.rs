use std::ffi::OsString;
use std::path::Path;
use std::process::Command;
use std::sync::LazyLock;
use std::time::Duration;

use hubris_server::events::EventKind;
use hubris_server::{AppState, build_router};
use reqwest::StatusCode;
use serde_json::Value;
use tokio::sync::Mutex;

static TERMINAL_TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

async fn start_test_server() -> (String, tempfile::TempDir) {
    let (base, tmp, _state) = start_test_server_with_state().await;
    (base, tmp)
}

async fn lock_terminal_test() -> tokio::sync::MutexGuard<'static, ()> {
    TERMINAL_TEST_LOCK.lock().await
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
        .json(&serde_json::json!({
            "type": "terminal",
            "worktree_id": worktree_id
        }))
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

struct ShellEnvGuard {
    original: Option<OsString>,
}

impl ShellEnvGuard {
    fn set(value: &Path) -> Self {
        let original = std::env::var_os("SHELL");
        unsafe {
            std::env::set_var("SHELL", value);
        }
        Self { original }
    }
}

impl Drop for ShellEnvGuard {
    fn drop(&mut self) {
        unsafe {
            match &self.original {
                Some(value) => std::env::set_var("SHELL", value),
                None => std::env::remove_var("SHELL"),
            }
        }
    }
}

#[tokio::test]
async fn test_list_tabs_empty() {
    let _lock = lock_terminal_test().await;
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
    let _lock = lock_terminal_test().await;
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
    let _lock = lock_terminal_test().await;
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .post(format!("{}/api/tabs", base))
        .json(&serde_json::json!({
            "type": "terminal",
            "worktree_id": "nonexistent"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_create_tab_for_external_non_managed_worktree_returns_not_found() {
    let _lock = lock_terminal_test().await;
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
        .json(&serde_json::json!({
            "type": "terminal",
            "worktree_id": external_id
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_delete_project_cascades_tabs() {
    let _lock = lock_terminal_test().await;
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
    let _lock = lock_terminal_test().await;
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
    let _lock = lock_terminal_test().await;
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
    let _lock = lock_terminal_test().await;
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
    let _lock = lock_terminal_test().await;
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
async fn test_reorder_tabs_emits_session_scoped_event() {
    let _lock = lock_terminal_test().await;
    let (base, _tmp, state) = start_test_server_with_state().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;

    let t1 = create_tab(&client, &base, &worktree_id).await;
    let t2 = create_tab(&client, &base, &worktree_id).await;
    let id1 = t1["id"].as_str().unwrap();
    let id2 = t2["id"].as_str().unwrap();
    let mut rx = state.events.subscribe();

    let res = client
        .put(format!("{}/api/tabs/reorder", base))
        .json(&serde_json::json!({
            "worktree_id": worktree_id,
            "tab_ids": [id2, id1]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let event = tokio::time::timeout(Duration::from_secs(3), async move {
        loop {
            let event = rx.recv().await.unwrap();
            if let EventKind::TabsReordered {
                session_id,
                worktree_id: reordered_worktree_id,
                tabs,
            } = &event.kind
            {
                break (
                    session_id.clone(),
                    reordered_worktree_id.clone(),
                    tabs.iter()
                        .map(|tab| tab.id().to_string())
                        .collect::<Vec<_>>(),
                );
            }
        }
    })
    .await
    .unwrap();

    assert_eq!(event.0, "default");
    assert_eq!(event.1, worktree_id);
    assert_eq!(event.2, vec![id2.to_string(), id1.to_string()]);
}

#[tokio::test]
async fn test_reorder_tabs_rejects_mixed_sessions() {
    let _lock = lock_terminal_test().await;
    let (base, _tmp, state) = start_test_server_with_state().await;
    let client = reqwest::Client::new();

    state.tabs.insert(
        "tab-a".into(),
        hubris_server::tab::TabInfo::Terminal {
            id: "tab-a".into(),
            session_id: "session-a".into(),
            worktree_id: "w1".into(),
            label: "Terminal 1".into(),
            position: 1.0,
            created_at: 0,
            preview: false,
        },
    );
    state.tabs.insert(
        "tab-b".into(),
        hubris_server::tab::TabInfo::Terminal {
            id: "tab-b".into(),
            session_id: "session-b".into(),
            worktree_id: "w1".into(),
            label: "Terminal 2".into(),
            position: 2.0,
            created_at: 0,
            preview: false,
        },
    );

    let res = client
        .put(format!("{}/api/tabs/reorder", base))
        .json(&serde_json::json!({
            "worktree_id": "w1",
            "tab_ids": ["tab-b", "tab-a"]
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_reorder_tabs_wrong_ids() {
    let _lock = lock_terminal_test().await;
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
    let _lock = lock_terminal_test().await;
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

#[tokio::test]
async fn test_immediately_exiting_terminal_emits_created_then_closed() {
    let _lock = lock_terminal_test().await;
    let (base, tmp, state) = start_test_server_with_state().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();
    let exit_marker = repo.path().join(".hubris-exit-shell");

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;
    std::fs::write(&exit_marker, "").unwrap();
    let shell_wrapper = tmp.path().join("shell-wrapper.sh");
    std::fs::write(
        &shell_wrapper,
        format!(
            "#!/bin/sh\nif [ -f \"{}\" ]; then\n  exit 0\nfi\nexec /bin/sh \"$@\"\n",
            exit_marker.display()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = std::fs::metadata(&shell_wrapper).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&shell_wrapper, permissions).unwrap();
    }

    let mut rx = state.events.subscribe();
    let _shell_guard = ShellEnvGuard::set(&shell_wrapper);

    let tab = create_tab(&client, &base, &worktree_id).await;
    let tab_id = tab["id"].as_str().unwrap().to_string();

    let event_sequence = tokio::time::timeout(Duration::from_secs(3), async move {
        let mut sequence = Vec::new();
        while sequence.len() < 2 {
            let event = rx.recv().await.unwrap();
            match &event.kind {
                EventKind::TabCreated {
                    session_id,
                    tab: info,
                } if info.id() == tab_id && session_id == "default" => {
                    sequence.push("created");
                }
                EventKind::TabClosed {
                    session_id,
                    tab_id: closed_tab_id,
                } if *closed_tab_id == tab_id && session_id == "default" => {
                    sequence.push("closed");
                }
                _ => {}
            }
        }
        sequence
    })
    .await
    .unwrap();

    assert_eq!(event_sequence, vec!["created", "closed"]);
}
