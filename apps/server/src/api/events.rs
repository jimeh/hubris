use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use std::time::Instant;

use axum::extract::{Query, State};
use axum::response::sse::{self, Sse};
use futures_util::Stream;
use serde::Deserialize;
use tokio::sync::{Mutex, broadcast};
use utoipa::IntoParams;

use crate::api::worktrees::list_worktrees_for_project;
use crate::events::{Event, EventKind};
use crate::state::AppState;
use crate::util::default_session_id;

const LAGGED_SNAPSHOT_TTL: Duration = Duration::from_secs(1);

pub(crate) struct LaggedSnapshotCache {
    entries: Mutex<HashMap<String, CachedSnapshot>>,
    #[cfg(test)]
    build_count: AtomicU64,
}

struct CachedSnapshot {
    built_at: Instant,
    event: Arc<SnapshotEvent>,
}

struct SnapshotEvent {
    event_name: &'static str,
    data: String,
}

impl Default for LaggedSnapshotCache {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            #[cfg(test)]
            build_count: AtomicU64::new(0),
        }
    }
}

impl LaggedSnapshotCache {
    async fn get_or_build(&self, state: &AppState, session_id: &str) -> Arc<SnapshotEvent> {
        let mut entries = self.entries.lock().await;
        let now = Instant::now();
        entries.retain(|_, cached| now.duration_since(cached.built_at) < LAGGED_SNAPSHOT_TTL);
        if let Some(cached) = entries.get(session_id) {
            return Arc::clone(&cached.event);
        }

        #[cfg(test)]
        self.build_count.fetch_add(1, Ordering::Relaxed);
        let event = Arc::new(build_snapshot_event(state, session_id).await);
        entries.insert(
            session_id.to_string(),
            CachedSnapshot {
                built_at: Instant::now(),
                event: Arc::clone(&event),
            },
        );
        event
    }

    #[cfg(test)]
    fn build_count(&self) -> u64 {
        self.build_count.load(Ordering::Relaxed)
    }
}

impl SnapshotEvent {
    fn to_sse_event(&self) -> sse::Event {
        sse::Event::default()
            .event(self.event_name)
            .data(self.data.clone())
    }
}

#[derive(Debug, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct EventStreamParams {
    #[serde(default = "default_session_id")]
    pub session_id: String,
}

