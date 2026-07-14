use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use hubris_server::api::terminal::{ClientControlMessage, ServerControlMessage};
use hubris_server::pty::live_tab::DEFAULT_SCROLLBACK;
use reqwest::StatusCode;
use serde_json::Value;
use tokio::time::timeout;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

pub mod support;

use support::{init_git_repo, start_test_server};

async fn lock_terminal_test() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: tokio::sync::OnceCell<tokio::sync::Mutex<()>> = tokio::sync::OnceCell::const_new();
    LOCK.get_or_init(|| async { tokio::sync::Mutex::new(()) })
        .await
        .lock()
        .await
}

struct ShellEnvGuard {
    original: Option<OsString>,
}

struct HeartbeatTimingEnvGuard {
    ping_interval: Option<OsString>,
    stale_after: Option<OsString>,
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

impl HeartbeatTimingEnvGuard {
    fn install() -> Self {
        let ping_interval = std::env::var_os("HUBRIS_TEST_TERMINAL_WS_PING_INTERVAL_MS");
        let stale_after = std::env::var_os("HUBRIS_TEST_TERMINAL_WS_STALE_AFTER_MS");
        unsafe {
            std::env::set_var("HUBRIS_TEST_TERMINAL_WS_PING_INTERVAL_MS", "50");
            std::env::set_var("HUBRIS_TEST_TERMINAL_WS_STALE_AFTER_MS", "2000");
        }
        Self {
            ping_interval,
            stale_after,
        }
    }
}

impl Drop for HeartbeatTimingEnvGuard {
    fn drop(&mut self) {
        unsafe {
            match &self.ping_interval {
                Some(value) => std::env::set_var("HUBRIS_TEST_TERMINAL_WS_PING_INTERVAL_MS", value),
                None => std::env::remove_var("HUBRIS_TEST_TERMINAL_WS_PING_INTERVAL_MS"),
            }
            match &self.stale_after {
                Some(value) => std::env::set_var("HUBRIS_TEST_TERMINAL_WS_STALE_AFTER_MS", value),
                None => std::env::remove_var("HUBRIS_TEST_TERMINAL_WS_STALE_AFTER_MS"),
            }
        }
    }
}

fn install_quiet_shell(tmp: &tempfile::TempDir) -> ShellEnvGuard {
    let shell_wrapper = tmp.path().join("terminal-shell-wrapper.sh");
    std::fs::write(
        &shell_wrapper,
        r#"#!/bin/sh
while IFS= read -r line; do
  [ -z "$line" ] && continue
  /bin/sh -c "$line"
done
"#,
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = std::fs::metadata(&shell_wrapper).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&shell_wrapper, permissions).unwrap();
    }
    ShellEnvGuard::set(&shell_wrapper)
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
            "worktreeId": worktree_id
        }))
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
        "{}/api/terminal/ws?tabId={}{}",
        base.replacen("http://", "ws://", 1),
        tab_id,
        resume_from
            .map(|resume_from| format!("&resumeFrom={resume_from}"))
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
    let _lock = lock_terminal_test().await;
    let (base, tmp) = start_test_server().await;
    let _shell_guard = install_quiet_shell(&tmp);
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
            assert!(!snapshot);
            assert!(!data_lost);
            assert_eq!(cols, 80);
            assert_eq!(rows, 24);
        }
        other => panic!("expected attached message, got {other:?}"),
    }
}

#[tokio::test]
async fn smallest_visible_client_drives_shared_pty_size() {
    let _lock = lock_terminal_test().await;
    let (base, tmp) = start_test_server().await;
    let _shell_guard = install_quiet_shell(&tmp);
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
            assert!(!snapshot);
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
    let _lock = lock_terminal_test().await;
    let (base, tmp) = start_test_server().await;
    let _shell_guard = install_quiet_shell(&tmp);
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
    let _lock = lock_terminal_test().await;
    let (base, tmp) = start_test_server().await;
    let _shell_guard = install_quiet_shell(&tmp);
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

#[tokio::test]
async fn healthy_client_survives_periodic_server_pings() {
    let _lock = lock_terminal_test().await;
    let _heartbeat_timing = HeartbeatTimingEnvGuard::install();
    let (base, tmp) = start_test_server().await;
    let _shell_guard = install_quiet_shell(&tmp);
    let client = reqwest::Client::new();
    let repo = init_git_repo();

    let project_id = create_project(&client, &base, repo.path().to_str().unwrap()).await;
    let worktree_id = first_worktree_id(&client, &base, &project_id).await;
    let tab = create_tab(&client, &base, &worktree_id).await;
    let tab_id = tab["id"].as_str().unwrap();

    let mut socket = connect_terminal(&base, tab_id).await;
    let _ = next_control_message(&mut socket).await;

    let first_ping = next_ping(&mut socket).await;
    assert_eq!(first_ping, b"hubris");
    socket.send(Message::Pong(first_ping.into())).await.unwrap();

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

#[tokio::test]
async fn stale_smallest_client_expires_and_restores_next_visible_size() {
    let _lock = lock_terminal_test().await;
    let _heartbeat_timing = HeartbeatTimingEnvGuard::install();
    let (base, tmp) = start_test_server().await;
    let _shell_guard = install_quiet_shell(&tmp);
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
        let ping = next_ping(&mut first).await;
        first.send(Message::Pong(ping.into())).await.unwrap();
    }

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
    let _lock = lock_terminal_test().await;
    let (base, tmp) = start_test_server().await;
    let _shell_guard = install_quiet_shell(&tmp);
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
            assert!(!snapshot);
            assert!(!data_lost);
            byte_offset
        }
        other => panic!("expected attached message, got {other:?}"),
    };
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
async fn caught_up_resume_returns_empty_non_snapshot_payload() {
    let _lock = lock_terminal_test().await;
    let (base, tmp) = start_test_server().await;
    let _shell_guard = install_quiet_shell(&tmp);
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
            assert!(!snapshot);
            assert!(!data_lost);
            byte_offset
        }
        other => panic!("expected attached message, got {other:?}"),
    };

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
}

#[tokio::test]
async fn resume_attach_uses_snapshot_when_gap_exceeds_scrollback() {
    let _lock = lock_terminal_test().await;
    let (base, tmp) = start_test_server().await;
    let _shell_guard = install_quiet_shell(&tmp);
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
            assert!(!snapshot);
            assert!(!data_lost);
            byte_offset
        }
        other => panic!("expected attached message, got {other:?}"),
    };
    let overflow_bytes = DEFAULT_SCROLLBACK + 8192;
    send_input(
        &mut first,
        format!("perl -e 'print \"x\" x {overflow_bytes}'\n").as_bytes(),
    )
    .await;
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
