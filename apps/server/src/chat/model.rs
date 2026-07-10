use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use utoipa::ToSchema;

const DEFAULT_IDLE_TIMEOUT_MINUTES: u32 = 60;

/// Supported chat providers.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "snake_case")]
pub enum ChatProvider {
    #[default]
    Codex,
}

impl ChatProvider {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
        }
    }
}

/// Supported reasoning-effort values exposed by Codex model selection.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChatReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
}

impl ChatReasoningEffort {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
        }
    }
}

/// One reasoning-effort option supported by a Codex model.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatModelReasoningEffortOption {
    pub reasoning_effort: ChatReasoningEffort,
    pub description: String,
}

/// One selectable Codex model exposed by app-server.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatModelOption {
    pub id: String,
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub is_default: bool,
    pub hidden: bool,
    pub default_reasoning_effort: ChatReasoningEffort,
    pub supported_reasoning_efforts: Vec<ChatModelReasoningEffortOption>,
}

/// Explicit permissions preset override. `None` means use Codex defaults.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChatPermissionMode {
    FullAccess,
}

impl ChatPermissionMode {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::FullAccess => "full_access",
        }
    }
}

/// Persisted message role for a conversation transcript item.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChatMessageRole {
    User,
    Assistant,
}

impl ChatMessageRole {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

/// Persisted message lifecycle state.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChatMessageStatus {
    Pending,
    Streaming,
    Completed,
    Interrupted,
    Failed,
}

impl ChatMessageStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Streaming => "streaming",
            Self::Completed => "completed",
            Self::Interrupted => "interrupted",
            Self::Failed => "failed",
        }
    }
}

/// Persisted run lifecycle state.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChatRunStatus {
    Starting,
    Running,
    Completed,
    Interrupted,
    Failed,
}

impl ChatRunStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Interrupted => "interrupted",
            Self::Failed => "failed",
        }
    }
}

/// Persisted Codex turn lifecycle state.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChatTurnStatus {
    Starting,
    Running,
    Completed,
    Interrupted,
    Failed,
}

impl ChatTurnStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Interrupted => "interrupted",
            Self::Failed => "failed",
        }
    }
}

/// Normalized Codex item kind persisted for future timeline rendering.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChatItemKind {
    AgentMessage,
    Reasoning,
    CommandExecution,
    FileChange,
    McpToolCall,
    DynamicToolCall,
    WebSearch,
    ImageView,
    Hook,
    AutoApprovalReview,
    ModelReroute,
    Unknown,
}

impl ChatItemKind {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::AgentMessage => "agent_message",
            Self::Reasoning => "reasoning",
            Self::CommandExecution => "command_execution",
            Self::FileChange => "file_change",
            Self::McpToolCall => "mcp_tool_call",
            Self::DynamicToolCall => "dynamic_tool_call",
            Self::WebSearch => "web_search",
            Self::ImageView => "image_view",
            Self::Hook => "hook",
            Self::AutoApprovalReview => "auto_approval_review",
            Self::ModelReroute => "model_reroute",
            Self::Unknown => "unknown",
        }
    }

    pub(super) fn is_activity(self) -> bool {
        !matches!(self, Self::AgentMessage | Self::Reasoning)
    }
}

/// Persisted Codex item lifecycle state.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChatItemStatus {
    Started,
    Streaming,
    Completed,
    Failed,
}

impl ChatItemStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Streaming => "streaming",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

/// Backend-owned reconciliation lifecycle for replaying Codex thread state.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "snake_case")]
pub enum ChatReconciliationStatus {
    #[default]
    NotNeeded,
    Pending,
    Running,
    Completed,
    Failed,
}

impl ChatReconciliationStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::NotNeeded => "not_needed",
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    pub(super) fn is_active(self) -> bool {
        matches!(self, Self::Pending | Self::Running)
    }
}

/// In-memory runtime lifecycle state for a live Codex app-server process.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "snake_case")]
pub enum ChatRuntimeLifecycle {
    #[default]
    Stopped,
    Starting,
    Ready,
    Running,
    Stopping,
    Failed,
}

/// Persisted summary for a conversation list row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatConversationSummary {
    pub id: String,
    pub session_id: String,
    pub project_id: String,
    pub worktree_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    pub provider: ChatProvider,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_thread_id: Option<String>,
    pub title: String,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number")]
    pub updated_at: u64,
    #[ts(type = "number")]
    pub last_activity_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub last_message_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub archived_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_effort: Option<ChatReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_permission_mode: Option<ChatPermissionMode>,
    pub last_run_state: ChatRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub last_reconciliation_state: ChatReconciliationStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_reconciliation_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_used_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_percent_used: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub context_updated_at: Option<u64>,
    pub pending_request_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_pending_request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_pending_request_kind: Option<ChatPendingRequestKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_pending_request_status: Option<ChatPendingRequestStatus>,
    pub has_pending_request_attention: bool,
    #[ts(type = "number")]
    pub revision: u64,
}

