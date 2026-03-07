use std::io::Write;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio::sync::oneshot;
use tokio::time::{self, Instant, MissedTickBehavior};
use ts_rs::TS;
use utoipa::{IntoParams, ToSchema};

use crate::pty::live_tab::TerminalSize;
use crate::state::AppState;

const WS_PING_INTERVAL: Duration = Duration::from_secs(15);
const WS_STALE_AFTER: Duration = Duration::from_secs(45);
const WS_PING_PAYLOAD: &[u8] = b"hubris";

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct TerminalParams {
    pub tab_id: String,
    /// Byte offset for resumable reconnection. When
    /// present, the server only replays scrollback bytes
    /// the client missed.
    pub resume_from: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema, TS, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum ClientControlMessage {
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16, visible: bool },
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema, TS, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum ServerControlMessage {
    #[serde(rename = "attached")]
    Attached {
        #[ts(type = "number")]
        byte_offset: u64,
        data_lost: bool,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "pty_resized")]
    PtyResized { cols: u16, rows: u16 },
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

    let attachment = tab.attach(resume_from);
    let (
        attachment_id,
        scrollback,
        current_size,
        byte_offset,
        data_lost,
        mut output_rx,
        mut pty_size_rx,
        mut close_rx,
    ) = (
        attachment.attachment_id,
        attachment.scrollback,
        attachment.current_size,
        attachment.byte_offset,
        attachment.data_lost,
        attachment.output_rx,
        attachment.pty_size_rx,
        attachment.close_rx,
    );
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();

    // Send attach metadata so client can track position
    let attached_msg = serde_json::to_string(&ServerControlMessage::Attached {
        byte_offset,
        data_lost,
        cols: current_size.cols,
        rows: current_size.rows,
    })
    .unwrap();
    if ws_sender
        .send(Message::Text(attached_msg.into()))
        .await
        .is_err()
    {
        tab.detach(attachment_id);
        return;
    }

    // Replay scrollback (missed bytes or full buffer)
    if !scrollback.is_empty()
        && ws_sender
            .send(Message::Binary(scrollback.into()))
            .await
            .is_err()
    {
        tab.detach(attachment_id);
        return;
    }

    // Relay: broadcast -> WS (with close detection
    // and adaptive batching)
    let relay_tab = tab.clone();
    let relay_handle = tokio::spawn(async move {
        let mut shutdown_tx = Some(shutdown_tx);
        let mut ping_interval =
            time::interval_at(Instant::now() + WS_PING_INTERVAL, WS_PING_INTERVAL);
        ping_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

        let signal_shutdown = |shutdown_tx: &mut Option<oneshot::Sender<()>>| {
            if let Some(shutdown_tx) = shutdown_tx.take() {
                let _ = shutdown_tx.send(());
            }
        };

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
                    signal_shutdown(&mut shutdown_tx);
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
                                signal_shutdown(&mut shutdown_tx);
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
                                signal_shutdown(&mut shutdown_tx);
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
                            ::Closed) => {
                            signal_shutdown(&mut shutdown_tx);
                            break;
                        }
                    }
                }
                result = pty_size_rx.recv() => {
                    match result {
                        Ok(size) => {
                            let resized =
                                serde_json::to_string(
                                    &ServerControlMessage::PtyResized {
                                        cols: size.cols,
                                        rows: size.rows,
                                    },
                                )
                                .unwrap();
                            if ws_sender
                                .send(Message::Text(
                                    resized.into(),
                                ))
                                .await
                                .is_err()
                            {
                                signal_shutdown(&mut shutdown_tx);
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!(
                                "ws PTY resize relay lagged, \
                                 dropped {} msgs",
                                n
                            );
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            signal_shutdown(&mut shutdown_tx);
                            break;
                        }
                    }
                }
                _ = ping_interval.tick() => {
                    if relay_tab.attachment_is_stale(
                        attachment_id,
                        Instant::now(),
                        WS_STALE_AFTER,
                    ) {
                        tracing::info!(
                            "expiring stale terminal attachment {} on tab {}",
                            attachment_id,
                            tab_id
                        );
                        signal_shutdown(&mut shutdown_tx);
                        break;
                    }

                    if ws_sender
                        .send(Message::Ping(WS_PING_PAYLOAD.to_vec().into()))
                        .await
                        .is_err()
                    {
                        signal_shutdown(&mut shutdown_tx);
                        break;
                    }
                }
            }
        }
    });

    // WS receiver -> PTY writer + resize
    loop {
        let msg = tokio::select! {
            result = &mut shutdown_rx => {
                let _ = result;
                break;
            }
            next = ws_receiver.next() => {
                match next {
                    Some(Ok(msg)) => msg,
                    Some(Err(_)) | None => break,
                }
            }
        };

        tab.touch_attachment(attachment_id);

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
                        ClientControlMessage::Resize {
                            cols,
                            rows,
                            visible,
                        } => {
                            let size =
                                (cols >= 2 && rows >= 1).then_some(TerminalSize::new(cols, rows));
                            if let Some(size) = size {
                                tab.update_attachment_size(attachment_id, size, visible);
                            } else {
                                tab.invalidate_attachment_size(attachment_id, visible);
                            }
                        }
                    }
                }
            }
            Message::Ping(_) | Message::Pong(_) => {}
            Message::Close(_) => break,
        }
    }

    // Detach only — do NOT kill PTY
    tab.detach(attachment_id);
    relay_handle.abort();
}