#[utoipa::path(
    get,
    path = "/api/events",
    params(EventStreamParams),
    responses(
        (status = 200, description = "Server-sent event stream"),
    ),
)]
pub async fn event_stream(
    State(state): State<AppState>,
    Query(params): Query<EventStreamParams>,
) -> Sse<impl Stream<Item = Result<sse::Event, Infallible>>> {
    let session_id = params.session_id;
    let mut rx = state.events.subscribe();

    let stream = async_stream::stream! {
        yield Ok(build_snapshot_event(&state, &session_id)
            .await
            .to_sse_event());

        loop {
            match rx.recv().await {
                Ok(event) => {
                    if event_matches_session(
                        &event, &session_id,
                    ) {
                        yield Ok(to_sse_event(&event));
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        "SSE client lagged, \
                         missed {} events",
                        n
                    );
                    let snapshot = state
                        .lagged_snapshot_cache
                        .get_or_build(&state, &session_id)
                        .await;
                    yield Ok(snapshot.to_sse_event());
                }
                Err(broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    };

    Sse::new(stream).keep_alive(sse::KeepAlive::new().interval(Duration::from_secs(30)))
}

fn event_matches_session(event: &Event, session_id: &str) -> bool {
    match &event.kind {
        EventKind::Snapshot { .. } | EventKind::SnapshotUnavailable { .. } => true,
        EventKind::TabCreated {
            session_id: event_session_id,
            ..
        }
        | EventKind::TabClosed {
            session_id: event_session_id,
            ..
        }
        | EventKind::TabUpdated {
            session_id: event_session_id,
            ..
        }
        | EventKind::TabsReordered {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatConversationCreated {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatConversationUpdated {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatConversationDeleted {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatRuntimeUpdated {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatThreadStreamUpdated {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatMessageDelta {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatMessageUpdated {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatRunUpdated {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatTurnUpdated {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatItemUpdated {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatActivityDelta {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatActivityUpdated {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatPendingRequestCreated {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatPendingRequestUpdated {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatPendingRequestResolved {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatPlanUpdated {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatDiffUpdated {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatContextUsageUpdated {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatReconciliationStarted {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatReconciliationCompleted {
            session_id: event_session_id,
            ..
        }
        | EventKind::ChatReconciliationFailed {
            session_id: event_session_id,
            ..
        } => event_session_id == session_id,
        EventKind::WorktreeTabLayoutUpdated { .. } | EventKind::ChatAppServerUpdated { .. } => true,
        EventKind::ProjectAdded(_)
        | EventKind::ProjectRemoved { .. }
        | EventKind::ProjectUpdated(_)
        | EventKind::ProjectsReordered(_)
        | EventKind::WorktreeCreated(_)
        | EventKind::WorktreeDeleted { .. }
        | EventKind::WorktreesReordered { .. }
        | EventKind::ProjectWorktreesUpdated { .. }
        | EventKind::WorktreeFilesUpdated { .. }
        | EventKind::WorktreeGitStatusUpdated { .. }
        | EventKind::SettingsUpdated(_)
        | EventKind::KeybindingsUpdated(_)
        | EventKind::VscodeUpdated(_)
        | EventKind::ManagedProcessUpdated(_)
        | EventKind::TaskUpdated(_)
        | EventKind::TaskRemoved(_) => true,
    }
}

async fn build_snapshot_event(state: &AppState, session_id: &str) -> SnapshotEvent {
    let tabs = state.tabs_service.snapshot_tabs(session_id);
    let tab_layouts = state.tabs_service.snapshot_layouts();
    let worktree_restore_state = state.tabs_service.snapshot_restore_states();

    let projects = state.projects.list().await;

    let mut worktrees = HashMap::new();
    let project_errors = HashMap::new();
    let settings = state.settings.get().await;
    let keybindings = state.keybindings.get().await;
    let chat_conversations = match state.chats.list_session_conversations(session_id).await {
        Ok(value) => value,
        Err(error) => return snapshot_unavailable_event("chat_conversations", &error.message),
    };
    let chat_app_server = state.chats.app_server_status().await;
    let chat_pending_requests = match state
        .chats
        .list_session_pending_request_summaries(session_id)
        .await
    {
        Ok(value) => value,
        Err(error) => return snapshot_unavailable_event("chat_pending_requests", &error.message),
    };
    let chat_context_usage = match state.chats.list_session_context_usage(session_id).await {
        Ok(value) => value,
        Err(error) => return snapshot_unavailable_event("chat_context_usage", &error.message),
    };
    let chat_reconciliations = match state.chats.list_session_reconciliations(session_id).await {
        Ok(value) => value,
        Err(error) => return snapshot_unavailable_event("chat_reconciliations", &error.message),
    };
    let chat_runtimes = match state.chats.list_runtime_statuses(session_id).await {
        Ok(value) => value,
        Err(error) => return snapshot_unavailable_event("chat_runtimes", &error.message),
    };
    let chat_thread_streams = match state.chats.list_thread_stream_statuses(session_id).await {
        Ok(value) => value,
        Err(error) => return snapshot_unavailable_event("chat_thread_streams", &error.message),
    };
    let vscode = state.vscode.status().await.into();
    let managed_processes = state
        .processes
        .list()
        .await
        .unwrap_or_default()
        .into_iter()
        .map(Into::into)
        .collect::<Vec<_>>();
    let tasks = state
        .tasks
        .list_broadcastable()
        .await
        .into_iter()
        .map(Into::into)
        .collect::<Vec<_>>();

    for project in &projects {
        let list = list_worktrees_for_project(state, project).await;
        worktrees.insert(project.id.clone(), list);
    }

    let snapshot = EventKind::Snapshot {
        tabs,
        tab_layouts,
        worktree_restore_state,
        chat_app_server,
        chat_conversations,
        chat_pending_requests,
        chat_context_usage,
        chat_reconciliations,
        chat_runtimes,
        chat_thread_streams,
        projects,
        worktrees,
        project_errors: Box::new(project_errors),
        settings: Box::new(settings.settings),
        settings_generation: settings.generation,
        settings_status: settings.status,
        keybindings: Box::new(keybindings.keybindings),
        keybindings_generation: keybindings.generation,
        keybindings_status: keybindings.status,
        vscode: Box::new(vscode),
        managed_processes,
        tasks,
    };
    SnapshotEvent {
        event_name: "snapshot",
        data: serde_json::to_string(&snapshot).unwrap(),
    }
}

fn snapshot_unavailable_event(scope: &str, message: &str) -> SnapshotEvent {
    tracing::warn!(scope, message, "failed to build SSE snapshot");
    let kind = EventKind::SnapshotUnavailable {
        scope: scope.to_string(),
        message: message.to_string(),
    };
    SnapshotEvent {
        event_name: kind.event_name(),
        data: serde_json::to_string(&kind).unwrap(),
    }
}

fn to_sse_event(event: &Event) -> sse::Event {
    sse::Event::default()
        .event(event.kind.event_name())
        .data(serde_json::to_string(&event.kind).unwrap())
}

#[cfg(test)]
mod tests {
    use axum::body::BodyDataStream;
    use axum::extract::{Query, State};
    use axum::response::IntoResponse;
    use futures_util::StreamExt;
    use tempfile::TempDir;

    use super::*;
    use crate::chat::{ChatMessage, ChatMessageRole, ChatMessageStatus};
    use crate::tab::{TabInfo, TerminalTabLabels};

    fn take_sse_event_name(buffer: &mut Vec<u8>) -> Option<String> {
        let separator = buffer
            .windows(2)
            .position(|window| window == b"\n\n")
            .map(|index| (index, 2))
            .or_else(|| {
                buffer
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .map(|index| (index, 4))
            })?;
        let raw = buffer
            .drain(..separator.0 + separator.1)
            .collect::<Vec<_>>();
        let text = String::from_utf8(raw).unwrap();
        text.lines()
            .find_map(|line| line.strip_prefix("event:").map(str::trim))
            .map(str::to_string)
    }

    async fn next_sse_event_name(stream: &mut BodyDataStream, buffer: &mut Vec<u8>) -> String {
        loop {
            if let Some(event_name) = take_sse_event_name(buffer) {
                return event_name;
            }
            let chunk = tokio::time::timeout(Duration::from_secs(2), stream.next())
                .await
                .expect("timed out waiting for SSE data")
                .expect("SSE stream ended")
                .expect("SSE body failed");
            buffer.extend_from_slice(&chunk);
        }
    }

    fn make_terminal_tab(session_id: &str) -> TabInfo {
        TabInfo::Terminal {
            id: "tab-1".into(),
            session_id: session_id.into(),
            worktree_id: "worktree-1".into(),
            pane_id: "pane-1".into(),
            label: "Terminal 1".into(),
            position: 1.0,
            created_at: 0,
            preview: false,
            has_notification: false,
            labels: TerminalTabLabels {
                custom_label: None,
                smart_label: None,
                title_label: None,
            },
        }
    }

    #[test]
    fn tab_events_only_match_their_own_session() {
        let event = Event {
            kind: EventKind::TabsReordered {
                session_id: "session-a".into(),
                worktree_id: "worktree-1".into(),
                tabs: vec![make_terminal_tab("session-a")],
            },
        };

        assert!(event_matches_session(&event, "session-a"));
        assert!(!event_matches_session(&event, "session-b"));
    }

    #[test]
    fn tab_closed_only_matches_its_session() {
        let event = Event {
            kind: EventKind::TabClosed {
                session_id: "session-a".into(),
                tab_id: "tab-1".into(),
            },
        };

        assert!(event_matches_session(&event, "session-a"));
        assert!(!event_matches_session(&event, "session-b"));
    }

    #[test]
    fn chat_events_only_match_their_own_session() {
        let event = Event {
            kind: EventKind::ChatMessageUpdated {
                session_id: "session-a".into(),
                conversation_id: "chat-1".into(),
                message: ChatMessage {
                    id: "message-1".into(),
                    conversation_id: "chat-1".into(),
                    turn_id: None,
                    item_id: None,
                    provider_turn_id: None,
                    provider_item_id: None,
                    role: ChatMessageRole::Assistant,
                    status: ChatMessageStatus::Completed,
                    content_text: "ready".into(),
                    reasoning_text: String::new(),
                    sequence: 1,
                    created_at: 0,
                    updated_at: 0,
                },
            },
        };

        assert!(event_matches_session(&event, "session-a"));
        assert!(!event_matches_session(&event, "session-b"));
    }

    #[tokio::test]
    async fn lagged_consumers_share_one_cached_snapshot_build() {
        let tmp = TempDir::new().unwrap();
        let state = AppState::new(tmp.path().to_path_buf()).await;
        let first = event_stream(
            State(state.clone()),
            Query(EventStreamParams {
                session_id: "default".into(),
            }),
        )
        .await;
        let second = event_stream(
            State(state.clone()),
            Query(EventStreamParams {
                session_id: "default".into(),
            }),
        )
        .await;
        let mut delivery_probe = state.events.subscribe();

        for index in 0..257 {
            state.events.emit(EventKind::ProjectRemoved {
                project_id: format!("project-{index}"),
            });
        }
        loop {
            match delivery_probe.recv().await {
                Ok(event)
                    if matches!(
                        &event.kind,
                        EventKind::ProjectRemoved { project_id }
                            if project_id == "project-256"
                    ) =>
                {
                    break;
                }
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => panic!("event bus closed"),
            }
        }

        let mut first_stream = first.into_response().into_body().into_data_stream();
        let mut second_stream = second.into_response().into_body().into_data_stream();
        let mut first_buffer = Vec::new();
        let mut second_buffer = Vec::new();

        assert_eq!(
            next_sse_event_name(&mut first_stream, &mut first_buffer).await,
            "snapshot"
        );
        assert_eq!(
            next_sse_event_name(&mut second_stream, &mut second_buffer).await,
            "snapshot"
        );
        assert_eq!(
            next_sse_event_name(&mut first_stream, &mut first_buffer).await,
            "snapshot"
        );
        assert_eq!(
            next_sse_event_name(&mut second_stream, &mut second_buffer).await,
            "snapshot"
        );
        assert_eq!(state.lagged_snapshot_cache.build_count(), 1);
    }
}
