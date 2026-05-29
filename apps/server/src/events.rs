use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::broadcast;
use ts_rs::TS;

use crate::api::keybindings::{KeybindingsState, KeybindingsStatus};
use crate::api::processes::ManagedProcessStatus;
use crate::api::projects::Project;
use crate::api::settings::{Settings, SettingsState, SettingsStatus};
use crate::api::tasks::{TaskInvocationStatus, TaskRemoved, TaskUpdated};
use crate::api::vscode::VscodeStatus;
use crate::api::worktrees::Worktree;
use crate::chat::{
    ChatAppServerStatus, ChatContextUsage, ChatConversationSummary, ChatDiffSummary, ChatItem,
    ChatItemOutput, ChatMessage, ChatPendingRequest, ChatPendingRequestSummary, ChatPlan,
    ChatReconciliation, ChatRun, ChatRuntimeStatus, ChatThreadStreamStatus, ChatTurn,
};
use crate::tab::{TabInfo, WorktreeTabLayout, WorktreeTabLayoutState};
use crate::worktree_state::WorktreeRestoreState;

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
        tab_layouts: HashMap<String, WorktreeTabLayout>,
        worktree_restore_state: HashMap<String, WorktreeRestoreState>,
        chat_app_server: ChatAppServerStatus,
        chat_conversations: Vec<ChatConversationSummary>,
        chat_pending_requests: Vec<ChatPendingRequestSummary>,
        chat_context_usage: Vec<ChatContextUsage>,
        chat_reconciliations: Vec<ChatReconciliation>,
        chat_runtimes: Vec<ChatRuntimeStatus>,
        chat_thread_streams: Vec<ChatThreadStreamStatus>,
        projects: Vec<Project>,
        worktrees: HashMap<String, Vec<Worktree>>,
        project_errors: Box<HashMap<String, String>>,
        settings: Box<Settings>,
        settings_generation: String,
        settings_status: SettingsStatus,
        keybindings: Box<Vec<crate::api::keybindings::KeybindingEntry>>,
        keybindings_generation: String,
        keybindings_status: KeybindingsStatus,
        vscode: Box<VscodeStatus>,
        managed_processes: Vec<ManagedProcessStatus>,
        tasks: Vec<TaskInvocationStatus>,
    },
    #[serde(rename = "tab_created")]
    TabCreated { session_id: String, tab: TabInfo },
    #[serde(rename = "tab_closed")]
    TabClosed { session_id: String, tab_id: String },
    #[serde(rename = "tab_updated")]
    TabUpdated { session_id: String, tab: TabInfo },
    #[serde(rename = "tabs_reordered")]
    TabsReordered {
        session_id: String,
        worktree_id: String,
        tabs: Vec<TabInfo>,
    },
    #[serde(rename = "worktree_tab_layout_updated")]
    WorktreeTabLayoutUpdated {
        worktree_id: String,
        state: Box<WorktreeTabLayoutState>,
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
    #[serde(rename = "worktree_files_updated")]
    WorktreeFilesUpdated {
        project_id: String,
        worktree_id: String,
        generation: u32,
        changed_paths: Vec<String>,
        listing_paths: Vec<String>,
    },
    #[serde(rename = "worktree_git_status_updated")]
    WorktreeGitStatusUpdated {
        project_id: String,
        worktree_id: String,
        generation: u32,
    },
    #[serde(rename = "settings_updated")]
    SettingsUpdated(SettingsState),
    #[serde(rename = "keybindings_updated")]
    KeybindingsUpdated(KeybindingsState),
    #[serde(rename = "vscode_updated")]
    VscodeUpdated(Box<VscodeStatus>),
    #[serde(rename = "managed_process_updated")]
    ManagedProcessUpdated(Box<ManagedProcessStatus>),
    #[serde(rename = "task_updated")]
    TaskUpdated(Box<TaskUpdated>),
    #[serde(rename = "task_removed")]
    TaskRemoved(Box<TaskRemoved>),
    #[serde(rename = "chat_conversation_created")]
    ChatConversationCreated {
        session_id: String,
        conversation: ChatConversationSummary,
    },
    #[serde(rename = "chat_conversation_updated")]
    ChatConversationUpdated {
        session_id: String,
        conversation: ChatConversationSummary,
    },
    #[serde(rename = "chat_conversation_deleted")]
    ChatConversationDeleted {
        session_id: String,
        conversation_id: String,
        project_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch_name: Option<String>,
    },
    #[serde(rename = "chat_runtime_updated")]
    ChatRuntimeUpdated {
        session_id: String,
        runtime: ChatRuntimeStatus,
    },
    #[serde(rename = "chat_app_server_updated")]
    ChatAppServerUpdated { app_server: ChatAppServerStatus },
    #[serde(rename = "chat_thread_stream_updated")]
    ChatThreadStreamUpdated {
        session_id: String,
        stream: ChatThreadStreamStatus,
    },
    #[serde(rename = "chat_message_delta")]
    ChatMessageDelta {
        session_id: String,
        conversation_id: String,
        message_id: String,
        delta: String,
        revision: u64,
    },
    #[serde(rename = "chat_message_updated")]
    ChatMessageUpdated {
        session_id: String,
        conversation_id: String,
        message: ChatMessage,
    },
    #[serde(rename = "chat_run_updated")]
    ChatRunUpdated {
        session_id: String,
        conversation_id: String,
        run: ChatRun,
    },
    #[serde(rename = "chat_turn_updated")]
    ChatTurnUpdated {
        session_id: String,
        conversation_id: String,
        turn: ChatTurn,
    },
    #[serde(rename = "chat_item_updated")]
    ChatItemUpdated {
        session_id: String,
        conversation_id: String,
        item: ChatItem,
    },
    #[serde(rename = "chat_activity_delta")]
    ChatActivityDelta {
        session_id: String,
        conversation_id: String,
        item_id: String,
        output: ChatItemOutput,
    },
    #[serde(rename = "chat_activity_updated")]
    ChatActivityUpdated {
        session_id: String,
        conversation_id: String,
        item: ChatItem,
    },
    #[serde(rename = "chat_pending_request_created")]
    ChatPendingRequestCreated {
        session_id: String,
        request: ChatPendingRequest,
    },
    #[serde(rename = "chat_pending_request_updated")]
    ChatPendingRequestUpdated {
        session_id: String,
        request: ChatPendingRequest,
    },
    #[serde(rename = "chat_pending_request_resolved")]
    ChatPendingRequestResolved {
        session_id: String,
        request: ChatPendingRequest,
    },
    #[serde(rename = "chat_plan_updated")]
    ChatPlanUpdated {
        session_id: String,
        conversation_id: String,
        plan: ChatPlan,
    },
    #[serde(rename = "chat_diff_updated")]
    ChatDiffUpdated {
        session_id: String,
        conversation_id: String,
        diff: ChatDiffSummary,
    },
    #[serde(rename = "chat_context_usage_updated")]
    ChatContextUsageUpdated {
        session_id: String,
        usage: ChatContextUsage,
    },
    #[serde(rename = "chat_reconciliation_started")]
    ChatReconciliationStarted {
        session_id: String,
        reconciliation: ChatReconciliation,
    },
    #[serde(rename = "chat_reconciliation_completed")]
    ChatReconciliationCompleted {
        session_id: String,
        reconciliation: ChatReconciliation,
    },
    #[serde(rename = "chat_reconciliation_failed")]
    ChatReconciliationFailed {
        session_id: String,
        reconciliation: ChatReconciliation,
    },
}