/// Persisted transcript message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub conversation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_item_id: Option<String>,
    pub role: ChatMessageRole,
    pub status: ChatMessageStatus,
    pub content_text: String,
    pub reasoning_text: String,
    pub sequence: u32,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number")]
    pub updated_at: u64,
}

/// Persisted run summary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatRun {
    pub id: String,
    pub conversation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_turn_id: Option<String>,
    pub status: ChatRunStatus,
    #[ts(type = "number")]
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub finished_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/// Persisted provider turn metadata for a chat conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurn {
    pub id: String,
    pub conversation_id: String,
    pub run_id: String,
    pub user_message_id: String,
    pub assistant_message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_turn_id: Option<String>,
    pub status: ChatTurnStatus,
    #[ts(type = "number")]
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub completed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub reconciliation_status: ChatReconciliationStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub reconciled_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reconciliation_error: Option<String>,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number")]
    pub updated_at: u64,
}

/// Persisted provider item metadata for a chat conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatItem {
    pub id: String,
    pub conversation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_item_id: Option<String>,
    pub kind: ChatItemKind,
    pub status: ChatItemStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<ChatMessageRole>,
    pub sequence: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub metadata_json: String,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number")]
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub completed_at: Option<u64>,
}

/// Persisted output chunk for a non-message Codex work item.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatItemOutput {
    pub id: String,
    pub conversation_id: String,
    pub item_id: String,
    pub stream_kind: String,
    pub sequence: u32,
    pub content_text: String,
    pub byte_count: u32,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number")]
    pub updated_at: u64,
}

/// Lazy-loaded activity detail for one Codex work item.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatActivityDetail {
    pub item: ChatItem,
    pub outputs: Vec<ChatItemOutput>,
}

/// Persisted Codex plan kind.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChatPlanKind {
    ActiveTask,
    ProposedPlan,
}

impl ChatPlanKind {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::ActiveTask => "active_task",
            Self::ProposedPlan => "proposed_plan",
        }
    }
}

/// Persisted Codex plan lifecycle state.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChatPlanStatus {
    Streaming,
    Completed,
    Failed,
}

impl ChatPlanStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Streaming => "streaming",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

/// Persisted Codex plan state used by the chat timeline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatPlan {
    pub id: String,
    pub conversation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_item_id: Option<String>,
    pub kind: ChatPlanKind,
    pub status: ChatPlanStatus,
    pub content_text: String,
    pub steps_json: String,
    pub metadata_json: String,
    #[ts(type = "number")]
    pub owner_generation: u64,
    pub sequence: u32,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number")]
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub completed_at: Option<u64>,
}

/// One changed file included in a Codex diff summary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatDiffFileSummary {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additions: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletions: Option<u32>,
}

/// Persisted turn-level Codex diff summary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatDiffSummary {
    pub id: String,
    pub conversation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_turn_id: Option<String>,
    pub changed_file_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additions: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletions: Option<u32>,
    pub files: Vec<ChatDiffFileSummary>,
    pub metadata_json: String,
    #[ts(type = "number")]
    pub owner_generation: u64,
    pub sequence: u32,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number")]
    pub updated_at: u64,
}

/// Latest context-window usage for a Codex conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatContextUsage {
    pub id: String,
    pub conversation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent_used: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_processed_tokens: Option<u32>,
    pub metadata_json: String,
    #[ts(type = "number")]
    pub updated_at: u64,
}

/// Persisted Codex server request kind.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChatPendingRequestKind {
    CommandApproval,
    FileApproval,
    PermissionApproval,
    StructuredInput,
    McpElicitation,
    Unsupported,
}

impl ChatPendingRequestKind {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::CommandApproval => "command_approval",
            Self::FileApproval => "file_approval",
            Self::PermissionApproval => "permission_approval",
            Self::StructuredInput => "structured_input",
            Self::McpElicitation => "mcp_elicitation",
            Self::Unsupported => "unsupported",
        }
    }
}

/// Persisted Codex server request lifecycle.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChatPendingRequestStatus {
    Pending,
    Resolving,
    Resolved,
    Declined,
    Cancelled,
    Stale,
    Failed,
}

impl ChatPendingRequestStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Resolving => "resolving",
            Self::Resolved => "resolved",
            Self::Declined => "declined",
            Self::Cancelled => "cancelled",
            Self::Stale => "stale",
            Self::Failed => "failed",
        }
    }

    pub(super) fn is_attention(self) -> bool {
        matches!(self, Self::Pending | Self::Resolving)
    }
}

/// User-visible decision sent back to Codex for a pending request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChatPendingRequestDecision {
    Accept,
    AcceptForSession,
    Decline,
    Cancel,
    AcceptWithExecpolicyAmendment,
    ApplyNetworkPolicyAmendment,
    Submit,
}

impl ChatPendingRequestDecision {
    pub(super) fn terminal_status(&self) -> ChatPendingRequestStatus {
        match self {
            Self::Decline => ChatPendingRequestStatus::Declined,
            Self::Cancel => ChatPendingRequestStatus::Cancelled,
            _ => ChatPendingRequestStatus::Resolved,
        }
    }
}

