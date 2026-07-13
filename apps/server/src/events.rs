use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{broadcast, mpsc};
use tokio::time::{self, MissedTickBehavior};
use tokio_util::sync::CancellationToken;
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
#[serde(tag = "type", content = "data", rename_all_fields = "camelCase")]
pub enum EventKind {
    #[serde(rename = "snapshot")]
    Snapshot {
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        build_id: Option<String>,
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
    /// Sent instead of `snapshot` when the server fails to assemble the
    /// initial snapshot. Clients should surface the failure and offer a
    /// reconnect/retry instead of silently showing empty state.
    #[serde(rename = "snapshot_unavailable")]
    SnapshotUnavailable {
        /// Which part of the snapshot failed to load (e.g.
        /// `chat_conversations`).
        scope: String,
        /// Human-readable failure description.
        message: String,
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

/// Defines `EventKind::event_name` and `EventKind::EVENT_NAMES` from a single
/// variant-to-name mapping. The generated `match` is exhaustive, so adding an
/// `EventKind` variant without extending this mapping is a compile error, and
/// the name list can never drift from `event_name`.
macro_rules! event_kind_names {
    ($($variant:ident => $name:literal),+ $(,)?) => {
        impl EventKind {
            /// Every SSE event name, in variant declaration order. This is
            /// the source for the generated frontend event-name registry
            /// (`SSE_EVENT_NAMES` in `sse.generated.ts`).
            pub const EVENT_NAMES: &'static [&'static str] = &[$($name),+];

            /// SSE event name for this event. Must match the serde `type`
            /// tag; `tests::event_names_match_serde_tags` enforces this.
            pub fn event_name(&self) -> &'static str {
                match self {
                    $(EventKind::$variant { .. } => $name,)+
                }
            }
        }
    };
}

event_kind_names! {
    Snapshot => "snapshot",
    SnapshotUnavailable => "snapshot_unavailable",
    TabCreated => "tab_created",
    TabClosed => "tab_closed",
    TabUpdated => "tab_updated",
    TabsReordered => "tabs_reordered",
    WorktreeTabLayoutUpdated => "worktree_tab_layout_updated",
    ProjectAdded => "project_added",
    ProjectRemoved => "project_removed",
    ProjectUpdated => "project_updated",
    ProjectsReordered => "projects_reordered",
    WorktreeCreated => "worktree_created",
    WorktreeDeleted => "worktree_deleted",
    WorktreesReordered => "worktrees_reordered",
    ProjectWorktreesUpdated => "project_worktrees_updated",
    WorktreeFilesUpdated => "worktree_files_updated",
    WorktreeGitStatusUpdated => "worktree_git_status_updated",
    SettingsUpdated => "settings_updated",
    KeybindingsUpdated => "keybindings_updated",
    VscodeUpdated => "vscode_updated",
    ManagedProcessUpdated => "managed_process_updated",
    TaskUpdated => "task_updated",
    TaskRemoved => "task_removed",
    ChatConversationCreated => "chat_conversation_created",
    ChatConversationUpdated => "chat_conversation_updated",
    ChatConversationDeleted => "chat_conversation_deleted",
    ChatRuntimeUpdated => "chat_runtime_updated",
    ChatAppServerUpdated => "chat_app_server_updated",
    ChatThreadStreamUpdated => "chat_thread_stream_updated",
    ChatMessageDelta => "chat_message_delta",
    ChatMessageUpdated => "chat_message_updated",
    ChatRunUpdated => "chat_run_updated",
    ChatTurnUpdated => "chat_turn_updated",
    ChatItemUpdated => "chat_item_updated",
    ChatActivityDelta => "chat_activity_delta",
    ChatActivityUpdated => "chat_activity_updated",
    ChatPendingRequestCreated => "chat_pending_request_created",
    ChatPendingRequestUpdated => "chat_pending_request_updated",
    ChatPendingRequestResolved => "chat_pending_request_resolved",
    ChatPlanUpdated => "chat_plan_updated",
    ChatDiffUpdated => "chat_diff_updated",
    ChatContextUsageUpdated => "chat_context_usage_updated",
    ChatReconciliationStarted => "chat_reconciliation_started",
    ChatReconciliationCompleted => "chat_reconciliation_completed",
    ChatReconciliationFailed => "chat_reconciliation_failed",
}

pub struct EventBus {
    queue_tx: mpsc::UnboundedSender<EventKind>,
    tx: broadcast::Sender<Arc<Event>>,
}

const COALESCE_INTERVAL: Duration = Duration::from_millis(25);
const MAX_MERGED_DELTAS: usize = 64;

struct BufferedDelta {
    kind: EventKind,
    merged_count: usize,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus {
    /// Creates an event bus with a cancellation token owned by the bus task.
    pub fn new() -> Self {
        Self::new_with_cancellation(CancellationToken::new())
    }

    /// Creates an event bus whose coalescer stops when `cancellation_token` is
    /// cancelled.
    pub fn new_with_cancellation(cancellation_token: CancellationToken) -> Self {
        let (queue_tx, queue_rx) = mpsc::unbounded_channel();
        let (tx, _) = broadcast::channel(256);
        tokio::spawn(run_coalescer(queue_rx, tx.clone(), cancellation_token));
        Self { queue_tx, tx }
    }

    /// Queues an event for ordered, non-blocking delivery to subscribers.
    pub fn emit(&self, kind: EventKind) {
        let _ = self.queue_tx.send(kind);
    }

    /// Subscribes to coalesced events emitted after this call.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Event>> {
        self.tx.subscribe()
    }
}

async fn run_coalescer(
    mut queue_rx: mpsc::UnboundedReceiver<EventKind>,
    tx: broadcast::Sender<Arc<Event>>,
    cancellation_token: CancellationToken,
) {
    let mut buffered: Option<BufferedDelta> = None;
    let mut flush_interval = None;

    loop {
        if buffered.is_none() {
            tokio::select! {
                _ = cancellation_token.cancelled() => break,
                event = queue_rx.recv() => {
                    let Some(event) = event else {
                        break;
                    };
                    process_event(event, &tx, &mut buffered);
                    if buffered.is_some() {
                        flush_interval = Some(new_flush_interval());
                    }
                }
            }
            continue;
        }

        let Some(interval) = flush_interval.as_mut() else {
            flush_interval = Some(new_flush_interval());
            continue;
        };
        tokio::select! {
            _ = cancellation_token.cancelled() => break,
            event = queue_rx.recv() => {
                let Some(event) = event else {
                    break;
                };
                process_event(event, &tx, &mut buffered);
                if buffered.is_none() {
                    flush_interval = None;
                }
            }
            _ = interval.tick() => {
                flush_buffered(&tx, &mut buffered);
                flush_interval = None;
            }
        }
    }

    flush_buffered(&tx, &mut buffered);
}

fn new_flush_interval() -> time::Interval {
    let start = time::Instant::now() + COALESCE_INTERVAL;
    let mut interval = time::interval_at(start, COALESCE_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    interval
}

fn process_event(
    event: EventKind,
    tx: &broadcast::Sender<Arc<Event>>,
    buffered: &mut Option<BufferedDelta>,
) {
    let Some(current) = buffered.as_mut() else {
        if is_coalescable(&event) {
            *buffered = Some(BufferedDelta {
                kind: event,
                merged_count: 1,
            });
        } else {
            send_event(tx, event);
        }
        return;
    };

    let mut event = Some(event);
    if merge_delta(&mut current.kind, event.as_mut()) {
        current.merged_count += 1;
        if current.merged_count >= MAX_MERGED_DELTAS {
            flush_buffered(tx, buffered);
        }
        return;
    }

    flush_buffered(tx, buffered);
    let Some(event) = event else {
        return;
    };
    if is_coalescable(&event) {
        *buffered = Some(BufferedDelta {
            kind: event,
            merged_count: 1,
        });
    } else {
        send_event(tx, event);
    }
}

fn is_coalescable(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::ChatMessageDelta { .. } | EventKind::ChatActivityDelta { .. }
    )
}

fn merge_delta(current: &mut EventKind, incoming: Option<&mut EventKind>) -> bool {
    match (current, incoming) {
        (
            EventKind::ChatMessageDelta {
                conversation_id,
                message_id,
                delta,
                revision,
                ..
            },
            Some(EventKind::ChatMessageDelta {
                conversation_id: incoming_conversation_id,
                message_id: incoming_message_id,
                delta: incoming_delta,
                revision: incoming_revision,
                ..
            }),
        ) if *conversation_id == *incoming_conversation_id
            && *message_id == *incoming_message_id =>
        {
            delta.push_str(incoming_delta);
            *revision = *incoming_revision;
            true
        }
        (
            EventKind::ChatActivityDelta {
                conversation_id,
                item_id,
                output,
                ..
            },
            Some(EventKind::ChatActivityDelta {
                conversation_id: incoming_conversation_id,
                item_id: incoming_item_id,
                output: incoming_output,
                ..
            }),
        ) if *conversation_id == *incoming_conversation_id
            && *item_id == *incoming_item_id
            && output.stream_kind == incoming_output.stream_kind =>
        {
            output.content_text.push_str(&incoming_output.content_text);
            output.byte_count = output.byte_count.saturating_add(incoming_output.byte_count);
            output.updated_at = incoming_output.updated_at;
            true
        }
        _ => false,
    }
}

fn flush_buffered(tx: &broadcast::Sender<Arc<Event>>, buffered: &mut Option<BufferedDelta>) {
    if let Some(buffered) = buffered.take() {
        send_event(tx, buffered.kind);
    }
}

fn send_event(tx: &broadcast::Sender<Arc<Event>>, kind: EventKind) {
    let _ = tx.send(Arc::new(Event { kind }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tab::TerminalTabLabels;

    fn message_delta(conversation_id: &str, message_id: &str, delta: &str) -> EventKind {
        EventKind::ChatMessageDelta {
            session_id: "default".into(),
            conversation_id: conversation_id.into(),
            message_id: message_id.into(),
            delta: delta.into(),
            revision: 1,
        }
    }

    fn activity_delta(
        conversation_id: &str,
        item_id: &str,
        stream_kind: &str,
        delta: &str,
        sequence: u32,
    ) -> EventKind {
        EventKind::ChatActivityDelta {
            session_id: "default".into(),
            conversation_id: conversation_id.into(),
            item_id: item_id.into(),
            output: ChatItemOutput {
                id: format!("output-{sequence}"),
                conversation_id: conversation_id.into(),
                item_id: item_id.into(),
                stream_kind: stream_kind.into(),
                sequence,
                content_text: delta.into(),
                byte_count: delta.len() as u32,
                created_at: sequence as u64,
                updated_at: sequence as u64,
            },
        }
    }

    fn separator_event(id: &str) -> EventKind {
        EventKind::ProjectRemoved {
            project_id: id.into(),
        }
    }

    async fn recv_event(rx: &mut broadcast::Receiver<Arc<Event>>) -> Arc<Event> {
        time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("timed out waiting for event")
            .expect("event bus closed")
    }

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

    #[tokio::test]
    async fn consecutive_same_key_message_deltas_merge() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();

        bus.emit(message_delta("chat-1", "message-1", "hello "));
        bus.emit(message_delta("chat-1", "message-1", "world"));
        bus.emit(separator_event("separator"));

        let event = recv_event(&mut rx).await;
        assert!(matches!(
            &event.kind,
            EventKind::ChatMessageDelta { delta, .. } if delta == "hello world"
        ));
    }

    #[tokio::test]
    async fn non_delta_between_message_deltas_preserves_order_and_prevents_merge() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();

        bus.emit(message_delta("chat-1", "message-1", "first"));
        bus.emit(separator_event("between"));
        bus.emit(message_delta("chat-1", "message-1", "second"));
        bus.emit(separator_event("after"));

        let mut observed = Vec::new();
        for _ in 0..4 {
            let event = recv_event(&mut rx).await;
            observed.push(match &event.kind {
                EventKind::ChatMessageDelta { delta, .. } => delta.clone(),
                EventKind::ProjectRemoved { project_id } => project_id.clone(),
                other => panic!("unexpected event: {other:?}"),
            });
        }
        assert_eq!(observed, ["first", "between", "second", "after"]);
    }

    #[tokio::test]
    async fn different_key_message_deltas_do_not_merge() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();

        bus.emit(message_delta("chat-1", "message-1", "first"));
        bus.emit(message_delta("chat-1", "message-2", "second"));
        bus.emit(separator_event("separator"));

        let first = recv_event(&mut rx).await;
        let second = recv_event(&mut rx).await;
        assert!(matches!(
            (&first.kind, &second.kind),
            (
                EventKind::ChatMessageDelta {
                    message_id: first_id,
                    delta: first_delta,
                    ..
                },
                EventKind::ChatMessageDelta {
                    message_id: second_id,
                    delta: second_delta,
                    ..
                }
            ) if first_id == "message-1"
                && first_delta == "first"
                && second_id == "message-2"
                && second_delta == "second"
        ));
    }