impl EventKind {
    pub fn event_name(&self) -> &'static str {
        match self {
            EventKind::Snapshot { .. } => "snapshot",
            EventKind::TabCreated { .. } => "tab_created",
            EventKind::TabClosed { .. } => "tab_closed",
            EventKind::TabUpdated { .. } => "tab_updated",
            EventKind::TabsReordered { .. } => "tabs_reordered",
            EventKind::WorktreeTabLayoutUpdated { .. } => "worktree_tab_layout_updated",
            EventKind::ProjectAdded(_) => "project_added",
            EventKind::ProjectRemoved { .. } => "project_removed",
            EventKind::ProjectUpdated(_) => "project_updated",
            EventKind::ProjectsReordered(_) => "projects_reordered",
            EventKind::WorktreeCreated(_) => "worktree_created",
            EventKind::WorktreeDeleted { .. } => "worktree_deleted",
            EventKind::WorktreesReordered { .. } => "worktrees_reordered",
            EventKind::ProjectWorktreesUpdated { .. } => "project_worktrees_updated",
            EventKind::WorktreeFilesUpdated { .. } => "worktree_files_updated",
            EventKind::WorktreeGitStatusUpdated { .. } => "worktree_git_status_updated",
            EventKind::SettingsUpdated(_) => "settings_updated",
            EventKind::KeybindingsUpdated(_) => "keybindings_updated",
            EventKind::VscodeUpdated(_) => "vscode_updated",
            EventKind::ManagedProcessUpdated(_) => "managed_process_updated",
            EventKind::TaskUpdated(_) => "task_updated",
            EventKind::TaskRemoved(_) => "task_removed",
            EventKind::ChatConversationCreated { .. } => "chat_conversation_created",
            EventKind::ChatConversationUpdated { .. } => "chat_conversation_updated",
            EventKind::ChatConversationDeleted { .. } => "chat_conversation_deleted",
            EventKind::ChatRuntimeUpdated { .. } => "chat_runtime_updated",
            EventKind::ChatAppServerUpdated { .. } => "chat_app_server_updated",
            EventKind::ChatThreadStreamUpdated { .. } => "chat_thread_stream_updated",
            EventKind::ChatMessageDelta { .. } => "chat_message_delta",
            EventKind::ChatMessageUpdated { .. } => "chat_message_updated",
            EventKind::ChatRunUpdated { .. } => "chat_run_updated",
            EventKind::ChatTurnUpdated { .. } => "chat_turn_updated",
            EventKind::ChatItemUpdated { .. } => "chat_item_updated",
            EventKind::ChatActivityDelta { .. } => "chat_activity_delta",
            EventKind::ChatActivityUpdated { .. } => "chat_activity_updated",
            EventKind::ChatPendingRequestCreated { .. } => "chat_pending_request_created",
            EventKind::ChatPendingRequestUpdated { .. } => "chat_pending_request_updated",
            EventKind::ChatPendingRequestResolved { .. } => "chat_pending_request_resolved",
            EventKind::ChatPlanUpdated { .. } => "chat_plan_updated",
            EventKind::ChatDiffUpdated { .. } => "chat_diff_updated",
            EventKind::ChatContextUsageUpdated { .. } => "chat_context_usage_updated",
            EventKind::ChatReconciliationStarted { .. } => "chat_reconciliation_started",
            EventKind::ChatReconciliationCompleted { .. } => "chat_reconciliation_completed",
            EventKind::ChatReconciliationFailed { .. } => "chat_reconciliation_failed",
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
    use crate::tab::TerminalTabLabels;

    #[tokio::test]
    async fn test_event_bus_emit_subscribe() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();

        let info = TabInfo::Terminal {
            id: "t1".into(),
            session_id: "default".into(),
            worktree_id: "w1".into(),
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
        };

        bus.emit(EventKind::TabCreated {
            session_id: "default".into(),
            tab: info.clone(),
        });

        let event = rx.recv().await.unwrap();
        match &event.kind {
            EventKind::TabCreated { tab: t, .. } => {
                assert_eq!(t.id(), "t1");
                assert_eq!(t.label(), "Terminal 1");
            }
            other => {
                panic!("unexpected event: {:?}", other)
            }
        }
    }

