use std::path::Path;
use std::process::Command;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use hubris_server::api::terminal::{ClientControlMessage, ServerControlMessage};
use hubris_server::pty::live_tab::DEFAULT_SCROLLBACK;
use hubris_server::{AppState, build_router};
use reqwest::StatusCode;
use serde_json::Value;
use tokio::time::timeout;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

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
        .current_dir(repo_path)
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
        .json(&serde_json::json!({ "worktree_id": worktree_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    res.json().await.unwrap()
}

async fn connect_terminal(
    base: &str,
    tab_id: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    connect_terminal_with_resume(base, tab_id, None).await
}

async fn connect_terminal_with_resume(
    base: &str,
    tab_id: &str,
    resume_from: Option<u64>,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let ws_url = format!(
        "{}/api/terminal/ws?tab_id={}{}",
        base.replacen("http://", "ws://", 1),
        tab_id,
        resume_from
            .map(|resume_from| format!("&resume_from={resume_from}"))
            .unwrap_or_default()
    );
    let (socket, _) = connect_async(ws_url).await.unwrap();
    socket
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

async fn next_ws_message(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Message {
    timeout(Duration::from_secs(5), async {
        match socket.next().await {
            Some(Ok(message)) => message,
            Some(Err(error)) => panic!("websocket error: {error}"),
            None => panic!("websocket closed before next message"),
        }
    })
    .await
    .unwrap()
}

async fn next_ping(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Vec<u8> {
    loop {
        match next_ws_message(socket).await {
            Message::Ping(payload) => return payload.to_vec(),
            Message::Text(text) => {
                if let Ok(control) = serde_json::from_str::<ServerControlMessage>(&text) {
                    panic!("expected ping, got control message: {control:?}");
                }
            }
            Message::Close(frame) => panic!("websocket closed before ping: {frame:?}"),
            _ => {}
        }
    }
}

async fn next_control_message_while_ponging(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> ServerControlMessage {
    loop {
        match next_ws_message(socket).await {
            Message::Ping(payload) => {
                socket.send(Message::Pong(payload)).await.unwrap();
            }
            Message::Text(text) => {
                if let Ok(message) = serde_json::from_str::<ServerControlMessage>(&text) {
                    return message;
                }
            }
            Message::Close(frame) => panic!("websocket closed before control message: {frame:?}"),
            _ => {}
        }
    }
}

async fn send_resize(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    cols: u16,
    rows: u16,
    visible: bool,
) {
    let message = serde_json::to_string(&ClientControlMessage::Resize {
        cols,
        rows,
        visible,
    })
    .unwrap();
    socket.send(Message::Text(message.into())).await.unwrap();
}

async fn send_input(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    input: &[u8],
) {
    socket
        .send(Message::Binary(input.to_vec().into()))
        .await
        .unwrap();
}

async fn read_binary_bytes(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    minimum: usize,
) -> usize {
    timeout(Duration::from_secs(5), async {
        let mut total = 0;
        while total < minimum {
            match next_ws_message(socket).await {
                Message::Binary(data) => total += data.len(),
                Message::Ping(payload) => {
                    socket.send(Message::Pong(payload)).await.unwrap();
                }
                Message::Text(text) => {
                    if let Ok(control) = serde_json::from_str::<ServerControlMessage>(&text) {
                        panic!("expected binary output, got control message: {control:?}");
                    }
                }
                Message::Close(frame) => panic!("websocket closed before binary output: {frame:?}"),
                _ => {}
            }
        }
        total
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn attached_message_includes_current_pty_size() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;
    let tab = create_tab(&client, &base, &worktree_id).await;
    let tab_id = tab["id"].as_str().unwrap();

    let mut socket = connect_terminal(&base, tab_id).await;
    let attached = next_control_message(&mut socket).await;

    match attached {
        ServerControlMessage::Attached {
            snapshot,
            data_lost,
            cols,
            rows,
            ..
        } => {
            assert!(snapshot);
            assert!(!data_lost);
            assert_eq!(cols, 80);
            assert_eq!(rows, 24);
        }
        other => panic!("expected attached message, got {other:?}"),
    }
}

#[tokio::test]
async fn smallest_visible_client_drives_shared_pty_size() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;
    let tab = create_tab(&client, &base, &worktree_id).await;
    let tab_id = tab["id"].as_str().unwrap();

    let mut first = connect_terminal(&base, tab_id).await;
    let _ = next_control_message(&mut first).await;

    send_resize(&mut first, 120, 40, true).await;
    assert_eq!(
        next_control_message(&mut first).await,
        ServerControlMessage::PtyResized {
            cols: 120,
            rows: 40
        }
    );

    let mut second = connect_terminal(&base, tab_id).await;
    match next_control_message(&mut second).await {
        ServerControlMessage::Attached {
            snapshot,
            data_lost,
            cols,
            rows,
            ..
        } => {
            assert!(snapshot);
            assert!(!data_lost);
            assert_eq!(cols, 120);
            assert_eq!(rows, 40);
        }
        other => panic!("expected attached message, got {other:?}"),
    }

    send_resize(&mut second, 90, 30, true).await;
    assert_eq!(
        next_control_message(&mut first).await,
        ServerControlMessage::PtyResized { cols: 90, rows: 30 }
    );
    assert_eq!(
        next_control_message(&mut second).await,
        ServerControlMessage::PtyResized { cols: 90, rows: 30 }
    );
}

#[tokio::test]
async fn invalid_resize_drops_client_from_shared_size_calculation() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;
    let tab = create_tab(&client, &base, &worktree_id).await;
    let tab_id = tab["id"].as_str().unwrap();

    let mut first = connect_terminal(&base, tab_id).await;
    let _ = next_control_message(&mut first).await;
    send_resize(&mut first, 120, 40, true).await;
    let _ = next_control_message(&mut first).await;

    let mut second = connect_terminal(&base, tab_id).await;
    let _ = next_control_message(&mut second).await;
    send_resize(&mut second, 90, 30, true).await;
    let _ = next_control_message(&mut first).await;
    let _ = next_control_message(&mut second).await;

    send_resize(&mut second, 1, 0, true).await;

    assert_eq!(
        next_control_message(&mut first).await,
        ServerControlMessage::PtyResized {
            cols: 120,
            rows: 40
        }
    );
    assert_eq!(
        next_control_message(&mut second).await,
        ServerControlMessage::PtyResized {
            cols: 120,
            rows: 40
        }
    );
}

#[tokio::test]
async fn disconnecting_smallest_client_restores_next_visible_size() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;
    let tab = create_tab(&client, &base, &worktree_id).await;
    let tab_id = tab["id"].as_str().unwrap();

    let mut first = connect_terminal(&base, tab_id).await;
    let _ = next_control_message(&mut first).await;
    send_resize(&mut first, 120, 40, true).await;
    let _ = next_control_message(&mut first).await;

    let mut second = connect_terminal(&base, tab_id).await;
    let _ = next_control_message(&mut second).await;
    send_resize(&mut second, 90, 30, true).await;
    let _ = next_control_message(&mut first).await;
    let _ = next_control_message(&mut second).await;

    second.close(None).await.unwrap();

    assert_eq!(
        next_control_message(&mut first).await,
        ServerControlMessage::PtyResized {
            cols: 120,
            rows: 40
        }
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn healthy_client_survives_periodic_server_pings() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;
    let tab = create_tab(&client, &base, &worktree_id).await;
    let tab_id = tab["id"].as_str().unwrap();

    let mut socket = connect_terminal(&base, tab_id).await;
    let _ = next_control_message(&mut socket).await;

    tokio::time::advance(Duration::from_secs(15)).await;
    let first_ping = next_ping(&mut socket).await;
    assert_eq!(first_ping, b"hubris");
    socket.send(Message::Pong(first_ping.into())).await.unwrap();

    tokio::time::advance(Duration::from_secs(15)).await;
    let second_ping = next_ping(&mut socket).await;
    assert_eq!(second_ping, b"hubris");
    socket
        .send(Message::Pong(second_ping.into()))
        .await
        .unwrap();

    send_resize(&mut socket, 100, 30, true).await;
    assert_eq!(
        next_control_message(&mut socket).await,
        ServerControlMessage::PtyResized {
            cols: 100,
            rows: 30
        }
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn stale_smallest_client_expires_and_restores_next_visible_size() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;
    let tab = create_tab(&client, &base, &worktree_id).await;
    let tab_id = tab["id"].as_str().unwrap();

    let mut first = connect_terminal(&base, tab_id).await;
    let _ = next_control_message(&mut first).await;
    send_resize(&mut first, 120, 40, true).await;
    let _ = next_control_message(&mut first).await;

    let mut second = connect_terminal(&base, tab_id).await;
    let _ = next_control_message(&mut second).await;
    send_resize(&mut second, 90, 30, true).await;
    let _ = next_control_message(&mut first).await;
    let _ = next_control_message(&mut second).await;

    for _ in 0..2 {
        tokio::time::advance(Duration::from_secs(15)).await;
        let ping = next_ping(&mut first).await;
        first.send(Message::Pong(ping.into())).await.unwrap();
    }

    tokio::time::advance(Duration::from_secs(15)).await;
    assert_eq!(
        next_control_message_while_ponging(&mut first).await,
        ServerControlMessage::PtyResized {
            cols: 120,
            rows: 40
        }
    );
}

#[tokio::test]
async fn resume_attach_uses_raw_delta_when_gap_fits_scrollback() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;
    let tab = create_tab(&client, &base, &worktree_id).await;
    let tab_id = tab["id"].as_str().unwrap();

    let mut first = connect_terminal(&base, tab_id).await;
    let base_offset = match next_control_message(&mut first).await {
        ServerControlMessage::Attached {
            byte_offset,
            snapshot,
            data_lost,
            ..
        } => {
            assert!(snapshot);
            assert!(!data_lost);
            byte_offset
        }
        other => panic!("expected attached message, got {other:?}"),
    };
    let _ = read_binary_bytes(&mut first, 1).await;

    send_input(&mut first, b"printf 'hubris-resume'\n").await;
    let _ = read_binary_bytes(&mut first, 1).await;

    let mut resumed = connect_terminal_with_resume(&base, tab_id, Some(base_offset)).await;
    match next_control_message(&mut resumed).await {
        ServerControlMessage::Attached {
            snapshot,
            data_lost,
            ..
        } => {
            assert!(!snapshot);
            assert!(!data_lost);
        }
        other => panic!("expected attached message, got {other:?}"),
    }
    assert!(read_binary_bytes(&mut resumed, 1).await > 0);
}

#[tokio::test]
async fn resume_attach_uses_snapshot_when_gap_exceeds_scrollback() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;
    let tab = create_tab(&client, &base, &worktree_id).await;
    let tab_id = tab["id"].as_str().unwrap();

    let mut first = connect_terminal(&base, tab_id).await;
    let base_offset = match next_control_message(&mut first).await {
        ServerControlMessage::Attached {
            byte_offset,
            snapshot,
            data_lost,
            ..
        } => {
            assert!(snapshot);
            assert!(!data_lost);
            byte_offset
        }
        other => panic!("expected attached message, got {other:?}"),
    };
    let _ = read_binary_bytes(&mut first, 1).await;

    send_input(&mut first, b"perl -e 'print \"x\" x 150000'\n").await;
    assert!(read_binary_bytes(&mut first, DEFAULT_SCROLLBACK + 1).await > DEFAULT_SCROLLBACK);

    let mut resumed = connect_terminal_with_resume(&base, tab_id, Some(base_offset)).await;
    match next_control_message(&mut resumed).await {
        ServerControlMessage::Attached {
            snapshot,
            data_lost,
            ..
        } => {
            assert!(snapshot);
            assert!(data_lost);
        }
        other => panic!("expected attached message, got {other:?}"),
    }
    assert!(read_binary_bytes(&mut resumed, 1).await > 0);
}