/// Persisted Codex server request with enough state to render and answer it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatPendingRequest {
    pub id: String,
    pub conversation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    pub provider_request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_item_id: Option<String>,
    pub method: String,
    pub kind: ChatPendingRequestKind,
    pub status: ChatPendingRequestStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<ChatPendingRequestDecision>,
    pub payload_json: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[ts(type = "number")]
    pub owner_generation: u64,
    pub sequence: u32,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number")]
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub resolved_at: Option<u64>,
}

/// Lightweight request state included in global SSE snapshots.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatPendingRequestSummary {
    pub id: String,
    pub conversation_id: String,
    pub kind: ChatPendingRequestKind,
    pub status: ChatPendingRequestStatus,
    pub method: String,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number")]
    pub updated_at: u64,
}

/// Latest replay/recovery state for one conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatReconciliation {
    pub id: String,
    pub conversation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_thread_id: Option<String>,
    pub status: ChatReconciliationStatus,
    pub reason: String,
    #[ts(type = "number")]
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub finished_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[ts(type = "number")]
    pub owner_generation: u64,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number")]
    pub updated_at: u64,
}

/// Request body for resolving a pending Codex server request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResolveChatPendingRequestRequest {
    pub decision: ChatPendingRequestDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

/// Full chat detail payload used to hydrate an open chat tab.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatConversationDetail {
    pub conversation: ChatConversationSummary,
    pub messages: Vec<ChatMessage>,
    pub turns: Vec<ChatTurn>,
    pub items: Vec<ChatItem>,
    pub plans: Vec<ChatPlan>,
    pub diff_summaries: Vec<ChatDiffSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_usage: Option<ChatContextUsage>,
    pub pending_requests: Vec<ChatPendingRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_reconciliation: Option<ChatReconciliation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_run: Option<ChatRun>,
}

/// Shared runtime summary pushed over SSE.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatRuntimeStatus {
    pub conversation_id: String,
    pub session_id: String,
    pub project_id: String,
    pub worktree_id: String,
    pub lifecycle: ChatRuntimeLifecycle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[ts(type = "number")]
    pub updated_at: u64,
}

/// Shared Codex app-server process lifecycle pushed over SSE.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChatAppServerLifecycle {
    Stopped,
    Starting,
    Initializing,
    Ready,
    Stopping,
    Fatal,
}

/// Host-scoped Codex app-server status.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatAppServerStatus {
    pub lifecycle: ChatAppServerLifecycle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[ts(type = "number")]
    pub updated_at: u64,
}

/// Per-conversation Codex thread stream resume state.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChatThreadStreamResumeState {
    NotStarted,
    NeedsResume,
    Resuming,
    Resumed,
}

/// Live stream status for one Codex thread.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatThreadStreamStatus {
    pub conversation_id: String,
    pub session_id: String,
    pub project_id: String,
    pub worktree_id: String,
    pub resume_state: ChatThreadStreamResumeState,
    pub lifecycle: ChatRuntimeLifecycle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub inactive_deadline_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[ts(type = "number")]
    pub updated_at: u64,
}
/// Chat settings owned by the backend.
//
// Serde defaults tolerate missing fields in the settings TOML file, while
// `schema(required = true)` keeps the API contract required because the
// server always serializes every field in responses and SSE snapshots.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatSettings {
    #[serde(default = "default_chat_idle_timeout_minutes")]
    #[schema(required = true)]
    pub idle_timeout_minutes: u32,
    #[serde(default)]
    #[schema(required = true)]
    pub ui_style: ChatUiStyle,
    #[serde(default)]
    #[schema(required = true)]
    pub copilotkit_theme_mode: CopilotKitThemeMode,
}

/// Chat UI implementation selected by the user.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub enum ChatUiStyle {
    Classic,
    #[default]
    Copilotkit,
}

impl ChatUiStyle {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Classic => "classic",
            Self::Copilotkit => "copilotkit",
        }
    }
}

/// CopilotKit visual theme mode selected by the user.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub enum CopilotKitThemeMode {
    #[default]
    Hubris,
    Stock,
}

impl CopilotKitThemeMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Hubris => "hubris",
            Self::Stock => "stock",
        }
    }
}

/// Conversation-level model preferences that apply to future turns.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatConversationSettingsPatch {
    pub selected_model: Option<String>,
    pub selected_effort: Option<ChatReasoningEffort>,
    pub selected_permission_mode: Option<ChatPermissionMode>,
}

impl Default for ChatSettings {
    fn default() -> Self {
        Self {
            idle_timeout_minutes: default_chat_idle_timeout_minutes(),
            ui_style: ChatUiStyle::default(),
            copilotkit_theme_mode: CopilotKitThemeMode::default(),
        }
    }
}

fn default_chat_idle_timeout_minutes() -> u32 {
    DEFAULT_IDLE_TIMEOUT_MINUTES
}