    #[tokio::test]
    async fn test_event_bus_no_subscribers() {
        let bus = EventBus::new();
        bus.emit(EventKind::TabClosed {
            session_id: "default".into(),
            tab_id: "x".into(),
        });
    }

    #[test]
    fn test_event_kind_names() {
        assert_eq!(
            EventKind::Snapshot {
                tabs: vec![],
                tab_layouts: HashMap::new(),
                worktree_restore_state: HashMap::new(),
                chat_app_server: ChatAppServerStatus {
                    lifecycle: crate::chat::ChatAppServerLifecycle::Stopped,
                    last_error: None,
                    updated_at: 0,
                },
                chat_conversations: vec![],
                chat_pending_requests: vec![],
                chat_context_usage: vec![],
                chat_reconciliations: vec![],
                chat_runtimes: vec![],
                chat_thread_streams: vec![],
                projects: vec![],
                worktrees: HashMap::new(),
                project_errors: Box::new(HashMap::new()),
                settings: Box::new(Settings::default()),
                settings_generation: "0".to_string(),
                settings_status: SettingsStatus::ok(),
                keybindings: Box::new(vec![]),
                keybindings_generation: "0".to_string(),
                keybindings_status: KeybindingsStatus::ok(),
                vscode: Box::new(VscodeStatus {
                    selected_runtime: crate::api::settings::VscodeRuntimeKind::VscodeCli,
                    code_server: crate::api::vscode::VscodeRuntimeStatus {
                        supported: true,
                        installed_version: None,
                        process_status: crate::api::vscode::VscodeProcessStatus::Stopped,
                        latest: None,
                        install_progress: None,
                        message: None,
                        active_task_id: None,
                    },
                    vscode_cli: crate::api::vscode::VscodeRuntimeStatus {
                        supported: true,
                        installed_version: None,
                        process_status: crate::api::vscode::VscodeProcessStatus::Stopped,
                        latest: None,
                        install_progress: None,
                        message: None,
                        active_task_id: None,
                    },
                }),
                managed_processes: vec![],
                tasks: vec![],
            }
            .event_name(),
            "snapshot"
        );
        assert_eq!(
            EventKind::TabClosed {
                session_id: "default".into(),
                tab_id: "x".into(),
            }
            .event_name(),
            "tab_closed"
        );
        assert_eq!(
            EventKind::VscodeUpdated(Box::new(VscodeStatus {
                selected_runtime: crate::api::settings::VscodeRuntimeKind::VscodeCli,
                code_server: crate::api::vscode::VscodeRuntimeStatus {
                    supported: true,
                    installed_version: None,
                    process_status: crate::api::vscode::VscodeProcessStatus::Stopped,
                    latest: None,
                    install_progress: None,
                    message: None,
                    active_task_id: None,
                },
                vscode_cli: crate::api::vscode::VscodeRuntimeStatus {
                    supported: true,
                    installed_version: None,
                    process_status: crate::api::vscode::VscodeProcessStatus::Stopped,
                    latest: None,
                    install_progress: None,
                    message: None,
                    active_task_id: None,
                },
            }))
            .event_name(),
            "vscode_updated"
        );
        assert_eq!(
            EventKind::ManagedProcessUpdated(Box::new(ManagedProcessStatus {
                id: "code_server".into(),
                kind: "code-server".into(),
                lifecycle_state: crate::api::processes::ManagedProcessLifecycleStateValue::Stopped,
                pid: None,
                started_at: None,
                last_exit: None,
                last_error: None,
            }))
            .event_name(),
            "managed_process_updated"
        );
        assert_eq!(
            EventKind::TaskRemoved(Box::new(TaskRemoved {
                id: "task-1".into(),
            }))
            .event_name(),
            "task_removed"
        );
    }
}
