use std::io::Write;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use portable_pty::PtySize;
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct TerminalParams {
    pub tab_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ControlMessage {
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
}

pub async fn ws_handler(
    State(state): State<AppState>,
    Query(params): Query<TerminalParams>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    if !state.tabs.contains_key(&params.tab_id) {
        return Err(StatusCode::NOT_FOUND);
    }

    let tab_id = params.tab_id;
    Ok(ws.on_upgrade(move |socket| handle_attach(socket, tab_id, state)))
}

/// Attach to an existing LiveTab. Does NOT spawn a PTY.
/// On WS disconnect, does NOT kill the PTY.
async fn handle_attach(socket: WebSocket, tab_id: String, state: AppState) {
    // Clone Arc out of DashMap to avoid holding shard lock
    let tab = match state.tabs.get(&tab_id).map(|r| r.value().clone()) {
        Some(t) => t,
        None => return,
    };

    let (scrollback, mut output_rx, mut close_rx) = tab.attach();
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Replay scrollback
    if !scrollback.is_empty()
        && ws_sender
            .send(Message::Binary(scrollback.into()))
            .await
            .is_err()
    {
        return;
    }

    // Relay: broadcast -> WS (with close detection
    // and adaptive batching)
    let relay_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = close_rx.recv() => {
                    let _ = ws_sender
                        .send(Message::Text(
                            r#"{"type":"tab_closed"}"#
                                .into(),
                        ))
                        .await;
                    break;
                }
                result = output_rx.recv() => {
                    match result {
                        Ok(data) if data.len() < 128 => {
                            if ws_sender
                                .send(Message::Binary(
                                    data.into(),
                                ))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        Ok(data) => {
                            let mut batch = data;
                            let deadline =
                                tokio::time::sleep(
                                    std::time::Duration
                                        ::from_millis(4),
                                );
                            tokio::pin!(deadline);
                            loop {
                                tokio::select! {
                                    _ = &mut deadline => break,
                                    more = output_rx.recv() => {
                                        match more {
                                            Ok(d) => batch.extend(d),
                                            Err(_) => break,
                                        }
                                    }
                                }
                            }
                            if ws_sender
                                .send(Message::Binary(
                                    batch.into(),
                                ))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError
                            ::Lagged(n)) =>
                        {
                            tracing::warn!(
                                "ws relay lagged, \
                                 dropped {} msgs",
                                n
                            );
                        }
                        Err(broadcast::error::RecvError
                            ::Closed) => break,
                    }
                }
            }
        }
    });

    // WS receiver -> PTY writer + resize
    while let Some(Ok(msg)) = ws_receiver.next().await {
        match msg {
            Message::Binary(data) => {
                let mut writer = tab.pty_writer.lock().unwrap();
                if writer.write_all(&data).is_err() {
                    break;
                }
            }
            Message::Text(text) => {
                if let Ok(ctrl) = serde_json::from_str::<ControlMessage>(&text) {
                    match ctrl {
                        ControlMessage::Resize { cols, rows } => {
                            let master = tab.pty_master.lock().unwrap();
                            let _ = master.resize(PtySize {
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

    // Detach only — do NOT kill PTY
    relay_handle.abort();
}
