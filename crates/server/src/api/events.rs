use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::response::sse::{self, Sse};
use futures_util::Stream;
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::events::{Event, EventKind};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct EventStreamParams {
    /// Session to subscribe to. Only events for tabs
    /// in this session are delivered.
    #[serde(default = "default_session_id")]
    pub session_id: String,
}

fn default_session_id() -> String {
    "default".to_string()
}

pub async fn event_stream(
    State(state): State<AppState>,
    Query(params): Query<EventStreamParams>,
) -> Sse<impl Stream<Item = Result<sse::Event, Infallible>>> {
    let session_id = params.session_id;
    let mut rx = state.events.subscribe();

    let stream = async_stream::stream! {
        // Send snapshot on connect (session-filtered)
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

/// Check if an event belongs to the given session.
fn event_matches_session(event: &Event, session_id: &str) -> bool {
    match &event.kind {
        EventKind::Snapshot { .. } => true,
        EventKind::TabCreated(info) => info.session_id == session_id,
        EventKind::TabClosed { .. } => {
            // TabClosed doesn't carry session_id, so
            // always forward. Frontend ignores unknown IDs.
            true
        }
        EventKind::TabUpdated(info) => info.session_id == session_id,
        // Project events are session-independent
        EventKind::ProjectAdded(_)
        | EventKind::ProjectRemoved { .. }
        | EventKind::ProjectUpdated(_)
        | EventKind::ProjectsReordered(_) => true,
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

    let snapshot = Event {
        kind: EventKind::Snapshot { tabs, projects },
    };
    sse::Event::default()
        .event("snapshot")
        .data(serde_json::to_string(&snapshot).unwrap())
}

fn to_sse_event(event: &Event) -> sse::Event {
    sse::Event::default()
        .event(event.kind.event_name())
        .data(serde_json::to_string(event).unwrap())
}
