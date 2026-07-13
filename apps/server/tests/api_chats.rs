use std::path::Path;
use std::process::Command;

use hubris_server::{AppState, build_router};
use reqwest::StatusCode;
use serde_json::Value;

struct ChatFixture {
    conversation_id: String,
    tab_id: String,
}

async fn start_test_server() -> (String, tempfile::TempDir) {
    let tmp = tempfile::TempDir::new().unwrap();
    std::fs::write(
        tmp.path().join("settings.toml"),
        "[experimental]\nchatEnabled = true\n",
    )
    .unwrap();

    let state = AppState::new(tmp.path().to_path_buf()).await;
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (format!("http://{addr}"), tmp)
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
    assert!(status.success(), "git failed: {args:?}");
}

async fn create_project(client: &reqwest::Client, base: &str, repo: &Path) -> Value {
    let response = client
        .post(format!("{base}/api/projects"))
        .json(&serde_json::json!({
            "path": repo.to_string_lossy(),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    response.json().await.unwrap()
}

async fn list_worktrees(client: &reqwest::Client, base: &str, project_id: &str) -> Vec<Value> {
    let response = client
        .get(format!("{base}/api/projects/{project_id}/worktrees"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    body["worktrees"].as_array().unwrap().clone()
}

async fn create_worktree(
    client: &reqwest::Client,
    base: &str,
    project_id: &str,
    branch: &str,
) -> Value {
    let response = client
        .post(format!("{base}/api/projects/{project_id}/worktrees"))
        .json(&serde_json::json!({ "branch": branch }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    response.json().await.unwrap()
}

async fn create_chat(client: &reqwest::Client, base: &str, worktree_id: &str) -> ChatFixture {
    let response = client
        .post(format!("{base}/api/tabs"))
        .json(&serde_json::json!({
            "type": "agent_chat",
            "worktreeId": worktree_id,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["type"], "agent_chat");

    ChatFixture {
        conversation_id: body["conversationId"].as_str().unwrap().to_string(),
        tab_id: body["id"].as_str().unwrap().to_string(),
    }
}

async fn get_chat(
    client: &reqwest::Client,
    base: &str,
    conversation_id: &str,
) -> reqwest::Response {
    client
        .get(format!(
            "{base}/api/chats/{conversation_id}?sessionId=default"
        ))
        .send()
        .await
        .unwrap()
}

async fn list_chats(
    client: &reqwest::Client,
    base: &str,
    project_id: &str,
    worktree_id: &str,
    query: &str,
) -> Vec<Value> {
    let response = client
        .get(format!(
            "{base}/api/projects/{project_id}/worktrees/{worktree_id}/chats?{query}"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response.json().await.unwrap()
}

#[tokio::test]
async fn create_chat_and_fetch_detail() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();
    let project = create_project(&client, &base, repo.path()).await;
    let project_id = project["id"].as_str().unwrap();
    let worktrees = list_worktrees(&client, &base, project_id).await;
    let worktree_id = worktrees[0]["id"].as_str().unwrap();

    let chat = create_chat(&client, &base, worktree_id).await;
    let response = get_chat(&client, &base, &chat.conversation_id).await;

    assert_eq!(response.status(), StatusCode::OK);
    let detail: Value = response.json().await.unwrap();
    assert_eq!(detail["conversation"]["id"], chat.conversation_id);
    assert_eq!(detail["conversation"]["sessionId"], "default");
    assert_eq!(detail["conversation"]["projectId"], project_id);
    assert_eq!(detail["conversation"]["worktreeId"], worktree_id);
    assert_eq!(detail["conversation"]["branchName"], "local");
    assert_eq!(detail["conversation"]["openTabId"], chat.tab_id);
    assert_eq!(detail["messages"], serde_json::json!([]));
}

#[tokio::test]
async fn list_chats_is_scoped_by_session_project_and_branch() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();
    let project = create_project(&client, &base, repo.path()).await;
    let project_id = project["id"].as_str().unwrap();
    let local_worktree = &list_worktrees(&client, &base, project_id).await[0];
    let local_worktree_id = local_worktree["id"].as_str().unwrap();
    let feature_worktree = create_worktree(&client, &base, project_id, "feature/chat").await;
    let feature_worktree_id = feature_worktree["id"].as_str().unwrap();

    let local_chat = create_chat(&client, &base, local_worktree_id).await;
    let feature_chat = create_chat(&client, &base, feature_worktree_id).await;

    let local = list_chats(
        &client,
        &base,
        project_id,
        local_worktree_id,
        "sessionId=default",
    )
    .await;
    assert_eq!(local.len(), 1);
    assert_eq!(local[0]["id"], local_chat.conversation_id);

    let feature = list_chats(
        &client,
        &base,
        project_id,
        feature_worktree_id,
        "sessionId=default",
    )
    .await;
    assert_eq!(feature.len(), 1);
    assert_eq!(feature[0]["id"], feature_chat.conversation_id);

    let project = list_chats(
        &client,
        &base,
        project_id,
        local_worktree_id,
        "sessionId=default&scope=project",
    )
    .await;
    assert_eq!(project.len(), 2);

    let other_session = list_chats(
        &client,
        &base,
        project_id,
        local_worktree_id,
        "sessionId=other",
    )
    .await;
    assert!(other_session.is_empty());
}

#[tokio::test]
async fn update_chat_settings_persists_values() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();
    let project = create_project(&client, &base, repo.path()).await;
    let project_id = project["id"].as_str().unwrap();
    let worktrees = list_worktrees(&client, &base, project_id).await;
    let chat = create_chat(&client, &base, worktrees[0]["id"].as_str().unwrap()).await;

    let response = client
        .patch(format!(
            "{base}/api/chats/{}/settings?sessionId=default",
            chat.conversation_id
        ))
        .json(&serde_json::json!({
            "selectedModel": "gpt-5.5-codex",
            "selectedEffort": "high",
            "selectedPermissionMode": "full_access",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let updated: Value = response.json().await.unwrap();
    assert_eq!(updated["selectedModel"], "gpt-5.5-codex");
    assert_eq!(updated["selectedEffort"], "high");
    assert_eq!(updated["selectedPermissionMode"], "full_access");

    let response = get_chat(&client, &base, &chat.conversation_id).await;
    assert_eq!(response.status(), StatusCode::OK);
    let detail: Value = response.json().await.unwrap();
    let conversation = &detail["conversation"];
    assert_eq!(conversation["selectedModel"], "gpt-5.5-codex");
    assert_eq!(conversation["selectedEffort"], "high");
    assert_eq!(conversation["selectedPermissionMode"], "full_access");
}

#[tokio::test]
async fn archive_rejects_messages_and_unarchive_restores_settings_writes() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();
    let project = create_project(&client, &base, repo.path()).await;
    let project_id = project["id"].as_str().unwrap();
    let worktrees = list_worktrees(&client, &base, project_id).await;
    let chat = create_chat(&client, &base, worktrees[0]["id"].as_str().unwrap()).await;

    let response = client
        .post(format!(
            "{base}/api/chats/{}/archive?sessionId=default",
            chat.conversation_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let archived: Value = response.json().await.unwrap();
    assert!(archived["archivedAt"].is_u64());

    let response = client
        .post(format!(
            "{base}/api/chats/{}/messages?sessionId=default",
            chat.conversation_id
        ))
        .json(&serde_json::json!({ "text": "must not run" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let error: Value = response.json().await.unwrap();
    assert_eq!(error["message"], "chat is archived");

    let hidden = list_chats(
        &client,
        &base,
        project_id,
        worktrees[0]["id"].as_str().unwrap(),
        "sessionId=default",
    )
    .await;
    assert!(hidden.is_empty());

    let response = client
        .post(format!(
            "{base}/api/chats/{}/unarchive?sessionId=default",
            chat.conversation_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let unarchived: Value = response.json().await.unwrap();
    assert!(unarchived.get("archivedAt").is_none());

    let response = client
        .patch(format!(
            "{base}/api/chats/{}/settings?sessionId=default",
            chat.conversation_id
        ))
        .json(&serde_json::json!({
            "selectedModel": "gpt-5.5-codex",
            "selectedEffort": null,
            "selectedPermissionMode": null,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn delete_chat_removes_conversation_and_open_tab() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();
    let project = create_project(&client, &base, repo.path()).await;
    let project_id = project["id"].as_str().unwrap();
    let worktrees = list_worktrees(&client, &base, project_id).await;
    let chat = create_chat(&client, &base, worktrees[0]["id"].as_str().unwrap()).await;

    let response = client
        .delete(format!(
            "{base}/api/chats/{}?sessionId=default",
            chat.conversation_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    let response = get_chat(&client, &base, &chat.conversation_id).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let response = client
        .get(format!("{base}/api/tabs?sessionId=default"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let tabs: Vec<Value> = response.json().await.unwrap();
    assert!(tabs.iter().all(|tab| tab["id"] != chat.tab_id));

    let response = client
        .delete(format!(
            "{base}/api/chats/{}?sessionId=default",
            chat.conversation_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
