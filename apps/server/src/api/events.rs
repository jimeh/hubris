use std::collections::HashMap;
use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::response::sse::{self, Sse};
use futures_util::Stream;
use serde::Deserialize;
use tokio::sync::broadcast;
use utoipa::IntoParams;

use crate::api::worktrees::list_worktrees_for_project;
use crate::events::{Event, EventKind};
use crate::state::AppState;

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct EventStreamParams {
    #[serde(default = "default_session_id")]
    pub session_id: String,
}

fn default_session_id() -> String {
    "default".to_string()
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
        yield Ok(build_snapshot_event(
            &state, &session_id,
        ).await);

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
                    yield Ok(build_snapshot_event(
                        &state, &session_id,
                    ).await);
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

async fn build_snapshot_event(state: &AppState, session_id: &str) -> sse::Event {
    let mut tabs: Vec<_> = state
        .tabs
        .iter()
        .map(|e| e.value().clone())
        .filter(|t| t.session_id() == session_id)
        .collect();
    tabs.sort_by(|a, b| {
        a.position()
            .partial_cmp(&b.position())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let tab_layouts = state
        .tab_layouts
        .iter()
        .map(|entry| (entry.key().clone(), entry.value().clone()))
        .collect();
    let worktree_restore_state = state
        .restore_state_by_worktree
        .iter()
        .map(|entry| (entry.key().clone(), entry.value().clone()))
        .collect();

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
    sse::Event::default()
        .event("snapshot")
        .data(serde_json::to_string(&snapshot).unwrap())
}

fn snapshot_unavailable_event(scope: &str, message: &str) -> sse::Event {
    tracing::warn!(scope, message, "failed to build SSE snapshot");
    let kind = EventKind::SnapshotUnavailable {
        scope: scope.to_string(),
        message: message.to_string(),
    };
    sse::Event::default()
        .event(kind.event_name())
        .data(serde_json::to_string(&kind).unwrap())
}

fn to_sse_event(event: &Event) -> sse::Event {
    sse::Event::default()
        .event(event.kind.event_name())
        .data(serde_json::to_string(&event.kind).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::{ChatMessage, ChatMessageRole, ChatMessageStatus};
    use crate::tab::{TabInfo, TerminalTabLabels};

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
}
