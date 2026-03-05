use std::io::Write;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use portable_pty::PtySize;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use ts_rs::TS;
use utoipa::{IntoParams, ToSchema};

use crate::state::AppState;

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct TerminalParams {
    pub tab_id: String,
    /// Byte offset for resumable reconnection. When
    /// present, the server only replays scrollback bytes
    /// the client missed.
    pub resume_from: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema, TS)]
#[serde(tag = "type")]
pub enum ClientControlMessage {
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema, TS)]
#[serde(tag = "type")]
pub enum ServerControlMessage {
    #[serde(rename = "attached")]
    Attached {
        #[ts(type = "number")]
        byte_offset: u64,
        data_lost: bool,
    },
    #[serde(rename = "tab_closed")]
    TabClosed,
}

#[utoipa::path(
    get,
    path = "/api/terminal/ws",
    params(TerminalParams),
    responses(
        (status = 101, description = "WebSocket upgraded"),
        (status = 404, description = "Tab not found"),
    ),
)]
pub async fn ws_handler(
    State(state): State<AppState>,
    Query(params): Query<TerminalParams>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    if !state.tabs.contains_key(&params.tab_id) {
        return Err(StatusCode::NOT_FOUND);
    }

    let tab_id = params.tab_id;
    let resume_from = params.resume_from;
    Ok(ws.on_upgrade(move |socket| handle_attach(socket, tab_id, resume_from, state)))
}

/// Attach to an existing LiveTab. Does NOT spawn a PTY.
/// On WS disconnect, does NOT kill the PTY.
async fn handle_attach(
    socket: WebSocket,
    tab_id: String,
    resume_from: Option<u64>,
    state: AppState,
) {
    // Clone Arc out of DashMap to avoid holding shard lock
    let tab = match state.tabs.get(&tab_id).map(|r| r.value().clone()) {
        Some(t) => t,
        None => return,
    };

    let (scrollback, byte_offset, data_lost, mut output_rx, mut close_rx) = tab.attach(resume_from);
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Send attach metadata so client can track position
    let attached_msg = serde_json::to_string(&ServerControlMessage::Attached {
        byte_offset,
        data_lost,
    })
    .unwrap();
    if ws_sender
        .send(Message::Text(attached_msg.into()))
        .await
        .is_err()
    {
        return;
    }

    // Replay scrollback (missed bytes or full buffer)
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
                    let tab_closed =
                        serde_json::to_string(
                            &ServerControlMessage::TabClosed,
                        )
                        .unwrap();
                    let _ = ws_sender
                        .send(Message::Text(
                            tab_closed.into(),
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
                if let Ok(ctrl) = serde_json::from_str::<ClientControlMessage>(&text) {
                    match ctrl {
                        ClientControlMessage::Resize { cols, rows } => {
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