    #[tokio::test]
    async fn activity_deltas_merge_by_conversation_item_and_stream() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();

        bus.emit(activity_delta("chat-1", "item-1", "stdout", "one", 1));
        bus.emit(activity_delta("chat-1", "item-1", "stdout", "two", 2));
        bus.emit(activity_delta("chat-1", "item-1", "stderr", "three", 3));
        bus.emit(separator_event("separator"));

        let stdout = recv_event(&mut rx).await;
        let stderr = recv_event(&mut rx).await;
        assert!(matches!(
            (&stdout.kind, &stderr.kind),
            (
                EventKind::ChatActivityDelta { output: first, .. },
                EventKind::ChatActivityDelta { output: second, .. }
            ) if first.stream_kind == "stdout"
                && first.content_text == "onetwo"
                && first.byte_count == 6
                && second.stream_kind == "stderr"
                && second.content_text == "three"
        ));
    }

    #[tokio::test]
    async fn single_delta_flushes_on_interval_tick() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();

        bus.emit(message_delta("chat-1", "message-1", "pending"));

        let event = recv_event(&mut rx).await;
        assert!(matches!(
            &event.kind,
            EventKind::ChatMessageDelta { delta, .. } if delta == "pending"
        ));
    }

    #[tokio::test]
    async fn cancellation_flushes_buffered_delta_and_stops_coalescer() {
        let (queue_tx, queue_rx) = mpsc::unbounded_channel();
        let (tx, mut rx) = broadcast::channel(8);
        let cancellation_token = CancellationToken::new();
        let task = tokio::spawn(run_coalescer(queue_rx, tx, cancellation_token.clone()));

        queue_tx
            .send(message_delta("chat-1", "message-1", "pending"))
            .unwrap();
        tokio::task::yield_now().await;
        cancellation_token.cancel();

        let event = recv_event(&mut rx).await;
        assert!(matches!(
            &event.kind,
            EventKind::ChatMessageDelta { delta, .. } if delta == "pending"
        ));
        time::timeout(Duration::from_secs(1), task)
            .await
            .expect("coalescer did not stop after cancellation")
            .expect("coalescer task panicked");
    }

    /// Extracts the serde `type` tag string literals from the generated
    /// TypeScript declaration of `EventKind`, in variant declaration order.
    /// Tag keys are the only quoted keys in the ts-rs output, so matching on
    /// `"type"` never picks up payload fields.
    fn extract_type_tags(decl: &str) -> Vec<String> {
        let mut tags = Vec::new();
        let mut rest = decl;
        while let Some(idx) = rest.find("\"type\"") {
            rest = &rest[idx + "\"type\"".len()..];
            let Some(after) = rest.trim_start().strip_prefix(':') else {
                continue;
            };
            let Some(after) = after.trim_start().strip_prefix('"') else {
                continue;
            };
            let Some(end) = after.find('"') else {
                break;
            };
            tags.push(after[..end].to_string());
            rest = &after[end..];
        }
        tags
    }

    /// Locks `EventKind::event_name` / `EventKind::EVENT_NAMES` to the serde
    /// `type` tags. ts-rs derives the tags from the same `#[serde(rename)]`
    /// attributes serde uses when serializing, so any drift between
    /// `event_kind_names!` and the serde tags fails here; a missing macro
    /// entry for a new variant already fails to compile.
    #[test]
    fn event_names_match_serde_tags() {
        let decl = EventKind::export_to_string(&ts_rs::Config::from_env())
            .expect("failed to render EventKind TypeScript declaration");
        let tags = extract_type_tags(&decl);
        assert_eq!(tags, EventKind::EVENT_NAMES);
    }

    #[test]
    fn test_event_kind_names() {
        assert_eq!(
            EventKind::Snapshot {
                build_id: None,
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
