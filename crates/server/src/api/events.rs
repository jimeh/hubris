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
        EventKind::Snapshot { .. } => true,
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
        } => event_session_id == session_id,
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
        | EventKind::CodeServerUpdated(_) => true,
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

    let mut projects = state.load_projects().await.unwrap_or_default();
    projects.sort_by(|a, b| {
        a.position
            .partial_cmp(&b.position)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut worktrees = HashMap::new();
    let mut project_errors = HashMap::new();
    let settings = state.settings.get().await;
    let code_server = state.code_server.status().await.into();

    for project in &projects {
        match list_worktrees_for_project(state, project).await {
            Ok(list) => {
                worktrees.insert(project.id.clone(), list);
            }
            Err(err) => {
                worktrees.insert(project.id.clone(), vec![]);
                project_errors.insert(project.id.clone(), err.clone());
            }
        }
    }

    let snapshot = EventKind::Snapshot {
        tabs,
        projects,
        worktrees,
        project_errors,
        settings: Box::new(settings.settings),
        settings_generation: settings.generation,
        settings_status: settings.status,
        code_server: Box::new(code_server),
    };
    sse::Event::default()
        .event("snapshot")
        .data(serde_json::to_string(&snapshot).unwrap())
}

fn to_sse_event(event: &Event) -> sse::Event {
    sse::Event::default()
        .event(event.kind.event_name())
        .data(serde_json::to_string(&event.kind).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tab::TabInfo;

    fn make_terminal_tab(session_id: &str) -> TabInfo {
        TabInfo::Terminal {
            id: "tab-1".into(),
            session_id: session_id.into(),
            worktree_id: "worktree-1".into(),
            label: "Terminal 1".into(),
            position: 1.0,
            created_at: 0,
            preview: false,
            has_notification: false,
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
}
