use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::broadcast;
use ts_rs::TS;

use crate::api::projects::Project;
use crate::api::settings::Settings;
use crate::api::worktrees::Worktree;
use crate::pty::live_tab::TabInfo;

#[derive(Debug, Clone, Serialize)]
pub struct Event {
    #[serde(flatten)]
    pub kind: EventKind,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "type", content = "data")]
pub enum EventKind {
    #[serde(rename = "snapshot")]
    Snapshot {
        tabs: Vec<TabInfo>,
        projects: Vec<Project>,
        worktrees: HashMap<String, Vec<Worktree>>,
        project_errors: HashMap<String, String>,
        settings: Settings,
    },
    #[serde(rename = "tab_created")]
    TabCreated(TabInfo),
    #[serde(rename = "tab_closed")]
    TabClosed { tab_id: String },
    #[serde(rename = "tab_updated")]
    TabUpdated(TabInfo),
    #[serde(rename = "tabs_reordered")]
    TabsReordered {
        worktree_id: String,
        tabs: Vec<TabInfo>,
    },
    #[serde(rename = "project_added")]
    ProjectAdded(Project),
    #[serde(rename = "project_removed")]
    ProjectRemoved { project_id: String },
    #[serde(rename = "project_updated")]
    ProjectUpdated(Project),
    #[serde(rename = "projects_reordered")]
    ProjectsReordered(Vec<Project>),
    #[serde(rename = "worktree_created")]
    WorktreeCreated(Worktree),
    #[serde(rename = "worktree_deleted")]
    WorktreeDeleted {
        project_id: String,
        worktree_id: String,
    },
    #[serde(rename = "worktrees_reordered")]
    WorktreesReordered {
        project_id: String,
        worktrees: Vec<Worktree>,
    },
    #[serde(rename = "project_worktrees_updated")]
    ProjectWorktreesUpdated {
        project_id: String,
        worktrees: Vec<Worktree>,
        git_error: Option<String>,
    },
    #[serde(rename = "settings_updated")]
    SettingsUpdated(Settings),
}

impl EventKind {
    pub fn event_name(&self) -> &'static str {
        match self {
            EventKind::Snapshot { .. } => "snapshot",
            EventKind::TabCreated(_) => "tab_created",
            EventKind::TabClosed { .. } => "tab_closed",
            EventKind::TabUpdated(_) => "tab_updated",
            EventKind::TabsReordered { .. } => "tabs_reordered",
            EventKind::ProjectAdded(_) => "project_added",
            EventKind::ProjectRemoved { .. } => "project_removed",
            EventKind::ProjectUpdated(_) => "project_updated",
            EventKind::ProjectsReordered(_) => "projects_reordered",
            EventKind::WorktreeCreated(_) => "worktree_created",
            EventKind::WorktreeDeleted { .. } => "worktree_deleted",
            EventKind::WorktreesReordered { .. } => "worktrees_reordered",
            EventKind::ProjectWorktreesUpdated { .. } => "project_worktrees_updated",
            EventKind::SettingsUpdated(_) => "settings_updated",
        }
    }
}

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

    pub fn emit(&self, kind: EventKind) {
        let event = Arc::new(Event { kind });
        let _ = self.tx.send(event);
    }

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
            worktree_id: "w1".into(),
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
        bus.emit(EventKind::TabClosed { tab_id: "x".into() });
    }

    #[test]
    fn test_event_kind_names() {
        assert_eq!(
            EventKind::Snapshot {
                tabs: vec![],
                projects: vec![],
                worktrees: HashMap::new(),
                project_errors: HashMap::new(),
                settings: Settings::default(),
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
