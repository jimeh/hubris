use std::io::{Read, Write};

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::Deserialize;
use tokio::sync::mpsc;

use crate::api::projects::Project;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct TerminalParams {
    pub project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ControlMessage {
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
}

async fn load_projects(state: &AppState) -> Result<Vec<Project>, std::io::Error> {
    let path = state.projects_file();
    match tokio::fs::read_to_string(&path).await {
        Ok(contents) => {
            let projects: Vec<Project> = serde_json::from_str(&contents).unwrap_or_default();
            Ok(projects)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e),
    }
}

pub async fn ws_handler(
    State(state): State<AppState>,
    Query(params): Query<TerminalParams>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    let projects = load_projects(&state)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let project = projects
        .iter()
        .find(|p| p.id == params.project_id)
        .ok_or(StatusCode::NOT_FOUND)?;
    let cwd = project.path.clone();
    Ok(ws.on_upgrade(move |socket| handle_terminal(socket, cwd, state)))
}

async fn handle_terminal(socket: WebSocket, cwd: String, _state: AppState) {
    let pty_system = NativePtySystem::default();

    let pair = match pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(pair) => pair,
        Err(e) => {
            tracing::error!("failed to open pty: {}", e);
            return;
        }
    };

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");

    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(child) => child,
        Err(e) => {
            tracing::error!("failed to spawn shell: {}", e);
            return;
        }
    };

    // Drop slave — we interact via the master side
    drop(pair.slave);

    let master = pair.master;
    let mut reader = master.try_clone_reader().unwrap();
    let mut writer = master.take_writer().unwrap();

    let (ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(8);

    // PTY reader → channel (blocking I/O in spawn_blocking)
    let reader_handle = tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Channel → WebSocket sender with adaptive batching
    let sender_handle = tokio::spawn(async move {
        let mut ws_sender = ws_sender;
        while let Some(data) = rx.recv().await {
            if data.len() < 128 {
                // Small output: send immediately
                if ws_sender.send(Message::Binary(data.into())).await.is_err() {
                    break;
                }
            } else {
                // Larger output: batch with short timer
                let mut batch = data;
                let deadline = tokio::time::sleep(std::time::Duration::from_millis(4));
                tokio::pin!(deadline);
                loop {
                    tokio::select! {
                        _ = &mut deadline => break,
                        more = rx.recv() => {
                            match more {
                                Some(more_data) => {
                                    batch.extend(
                                        more_data,
                                    );
                                }
                                None => break,
                            }
                        }
                    }
                }
                if ws_sender.send(Message::Binary(batch.into())).await.is_err() {
                    break;
                }
            }
        }
    });

    // WebSocket → PTY writer
    let master_for_resize = master;
    while let Some(Ok(msg)) = ws_receiver.next().await {
        match msg {
            Message::Binary(data) => {
                if writer.write_all(&data).is_err() {
                    break;
                }
            }
            Message::Text(text) => {
                if let Ok(ctrl) = serde_json::from_str::<ControlMessage>(&text) {
                    match ctrl {
                        ControlMessage::Resize { cols, rows } => {
                            let _ = master_for_resize.resize(PtySize {
                                rows,
                                cols,
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                        }
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Cleanup
    sender_handle.abort();
    reader_handle.abort();
    let _ = child.kill();
    let _ = child.wait();
}
