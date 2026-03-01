use std::sync::Arc;

use serde::Serialize;
use tokio::sync::broadcast;

use crate::api::projects::Project;
use crate::pty::live_tab::TabInfo;

/// Typed event envelope. The `kind` field determines the
/// SSE event name and payload shape.
#[derive(Debug, Clone, Serialize)]
pub struct Event {
    #[serde(flatten)]
    pub kind: EventKind,
}

/// Extensible event variants. Add new variants here as
/// features are added (e.g., SessionCreated,
/// ProjectUpdated).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum EventKind {
    /// Full state snapshot, sent on SSE connect and
    /// after lag recovery.
    #[serde(rename = "snapshot")]
    Snapshot {
        tabs: Vec<TabInfo>,
        projects: Vec<Project>,
    },
    /// A new tab was created.
    #[serde(rename = "tab_created")]
    TabCreated(TabInfo),
    /// A tab was closed (shell exit or explicit delete).
    #[serde(rename = "tab_closed")]
    TabClosed { tab_id: String },
    /// A tab's metadata changed (position, label).
    #[serde(rename = "tab_updated")]
    TabUpdated(TabInfo),
    /// A project was added.
    #[serde(rename = "project_added")]
    ProjectAdded(Project),
    /// A project was removed.
    #[serde(rename = "project_removed")]
    ProjectRemoved { project_id: String },
    /// A project's metadata changed (name).
    #[serde(rename = "project_updated")]
    ProjectUpdated(Project),
    /// All projects were reordered.
    #[serde(rename = "projects_reordered")]
    ProjectsReordered(Vec<Project>),
}

impl EventKind {
    /// SSE event name string.
    pub fn event_name(&self) -> &'static str {
        match self {
            EventKind::Snapshot { .. } => "snapshot",
            EventKind::TabCreated(_) => "tab_created",
            EventKind::TabClosed { .. } => "tab_closed",
            EventKind::TabUpdated(_) => "tab_updated",
            EventKind::ProjectAdded(_) => "project_added",
            EventKind::ProjectRemoved { .. } => "project_removed",
            EventKind::ProjectUpdated(_) => "project_updated",
            EventKind::ProjectsReordered(_) => "projects_reordered",
        }
    }
}

/// Broadcast bus for state-sync events. All mutations
/// emit events here; SSE endpoint subscribes.
pub struct EventBus {
    tx: broadcast::Sender<Arc<Event>>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self { tx }
    }

    /// Emit an event to all subscribers.
    pub fn emit(&self, kind: EventKind) {
        let event = Arc::new(Event { kind });
        let _ = self.tx.send(event);
    }

    /// Subscribe for new events.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Event>> {
        self.tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_event_bus_emit_subscribe() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();

        let info = TabInfo {
            id: "t1".into(),
            session_id: "default".into(),
            project_id: "p1".into(),
            label: "Terminal 1".into(),
            tab_type: "terminal".into(),
            position: 1.0,
            created_at: 0,
        };

        bus.emit(EventKind::TabCreated(info.clone()));

        let event = rx.recv().await.unwrap();
        match &event.kind {
            EventKind::TabCreated(t) => {
                assert_eq!(t.id, "t1");
                assert_eq!(t.label, "Terminal 1");
            }
            other => {
                panic!("unexpected event: {:?}", other)
            }
        }
    }

    #[tokio::test]
    async fn test_event_bus_no_subscribers() {
        let bus = EventBus::new();
        // emit with no subscribers should not panic
        bus.emit(EventKind::TabClosed { tab_id: "x".into() });
    }

    #[test]
    fn test_event_kind_names() {
        assert_eq!(
            EventKind::Snapshot {
                tabs: vec![],
                projects: vec![]
            }
            .event_name(),
            "snapshot"
        );
        assert_eq!(
            EventKind::TabClosed { tab_id: "x".into() }.event_name(),
            "tab_closed"
        );
    }
}
