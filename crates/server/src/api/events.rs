use std::collections::HashMap;
use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::response::sse::{self, Sse};
use futures_util::Stream;
use serde::Deserialize;
use tokio::sync::broadcast;
use utoipa::IntoParams;

use crate::api::settings::load_settings;
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
        EventKind::TabCreated(info) => info.session_id == session_id,
        EventKind::TabClosed { .. } => true,
        EventKind::TabUpdated(info) => info.session_id == session_id,
        EventKind::TabsReordered { .. } => true,
        EventKind::ProjectAdded(_)
        | EventKind::ProjectRemoved { .. }
        | EventKind::ProjectUpdated(_)
        | EventKind::ProjectsReordered(_)
        | EventKind::WorktreeCreated(_)
        | EventKind::WorktreeDeleted { .. }
        | EventKind::WorktreesReordered { .. }
        | EventKind::ProjectWorktreesUpdated { .. }
        | EventKind::SettingsUpdated(_) => true,
    }
}

async fn build_snapshot_event(state: &AppState, session_id: &str) -> sse::Event {
    let mut tabs: Vec<_> = state
        .tabs
        .iter()
        .map(|e| e.value().info())
        .filter(|t| t.session_id == session_id)
        .collect();
    tabs.sort_by(|a, b| {
        a.position
            .partial_cmp(&b.position)
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
    let settings = load_settings(state).await.unwrap_or_default();

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
        settings,
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
