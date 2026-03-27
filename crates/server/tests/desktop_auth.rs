use std::path::Path;
use std::process::Command;
use std::time::Duration;

use futures_util::StreamExt;
use hubris_server::api::terminal::ServerControlMessage;
use hubris_server::{
    AppState, DESKTOP_BOOTSTRAP_PATH, DesktopAccess, FrontendAssets, ServerAccess, ServerOptions,
    build_router_with_options,
};
use reqwest::StatusCode;
use serde_json::Value;
use tempfile::TempDir;
use tokio::time::timeout;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

async fn start_test_server(options: ServerOptions) -> (String, TempDir) {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    let state = AppState::new(data_dir).await;
    let app = build_router_with_options(state, options);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (format!("http://{}", addr), tmp)
}

fn packaged_options(root: &Path, session_token: &str, bootstrap_token: &str) -> ServerOptions {
    let assets = root.join("dist");
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::write(
        assets.join("index.html"),
        "<!doctype html><html><body>desktop auth</body></html>",
    )
    .unwrap();

    ServerOptions {
        frontend: FrontendAssets::from_dir(assets).unwrap(),
        access: ServerAccess::DesktopLocked(DesktopAccess::packaged(
            session_token,
            bootstrap_token,
        )),
    }
}

fn api_only_options(root: &Path, session_token: &str) -> ServerOptions {
    let assets = root.join("dist");
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::write(
        assets.join("index.html"),
        "<!doctype html><html><body>api only</body></html>",
    )
    .unwrap();

    ServerOptions {
        frontend: FrontendAssets::from_dir(assets).unwrap(),
        access: ServerAccess::DesktopLocked(DesktopAccess::api_only(session_token)),
    }
}

fn init_git_repo() -> TempDir {
    let repo = TempDir::new().unwrap();
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
        .current_dir(repo_path)
        .arg("-c")
        .arg("commit.gpgsign=false")
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git failed: {:?}", args);
}

fn cookie_pair(response: &reqwest::Response) -> String {
    response
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

async fn create_project(client: &reqwest::Client, base: &str, cookie: &str, path: &str) -> String {
    let response = client
        .post(format!("{base}/api/projects"))
        .header(reqwest::header::COOKIE, cookie)
        .json(&serde_json::json!({ "path": path }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let body: Value = response.json().await.unwrap();
    body["id"].as_str().unwrap().to_string()
}

async fn first_worktree_id(
    client: &reqwest::Client,
    base: &str,
    cookie: &str,
    project_id: &str,
) -> String {
    let response = client
        .get(format!("{base}/api/projects/{project_id}/worktrees"))
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    body["worktrees"][0]["id"].as_str().unwrap().to_string()
}

async fn create_tab(
    client: &reqwest::Client,
    base: &str,
    cookie: &str,
    worktree_id: &str,
) -> String {
    let response = client
        .post(format!("{base}/api/tabs"))
        .header(reqwest::header::COOKIE, cookie)
        .json(&serde_json::json!({ "worktree_id": worktree_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let body: Value = response.json().await.unwrap();
    body["id"].as_str().unwrap().to_string()
}

async fn next_control_message(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> ServerControlMessage {
    timeout(Duration::from_secs(5), async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Text(text))) => {
                    if let Ok(message) = serde_json::from_str::<ServerControlMessage>(&text) {
                        return message;
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => panic!("websocket error: {error}"),
                None => panic!("websocket closed before control message"),
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn packaged_desktop_blocks_unauthenticated_requests() {
    let temp = TempDir::new().unwrap();
    let (base, _server_tmp) = start_test_server(packaged_options(
        temp.path(),
        "session-token",
        "bootstrap-token",
    ))
    .await;
    let client = reqwest::Client::new();

    let frontend = client.get(&base).send().await.unwrap();
    assert_eq!(frontend.status(), StatusCode::UNAUTHORIZED);

    let api = client
        .get(format!("{base}/api/projects"))
        .send()
        .await
        .unwrap();
    assert_eq!(api.status(), StatusCode::UNAUTHORIZED);

    let events = client
        .get(format!("{base}/api/events?session_id=default"))
        .send()
        .await
        .unwrap();
    assert_eq!(events.status(), StatusCode::UNAUTHORIZED);

    let ws_url = format!(
        "{}/api/terminal/ws?tab_id=missing",
        base.replacen("http://", "ws://", 1)
    );
    let error = connect_async(ws_url).await.unwrap_err();
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        other => panic!("expected websocket handshake failure, got {other}"),
    }
}

#[tokio::test]
async fn packaged_desktop_bootstrap_is_one_time_and_authenticates_http_sse_and_ws() {
    let temp = TempDir::new().unwrap();
    let bootstrap_token = "bootstrap-token";
    let (base, _server_tmp) = start_test_server(packaged_options(
        temp.path(),
        "session-token",
        bootstrap_token,
    ))
    .await;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();

    let bootstrap = client
        .get(format!(
            "{base}{DESKTOP_BOOTSTRAP_PATH}?token={bootstrap_token}"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(bootstrap.status(), StatusCode::FOUND);
    assert_eq!(bootstrap.headers()["location"], "/");
    assert_eq!(bootstrap.headers()["cache-control"], "no-store");
    let cookie = cookie_pair(&bootstrap);

    let replay = client
        .get(format!(
            "{base}{DESKTOP_BOOTSTRAP_PATH}?token={bootstrap_token}"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);

    let frontend = client
        .get(&base)
        .header(reqwest::header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(frontend.status(), StatusCode::OK);
    assert!(frontend.text().await.unwrap().contains("desktop auth"));

    let projects = client
        .get(format!("{base}/api/projects"))
        .header(reqwest::header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(projects.status(), StatusCode::OK);

    let events = client
        .get(format!("{base}/api/events?session_id=default"))
        .header(reqwest::header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(events.status(), StatusCode::OK);
    assert_eq!(events.headers()["content-type"], "text/event-stream");

    let repo = init_git_repo();
    let project_id = create_project(&client, &base, &cookie, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &cookie, &project_id).await;
    let tab_id = create_tab(&client, &base, &cookie, &worktree_id).await;

    let ws_url = format!(
        "{}/api/terminal/ws?tab_id={tab_id}",
        base.replacen("http://", "ws://", 1)
    );
    let mut request = ws_url.into_client_request().unwrap();
    request.headers_mut().insert(
        "Cookie",
        tokio_tungstenite::tungstenite::http::HeaderValue::from_str(&cookie).unwrap(),
    );
    let (mut socket, _) = connect_async(request).await.unwrap();

    let attached = next_control_message(&mut socket).await;
    assert!(matches!(attached, ServerControlMessage::Attached { .. }));
}

#[tokio::test]
async fn invalid_bootstrap_token_is_rejected() {
    let temp = TempDir::new().unwrap();
    let (base, _server_tmp) = start_test_server(packaged_options(
        temp.path(),
        "session-token",
        "bootstrap-token",
    ))
    .await;
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{base}{DESKTOP_BOOTSTRAP_PATH}?token=wrong-token"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn api_only_desktop_mode_leaves_frontend_unprotected_but_locks_api() {
    let temp = TempDir::new().unwrap();
    let (base, _server_tmp) =
        start_test_server(api_only_options(temp.path(), "session-token")).await;
    let client = reqwest::Client::new();

    let frontend = client.get(&base).send().await.unwrap();
    assert_eq!(frontend.status(), StatusCode::OK);

    let api = client
        .get(format!("{base}/api/projects"))
        .send()
        .await
        .unwrap();
    assert_eq!(api.status(), StatusCode::UNAUTHORIZED);
}
