use std::collections::{HashMap, HashSet};
use std::fmt;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::http::StatusCode;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{FromRow, Row, Sqlite, SqlitePool, Transaction};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, broadcast, oneshot};
use ts_rs::TS;
use utoipa::ToSchema;

use crate::events::EventKind;
use crate::settings_manager::SettingsManager;

mod lifecycle;
mod protocol;

use lifecycle::{
    AppServerLifecycle, AppServerProcessState, ThreadStreamLifecycle, ThreadStreamResumeState,
};
use protocol::{ParsedLine, RouteHints};

pub const DEFAULT_CHAT_TITLE: &str = "New Chat";
const DEFAULT_IDLE_TIMEOUT_MINUTES: u32 = 60;
const CHAT_DB_MAX_CONNECTIONS: u32 = 1;
static CHAT_DB_MIGRATOR: Migrator = sqlx::migrate!("./chat-migrations");
const MAX_INACTIVE_THREAD_STREAMS: usize = 4;
const UNSUBSCRIBE_RETRY_DELAY: Duration = Duration::from_secs(15);
const CODEX_TEXT_TRACE_ENV: &str = "HUBRIS_CODEX_TEXT_TRACE";

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Supported chat providers.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "snake_case")]
pub enum ChatProvider {
    #[default]
    Codex,
}

impl ChatProvider {
    fn as_str(self) -> &'static str {
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
    fn as_str(self) -> &'static str {
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
    fn as_str(self) -> &'static str {
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
    fn as_str(self) -> &'static str {
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
    fn as_str(self) -> &'static str {
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
    fn as_str(self) -> &'static str {
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
    fn as_str(self) -> &'static str {
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
    fn as_str(self) -> &'static str {
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

    fn is_activity(self) -> bool {
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
    fn as_str(self) -> &'static str {
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
    fn as_str(self) -> &'static str {
        match self {
            Self::NotNeeded => "not_needed",
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    fn is_active(self) -> bool {
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
    fn as_str(self) -> &'static str {
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
    fn as_str(self) -> &'static str {
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
    fn as_str(self) -> &'static str {
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
    fn as_str(self) -> &'static str {
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

    fn is_attention(self) -> bool {
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
    fn terminal_status(&self) -> ChatPendingRequestStatus {
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatCreateOptions {
    pub session_id: String,
    pub project_id: String,
    pub worktree_id: String,
    pub branch_name: String,
}

/// Conversation list scope used by the worktree chats panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatConversationListScope {
    Branch,
    Project,
}

/// Chat settings owned by the backend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatSettings {
    pub idle_timeout_minutes: u32,
    pub ui_style: ChatUiStyle,
    pub copilotkit_theme_mode: CopilotKitThemeMode,
}

/// Chat UI implementation selected by the user.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub enum ChatUiStyle {
    #[default]
    Classic,
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
            idle_timeout_minutes: DEFAULT_IDLE_TIMEOUT_MINUTES,
            ui_style: ChatUiStyle::default(),
            copilotkit_theme_mode: CopilotKitThemeMode::default(),
        }
    }
}

pub fn clamp_chat_idle_timeout_minutes(value: u32) -> u32 {
    value.max(1)
}

#[derive(Debug, Clone)]
pub struct ChatServiceError {
    pub status: StatusCode,
    pub message: String,
}

impl ChatServiceError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl fmt::Display for ChatServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ChatServiceError {}

impl From<sqlx::Error> for ChatServiceError {
    fn from(value: sqlx::Error) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("chat database error: {value}"),
        )
    }
}

#[derive(Debug, Clone)]
struct RuntimeEntry {
    state: Arc<Mutex<RuntimeState>>,
}

#[derive(Debug, Clone)]
struct RuntimeState {
    session_id: String,
    project_id: String,
    worktree_id: String,
    worktree_path: String,
    provider_thread_id: Option<String>,
    active_run_id: Option<String>,
    active_turn_id: Option<String>,
    active_message_id: Option<String>,
    active_error: Option<String>,
    lifecycle: ChatRuntimeLifecycle,
    active_reasoning_summary_index: Option<u64>,
    active_commentary_item_id: Option<String>,
    has_reasoning_projection: bool,
    agent_message_projection_by_item_id: HashMap<String, AgentMessageProjection>,
    commentary_delta_seen_item_ids: HashSet<String>,
    commentary_completed_item_ids: HashSet<String>,
    stream_lifecycle: ThreadStreamLifecycle,
    owner_generation: u64,
    idle_generation: u64,
    inactive_deadline_at: Option<u64>,
    last_error: Option<String>,
}

impl RuntimeState {
    fn new(conversation: &ChatConversationSummary, worktree_path: &str) -> Self {
        let mut stream_lifecycle = ThreadStreamLifecycle::default();
        if conversation.provider_thread_id.is_some() {
            stream_lifecycle.mark_needs_resume();
        }

        Self {
            session_id: conversation.session_id.clone(),
            project_id: conversation.project_id.clone(),
            worktree_id: conversation.worktree_id.clone(),
            worktree_path: worktree_path.to_string(),
            provider_thread_id: conversation.provider_thread_id.clone(),
            active_run_id: None,
            active_turn_id: None,
            active_message_id: None,
            active_error: None,
            lifecycle: ChatRuntimeLifecycle::Starting,
            active_reasoning_summary_index: None,
            active_commentary_item_id: None,
            has_reasoning_projection: false,
            agent_message_projection_by_item_id: HashMap::new(),
            commentary_delta_seen_item_ids: HashSet::new(),
            commentary_completed_item_ids: HashSet::new(),
            stream_lifecycle,
            owner_generation: 0,
            idle_generation: 0,
            inactive_deadline_at: None,
            last_error: None,
        }
    }

    fn reset_text_projection_state(&mut self) {
        self.active_reasoning_summary_index = None;
        self.active_commentary_item_id = None;
        self.has_reasoning_projection = false;
        self.agent_message_projection_by_item_id.clear();
        self.commentary_delta_seen_item_ids.clear();
        self.commentary_completed_item_ids.clear();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentMessageProjection {
    Response,
    Reasoning,
}

#[derive(Debug, Clone)]
struct RouteEntry {
    conversation_id: String,
    owner_generation: u64,
}

#[derive(Debug, Clone)]
struct PendingServerRequestRoute {
    route: RouteEntry,
    method: String,
    turn_id: Option<String>,
    item_id: Option<String>,
}

#[derive(Debug, Clone)]
struct PendingServerResponder {
    jsonrpc_id: Value,
    conversation_id: String,
    provider_request_id: String,
    owner_generation: u64,
}

struct PersistProviderRequest {
    jsonrpc_id: Value,
    method: String,
    params: Value,
    route_hints: RouteHints,
    status: ChatPendingRequestStatus,
    decision: Option<ChatPendingRequestDecision>,
    error_message: Option<String>,
}

#[derive(Debug, Clone)]
enum CodexStreamEvent {
    ServerRequest {
        id: Value,
        method: String,
        params: Value,
        thread_id: Option<String>,
        route_hints: RouteHints,
    },
    Notification {
        method: String,
        params: Value,
        thread_id: Option<String>,
        route_hints: RouteHints,
    },
    Closed {
        reason: String,
    },
}

type CodexAppServerFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
type CodexAppServerConnectionRef = Arc<dyn CodexAppServerConnection>;
type CodexAppServerFactory = Arc<
    dyn Fn() -> CodexAppServerFuture<'static, Result<CodexAppServerConnectionRef, ChatServiceError>>
        + Send
        + Sync,
>;

trait CodexAppServerConnection: Send + Sync {
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> CodexAppServerFuture<'a, Result<Value, ChatServiceError>>;

    fn respond_result<'a>(
        &'a self,
        id: Value,
        result: Value,
    ) -> CodexAppServerFuture<'a, Result<(), ChatServiceError>>;

    fn subscribe(&self) -> broadcast::Receiver<CodexStreamEvent>;

    fn lifecycle_state<'a>(&'a self) -> CodexAppServerFuture<'a, AppServerProcessState>;
}

type PendingResponseTx = oneshot::Sender<Result<Value, ChatServiceError>>;
type PendingResponses = HashMap<u64, PendingResponseTx>;

#[derive(Debug)]
struct CodexAppServerClient {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    next_id: AtomicU64,
    pending: Arc<Mutex<PendingResponses>>,
    stream_events: broadcast::Sender<CodexStreamEvent>,
    lifecycle: Arc<Mutex<AppServerLifecycle>>,
}

impl CodexAppServerClient {
    async fn spawn() -> Result<Arc<Self>, ChatServiceError> {
        let mut initial_lifecycle = AppServerLifecycle::default();
        initial_lifecycle.mark_starting();
        let lifecycle = Arc::new(Mutex::new(initial_lifecycle));
        let mut child = Command::new("codex")
            .args(["app-server", "--listen", "stdio://"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|error| {
                ChatServiceError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("failed to start codex app-server: {error}"),
                )
            })?;

        let stdin = child.stdin.take().ok_or_else(|| {
            ChatServiceError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "codex app-server stdin unavailable",
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ChatServiceError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "codex app-server stdout unavailable",
            )
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ChatServiceError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "codex app-server stderr unavailable",
            )
        })?;

        let (stream_events, _) = broadcast::channel(256);
        let client = Arc::new(Self {
            stdin: Arc::new(Mutex::new(stdin)),
            child: Arc::new(Mutex::new(child)),
            next_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            stream_events,
            lifecycle,
        });

        Self::spawn_stdout_reader(client.clone(), stdout);
        Self::spawn_stderr_reader(stderr);
        {
            let mut lifecycle = client.lifecycle.lock().await;
            lifecycle.mark_initializing();
        }
        if let Err(error) = client.initialize().await {
            let mut lifecycle = client.lifecycle.lock().await;
            lifecycle.mark_fatal();
            drop(lifecycle);
            client.shutdown().await;
            return Err(error);
        }
        {
            let mut lifecycle = client.lifecycle.lock().await;
            lifecycle.mark_ready();
        }
        Ok(client)
    }

    fn spawn_stdout_reader(client: Arc<Self>, stdout: tokio::process::ChildStdout) {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        if line.trim().is_empty() {
                            continue;
                        }

                        match protocol::parse_jsonrpc_line(&line) {
                            ParsedLine::ServerRequest {
                                id,
                                method,
                                method_kind,
                                params,
                                thread_id,
                                route_hints,
                            } => {
                                tracing::trace!(
                                    method = method_kind.name(),
                                    thread_id = thread_id.as_deref().unwrap_or(""),
                                    "codex app-server server request"
                                );
                                let _ =
                                    client.stream_events.send(CodexStreamEvent::ServerRequest {
                                        id,
                                        method,
                                        params,
                                        thread_id,
                                        route_hints,
                                    });
                            }
                            ParsedLine::Notification {
                                method,
                                method_kind,
                                params,
                                thread_id,
                                route_hints,
                            } => {
                                tracing::trace!(
                                    method = method_kind.name(),
                                    thread_id = thread_id.as_deref().unwrap_or(""),
                                    "codex app-server notification"
                                );
                                let _ = client.stream_events.send(CodexStreamEvent::Notification {
                                    method,
                                    params,
                                    thread_id,
                                    route_hints,
                                });
                            }
                            ParsedLine::Response {
                                id,
                                result,
                                error_message,
                            } => {
                                let mut pending = client.pending.lock().await;
                                if let Some(reply) = pending.remove(&id) {
                                    let result = if let Some(message) = error_message {
                                        Err(ChatServiceError::new(StatusCode::BAD_GATEWAY, message))
                                    } else {
                                        Ok(result)
                                    };
                                    let _ = reply.send(result);
                                }
                            }
                            ParsedLine::Malformed { reason } => {
                                tracing::warn!(reason, "invalid codex app-server JSON-RPC line");
                            }
                            ParsedLine::Unsupported { reason } => {
                                tracing::warn!(
                                    reason,
                                    "unsupported codex app-server JSON-RPC message"
                                );
                            }
                        }
                    }
                    Ok(None) => {
                        let _ = client.stream_events.send(CodexStreamEvent::Closed {
                            reason: "codex app-server stdout closed".to_string(),
                        });
                        break;
                    }
                    Err(error) => {
                        let _ = client.stream_events.send(CodexStreamEvent::Closed {
                            reason: format!("failed to read codex app-server output: {error}"),
                        });
                        break;
                    }
                }
            }

            let mut pending = client.pending.lock().await;
            for (_, reply) in pending.drain() {
                let _ = reply.send(Err(ChatServiceError::new(
                    StatusCode::BAD_GATEWAY,
                    "codex app-server disconnected",
                )));
            }
        });
    }

    fn spawn_stderr_reader(stderr: tokio::process::ChildStderr) {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if !line.trim().is_empty() {
                    tracing::debug!("codex app-server stderr: {line}");
                }
            }
        });
    }

    async fn initialize(&self) -> Result<(), ChatServiceError> {
        self.request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "hubris",
                    "title": "Hubris",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": {
                    "experimentalApi": true
                }
            }),
        )
        .await?;
        self.notify("initialized", Value::Null).await
    }

    fn subscribe(&self) -> broadcast::Receiver<CodexStreamEvent> {
        self.stream_events.subscribe()
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, ChatServiceError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let (reply_tx, reply_rx) = oneshot::channel();
        self.pending.lock().await.insert(id, reply_tx);
        self.write_payload(&payload).await?;
        reply_rx.await.map_err(|_| {
            ChatServiceError::new(
                StatusCode::BAD_GATEWAY,
                "codex app-server response channel closed",
            )
        })?
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), ChatServiceError> {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.write_payload(&payload).await
    }

    async fn respond_result(&self, id: Value, result: Value) -> Result<(), ChatServiceError> {
        self.write_payload(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        }))
        .await
    }

    async fn write_payload(&self, payload: &Value) -> Result<(), ChatServiceError> {
        let encoded = serde_json::to_vec(payload).map_err(|error| {
            ChatServiceError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to encode codex app-server payload: {error}"),
            )
        })?;
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&encoded).await.map_err(|error| {
            ChatServiceError::new(
                StatusCode::BAD_GATEWAY,
                format!("failed to write to codex app-server: {error}"),
            )
        })?;
        stdin.write_all(b"\n").await.map_err(|error| {
            ChatServiceError::new(
                StatusCode::BAD_GATEWAY,
                format!("failed to write to codex app-server: {error}"),
            )
        })?;
        stdin.flush().await.map_err(|error| {
            ChatServiceError::new(
                StatusCode::BAD_GATEWAY,
                format!("failed to flush codex app-server stdin: {error}"),
            )
        })?;
        Ok(())
    }

    async fn shutdown(&self) {
        let was_fatal = {
            let mut lifecycle = self.lifecycle.lock().await;
            let was_fatal = lifecycle.is_fatal();
            if !was_fatal {
                lifecycle.mark_stopping();
            }
            was_fatal
        };
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
        let _ = child.wait().await;
        if was_fatal {
            return;
        }
        let mut lifecycle = self.lifecycle.lock().await;
        lifecycle.mark_stopped();
    }

    async fn lifecycle_state(&self) -> AppServerProcessState {
        self.lifecycle.lock().await.state()
    }
}

impl CodexAppServerConnection for CodexAppServerClient {
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> CodexAppServerFuture<'a, Result<Value, ChatServiceError>> {
        Box::pin(async move { CodexAppServerClient::request(self, method, params).await })
    }

    fn respond_result<'a>(
        &'a self,
        id: Value,
        result: Value,
    ) -> CodexAppServerFuture<'a, Result<(), ChatServiceError>> {
        Box::pin(async move { CodexAppServerClient::respond_result(self, id, result).await })
    }

    fn subscribe(&self) -> broadcast::Receiver<CodexStreamEvent> {
        CodexAppServerClient::subscribe(self)
    }

    fn lifecycle_state<'a>(&'a self) -> CodexAppServerFuture<'a, AppServerProcessState> {
        Box::pin(async move { CodexAppServerClient::lifecycle_state(self).await })
    }
}

struct CodexAppServerManager {
    client: Mutex<Option<CodexAppServerConnectionRef>>,
    startup_lock: Mutex<()>,
    lifecycle: Mutex<AppServerLifecycle>,
    last_error: Mutex<Option<String>>,
    factory: CodexAppServerFactory,
}

impl CodexAppServerManager {
    fn new() -> Self {
        Self {
            client: Mutex::new(None),
            startup_lock: Mutex::new(()),
            lifecycle: Mutex::new(AppServerLifecycle::default()),
            last_error: Mutex::new(None),
            factory: Arc::new(|| {
                Box::pin(async {
                    CodexAppServerClient::spawn()
                        .await
                        .map(|client| client as CodexAppServerConnectionRef)
                })
            }),
        }
    }

    #[cfg(test)]
    fn new_for_tests(factory: CodexAppServerFactory) -> Self {
        Self {
            client: Mutex::new(None),
            startup_lock: Mutex::new(()),
            lifecycle: Mutex::new(AppServerLifecycle::default()),
            last_error: Mutex::new(None),
            factory,
        }
    }

    async fn ensure_client(&self) -> Result<CodexAppServerConnectionRef, ChatServiceError> {
        if let Some(existing) = self.client.lock().await.as_ref().cloned() {
            return Ok(existing);
        }

        let _startup_guard = self.startup_lock.lock().await;
        if let Some(existing) = self.client.lock().await.as_ref().cloned() {
            return Ok(existing);
        }

        {
            let mut lifecycle = self.lifecycle.lock().await;
            lifecycle.mark_starting();
        }
        *self.last_error.lock().await = None;

        match (self.factory)().await {
            Ok(next_client) => {
                {
                    let mut lifecycle = self.lifecycle.lock().await;
                    lifecycle.mark_ready();
                }
                *self.client.lock().await = Some(next_client.clone());
                Ok(next_client)
            }
            Err(error) => {
                {
                    let mut lifecycle = self.lifecycle.lock().await;
                    lifecycle.mark_fatal();
                }
                *self.last_error.lock().await = Some(error.message.clone());
                Err(error)
            }
        }
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, ChatServiceError> {
        let client = self.ensure_client().await?;
        client.request(method, params).await
    }

    async fn respond_result(&self, id: Value, result: Value) -> Result<(), ChatServiceError> {
        let Some(client) = self.client.lock().await.as_ref().cloned() else {
            return Err(ChatServiceError::new(
                StatusCode::BAD_GATEWAY,
                "codex app-server is not running",
            ));
        };
        client.respond_result(id, result).await
    }

    async fn mark_fatal(&self, reason: String) {
        {
            let mut lifecycle = self.lifecycle.lock().await;
            lifecycle.mark_fatal();
        }
        *self.last_error.lock().await = Some(reason);
        *self.client.lock().await = None;
    }

    async fn status(&self) -> ChatAppServerStatus {
        let client = self.client.lock().await.as_ref().cloned();
        let lifecycle = if let Some(client) = client {
            chat_app_server_lifecycle_from_process(client.lifecycle_state().await)
        } else {
            chat_app_server_lifecycle_from_process(self.lifecycle.lock().await.state())
        };
        ChatAppServerStatus {
            lifecycle,
            last_error: self.last_error.lock().await.clone(),
            updated_at: now_ms(),
        }
    }
}

#[derive(Debug, FromRow)]
struct ConversationRow {
    id: String,
    session_id: String,
    project_id: String,
    worktree_id: String,
    branch_name: Option<String>,
    provider: String,
    provider_thread_id: Option<String>,
    title: String,
    created_at_ms: i64,
    updated_at_ms: i64,
    last_activity_at_ms: i64,
    last_message_at_ms: Option<i64>,
    open_tab_id: Option<String>,
    archived_at_ms: Option<i64>,
    selected_model: Option<String>,
    selected_effort: Option<String>,
    selected_permission_mode: Option<String>,
    last_run_state: String,
    last_error: Option<String>,
    last_reconciliation_state: String,
    last_reconciliation_error: Option<String>,
    context_used_tokens: Option<i64>,
    context_max_tokens: Option<i64>,
    context_percent_used: Option<f64>,
    context_updated_at_ms: Option<i64>,
    pending_request_count: i64,
    latest_pending_request_id: Option<String>,
    latest_pending_request_kind: Option<String>,
    latest_pending_request_status: Option<String>,
    revision: i64,
}

#[derive(Debug, FromRow)]
struct MessageRow {
    id: String,
    conversation_id: String,
    turn_id: Option<String>,
    item_id: Option<String>,
    provider_turn_id: Option<String>,
    provider_item_id: Option<String>,
    role: String,
    status: String,
    content_text: String,
    reasoning_text: String,
    sequence: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Debug, FromRow)]
struct RunRow {
    id: String,
    conversation_id: String,
    turn_id: Option<String>,
    provider_turn_id: Option<String>,
    status: String,
    started_at_ms: i64,
    finished_at_ms: Option<i64>,
    error_message: Option<String>,
}

#[derive(Debug, FromRow)]
struct TurnRow {
    id: String,
    conversation_id: String,
    run_id: String,
    user_message_id: String,
    assistant_message_id: String,
    provider_turn_id: Option<String>,
    status: String,
    started_at_ms: i64,
    completed_at_ms: Option<i64>,
    error_message: Option<String>,
    reconciliation_status: String,
    reconciled_at_ms: Option<i64>,
    reconciliation_error: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Debug, FromRow)]
struct ItemRow {
    id: String,
    conversation_id: String,
    turn_id: Option<String>,
    provider_turn_id: Option<String>,
    provider_item_id: Option<String>,
    kind: String,
    status: String,
    role: Option<String>,
    sequence: i64,
    title: Option<String>,
    summary: Option<String>,
    metadata_json: String,
    created_at_ms: i64,
    updated_at_ms: i64,
    completed_at_ms: Option<i64>,
}

#[derive(Debug, FromRow)]
struct ItemOutputRow {
    id: String,
    conversation_id: String,
    item_id: String,
    stream_kind: String,
    sequence: i64,
    content_text: String,
    byte_count: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Debug, FromRow)]
struct PlanRow {
    id: String,
    conversation_id: String,
    turn_id: Option<String>,
    item_id: Option<String>,
    provider_turn_id: Option<String>,
    provider_item_id: Option<String>,
    kind: String,
    status: String,
    content_text: String,
    steps_json: String,
    metadata_json: String,
    owner_generation: i64,
    sequence: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
    completed_at_ms: Option<i64>,
}

#[derive(Debug, FromRow)]
struct DiffSummaryRow {
    id: String,
    conversation_id: String,
    turn_id: Option<String>,
    provider_turn_id: Option<String>,
    changed_file_count: i64,
    additions: Option<i64>,
    deletions: Option<i64>,
    files_json: String,
    metadata_json: String,
    owner_generation: i64,
    sequence: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Debug, FromRow)]
struct ContextUsageRow {
    id: String,
    conversation_id: String,
    provider_thread_id: Option<String>,
    used_tokens: Option<i64>,
    max_tokens: Option<i64>,
    percent_used: Option<f64>,
    total_processed_tokens: Option<i64>,
    metadata_json: String,
    updated_at_ms: i64,
}

#[derive(Debug, FromRow)]
struct PendingRequestRow {
    id: String,
    conversation_id: String,
    turn_id: Option<String>,
    item_id: Option<String>,
    provider_request_id: String,
    provider_turn_id: Option<String>,
    provider_item_id: Option<String>,
    method: String,
    kind: String,
    status: String,
    decision: Option<String>,
    payload_json: String,
    response_json: Option<String>,
    error_message: Option<String>,
    owner_generation: i64,
    sequence: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
    resolved_at_ms: Option<i64>,
}

#[derive(Debug, FromRow)]
struct PendingRequestSummaryRow {
    id: String,
    conversation_id: String,
    method: String,
    kind: String,
    status: String,
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Debug, FromRow)]
struct ReconciliationRow {
    id: String,
    conversation_id: String,
    provider_thread_id: Option<String>,
    status: String,
    reason: String,
    started_at_ms: i64,
    finished_at_ms: Option<i64>,
    error_message: Option<String>,
    owner_generation: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
}

/// Backend owner for persisted conversations and live Codex runtimes.
pub struct ChatService {
    pool: SqlitePool,
    events: Arc<crate::events::EventBus>,
    settings: Arc<SettingsManager>,
    app_server: Arc<CodexAppServerManager>,
    runtimes: DashMap<String, RuntimeEntry>,
    thread_to_conversation: DashMap<String, RouteEntry>,
    turn_to_conversation: DashMap<String, RouteEntry>,
    item_to_conversation: DashMap<String, RouteEntry>,
    server_request_to_conversation: DashMap<String, PendingServerRequestRoute>,
    pending_server_responders: DashMap<String, PendingServerResponder>,
    op_locks: DashMap<String, Arc<Mutex<()>>>,
    stream_owner_generation: AtomicU64,
    app_event_loop_started: AtomicBool,
}

struct ChatHistoryTable {
    name: &'static str,
    columns: &'static [&'static str],
}

const CHAT_HISTORY_TABLES: &[ChatHistoryTable] = &[
    ChatHistoryTable {
        name: "chat_conversations",
        columns: &[
            "id",
            "session_id",
            "project_id",
            "worktree_id",
            "provider",
            "provider_thread_id",
            "title",
            "created_at_ms",
            "updated_at_ms",
            "last_activity_at_ms",
            "last_message_at_ms",
            "open_tab_id",
            "last_run_state",
            "last_error",
            "revision",
            "selected_model",
            "selected_effort",
            "selected_permission_mode",
            "last_reconciliation_state",
            "last_reconciliation_error",
            "branch_name",
            "archived_at_ms",
        ],
    },
    ChatHistoryTable {
        name: "chat_messages",
        columns: &[
            "id",
            "conversation_id",
            "provider_turn_id",
            "role",
            "status",
            "content_text",
            "sequence",
            "created_at_ms",
            "updated_at_ms",
            "reasoning_text",
            "turn_id",
            "item_id",
            "provider_item_id",
        ],
    },
    ChatHistoryTable {
        name: "chat_runs",
        columns: &[
            "id",
            "conversation_id",
            "provider_turn_id",
            "status",
            "started_at_ms",
            "finished_at_ms",
            "error_message",
            "turn_id",
        ],
    },
    ChatHistoryTable {
        name: "chat_turns",
        columns: &[
            "id",
            "conversation_id",
            "run_id",
            "user_message_id",
            "assistant_message_id",
            "provider_turn_id",
            "status",
            "started_at_ms",
            "completed_at_ms",
            "error_message",
            "created_at_ms",
            "updated_at_ms",
            "reconciliation_status",
            "reconciled_at_ms",
            "reconciliation_error",
        ],
    },
    ChatHistoryTable {
        name: "chat_items",
        columns: &[
            "id",
            "conversation_id",
            "turn_id",
            "provider_turn_id",
            "provider_item_id",
            "kind",
            "status",
            "role",
            "sequence",
            "title",
            "summary",
            "metadata_json",
            "created_at_ms",
            "updated_at_ms",
            "completed_at_ms",
        ],
    },
    ChatHistoryTable {
        name: "chat_item_outputs",
        columns: &[
            "id",
            "conversation_id",
            "item_id",
            "stream_kind",
            "sequence",
            "content_text",
            "byte_count",
            "created_at_ms",
            "updated_at_ms",
        ],
    },
    ChatHistoryTable {
        name: "chat_pending_requests",
        columns: &[
            "id",
            "conversation_id",
            "turn_id",
            "item_id",
            "provider_request_id",
            "provider_turn_id",
            "provider_item_id",
            "method",
            "kind",
            "status",
            "decision",
            "payload_json",
            "response_json",
            "error_message",
            "owner_generation",
            "sequence",
            "created_at_ms",
            "updated_at_ms",
            "resolved_at_ms",
        ],
    },
    ChatHistoryTable {
        name: "chat_plans",
        columns: &[
            "id",
            "conversation_id",
            "turn_id",
            "item_id",
            "provider_turn_id",
            "provider_item_id",
            "kind",
            "status",
            "content_text",
            "steps_json",
            "metadata_json",
            "owner_generation",
            "sequence",
            "created_at_ms",
            "updated_at_ms",
            "completed_at_ms",
        ],
    },
    ChatHistoryTable {
        name: "chat_diff_summaries",
        columns: &[
            "id",
            "conversation_id",
            "turn_id",
            "provider_turn_id",
            "changed_file_count",
            "additions",
            "deletions",
            "files_json",
            "metadata_json",
            "owner_generation",
            "sequence",
            "created_at_ms",
            "updated_at_ms",
        ],
    },
    ChatHistoryTable {
        name: "chat_context_usage",
        columns: &[
            "id",
            "conversation_id",
            "provider_thread_id",
            "used_tokens",
            "max_tokens",
            "percent_used",
            "total_processed_tokens",
            "metadata_json",
            "updated_at_ms",
        ],
    },
    ChatHistoryTable {
        name: "chat_reconciliations",
        columns: &[
            "id",
            "conversation_id",
            "provider_thread_id",
            "status",
            "reason",
            "started_at_ms",
            "finished_at_ms",
            "error_message",
            "owner_generation",
            "created_at_ms",
            "updated_at_ms",
        ],
    },
];

async fn migrate_legacy_chat_history(
    legacy_state_db_path: &Path,
    pool: &SqlitePool,
) -> std::io::Result<()> {
    if !legacy_state_db_path.exists() {
        return Ok(());
    }

    let mut conn = pool.acquire().await.map_err(std::io::Error::other)?;
    let legacy_path = legacy_state_db_path.to_string_lossy().to_string();
    sqlx::query("ATTACH DATABASE ? AS legacy_state")
        .bind(legacy_path)
        .execute(&mut *conn)
        .await
        .map_err(std::io::Error::other)?;

    let result = async {
        let has_chat_conversations =
            legacy_chat_table_exists(&mut conn, "chat_conversations").await?;
        if !has_chat_conversations {
            return Ok::<(), sqlx::Error>(());
        }

        for table in CHAT_HISTORY_TABLES {
            if legacy_chat_table_exists(&mut conn, table.name).await? {
                let columns = table.columns.join(", ");
                let sql = format!(
                    "INSERT OR IGNORE INTO {table} ({columns}) \
                     SELECT {columns} FROM legacy_state.{table}",
                    table = table.name,
                );
                sqlx::query(&sql).execute(&mut *conn).await?;
            }
        }

        Ok(())
    }
    .await;

    let detach_result = sqlx::query("DETACH DATABASE legacy_state")
        .execute(&mut *conn)
        .await;

    result
        .and(detach_result.map(|_| ()))
        .map_err(std::io::Error::other)
}

async fn legacy_chat_table_exists(
    conn: &mut sqlx::pool::PoolConnection<Sqlite>,
    table: &str,
) -> Result<bool, sqlx::Error> {
    let row = sqlx::query(
        "
        SELECT 1
        FROM legacy_state.sqlite_master
        WHERE type = 'table' AND name = ?
        ",
    )
    .bind(table)
    .fetch_optional(&mut **conn)
    .await?;
    Ok(row.is_some())
}

impl ChatService {
    /// Open the chat history database and prepare chat services.
    pub async fn new(
        db_path: &Path,
        legacy_state_db_path: &Path,
        events: Arc<crate::events::EventBus>,
        settings: Arc<SettingsManager>,
    ) -> std::io::Result<Self> {
        if let Some(parent) = db_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let options = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(CHAT_DB_MAX_CONNECTIONS)
            .connect_with(options)
            .await
            .map_err(std::io::Error::other)?;
        CHAT_DB_MIGRATOR
            .run(&pool)
            .await
            .map_err(std::io::Error::other)?;
        migrate_legacy_chat_history(legacy_state_db_path, &pool).await?;
        Ok(Self {
            pool,
            events,
            settings,
            app_server: Arc::new(CodexAppServerManager::new()),
            runtimes: DashMap::new(),
            thread_to_conversation: DashMap::new(),
            turn_to_conversation: DashMap::new(),
            item_to_conversation: DashMap::new(),
            server_request_to_conversation: DashMap::new(),
            pending_server_responders: DashMap::new(),
            op_locks: DashMap::new(),
            stream_owner_generation: AtomicU64::new(1),
            app_event_loop_started: AtomicBool::new(false),
        })
    }

    /// Create a new conversation record.
    pub async fn create_conversation(
        &self,
        options: ChatCreateOptions,
    ) -> Result<ChatConversationSummary, ChatServiceError> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms() as i64;
        sqlx::query(
            "
            INSERT INTO chat_conversations (
                id, session_id, project_id, worktree_id, branch_name, provider,
                title, created_at_ms, updated_at_ms, last_activity_at_ms,
                last_run_state, revision
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ",
        )
        .bind(&id)
        .bind(&options.session_id)
        .bind(&options.project_id)
        .bind(&options.worktree_id)
        .bind(normalize_branch_name(&options.branch_name))
        .bind(ChatProvider::Codex.as_str())
        .bind(DEFAULT_CHAT_TITLE)
        .bind(now)
        .bind(now)
        .bind(now)
        .bind(ChatRunStatus::Completed.as_str())
        .execute(&self.pool)
        .await?;

        let conversation = self.get_conversation_summary(&id).await?.ok_or_else(|| {
            ChatServiceError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "created conversation missing from database",
            )
        })?;
        self.events.emit(EventKind::ChatConversationCreated {
            session_id: conversation.session_id.clone(),
            conversation,
        });
        self.get_conversation_summary(&id).await?.ok_or_else(|| {
            ChatServiceError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "created conversation missing from database",
            )
        })
    }

    /// Fetch one persisted conversation summary.
    pub async fn get_conversation_summary(
        &self,
        conversation_id: &str,
    ) -> Result<Option<ChatConversationSummary>, ChatServiceError> {
        let row = sqlx::query_as::<_, ConversationRow>(
            "
            SELECT
                id, session_id, project_id, worktree_id, branch_name, provider,
                provider_thread_id, title, created_at_ms, updated_at_ms,
                last_activity_at_ms, last_message_at_ms, open_tab_id,
                archived_at_ms, selected_model, selected_effort, selected_permission_mode,
                last_run_state, last_error,
                last_reconciliation_state, last_reconciliation_error,
                (
                    SELECT used_tokens
                    FROM chat_context_usage
                    WHERE conversation_id = chat_conversations.id
                    LIMIT 1
                ) AS context_used_tokens,
                (
                    SELECT max_tokens
                    FROM chat_context_usage
                    WHERE conversation_id = chat_conversations.id
                    LIMIT 1
                ) AS context_max_tokens,
                (
                    SELECT percent_used
                    FROM chat_context_usage
                    WHERE conversation_id = chat_conversations.id
                    LIMIT 1
                ) AS context_percent_used,
                (
                    SELECT updated_at_ms
                    FROM chat_context_usage
                    WHERE conversation_id = chat_conversations.id
                    LIMIT 1
                ) AS context_updated_at_ms,
                (
                    SELECT COUNT(*)
                    FROM chat_pending_requests
                    WHERE conversation_id = chat_conversations.id
                        AND status IN ('pending', 'resolving')
                ) AS pending_request_count,
                (
                    SELECT id
                    FROM chat_pending_requests
                    WHERE conversation_id = chat_conversations.id
                        AND status IN ('pending', 'resolving')
                    ORDER BY updated_at_ms DESC, sequence DESC, id DESC
                    LIMIT 1
                ) AS latest_pending_request_id,
                (
                    SELECT kind
                    FROM chat_pending_requests
                    WHERE conversation_id = chat_conversations.id
                        AND status IN ('pending', 'resolving')
                    ORDER BY updated_at_ms DESC, sequence DESC, id DESC
                    LIMIT 1
                ) AS latest_pending_request_kind,
                (
                    SELECT status
                    FROM chat_pending_requests
                    WHERE conversation_id = chat_conversations.id
                        AND status IN ('pending', 'resolving')
                    ORDER BY updated_at_ms DESC, sequence DESC, id DESC
                    LIMIT 1
                ) AS latest_pending_request_status,
                revision
            FROM chat_conversations
            WHERE id = ?
            ",
        )
        .bind(conversation_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(conversation_from_row))
    }

    /// List persisted conversation summaries for a worktree/session scope.
    pub async fn list_conversations(
        &self,
        project_id: &str,
        worktree_id: &str,
        branch_name: &str,
        session_id: &str,
        scope: ChatConversationListScope,
        include_archived: bool,
    ) -> Result<Vec<ChatConversationSummary>, ChatServiceError> {
        let normalized_branch_name = normalize_branch_name(branch_name);
        let branch_filter = matches!(scope, ChatConversationListScope::Branch);
        let rows = sqlx::query_as::<_, ConversationRow>(
            "
            SELECT
                id, session_id, project_id, worktree_id, branch_name, provider,
                provider_thread_id, title, created_at_ms, updated_at_ms,
                last_activity_at_ms, last_message_at_ms, open_tab_id,
                archived_at_ms, selected_model, selected_effort, selected_permission_mode,
                last_run_state, last_error,
                last_reconciliation_state, last_reconciliation_error,
                (
                    SELECT used_tokens
                    FROM chat_context_usage
                    WHERE conversation_id = chat_conversations.id
                    LIMIT 1
                ) AS context_used_tokens,
                (
                    SELECT max_tokens
                    FROM chat_context_usage
                    WHERE conversation_id = chat_conversations.id
                    LIMIT 1
                ) AS context_max_tokens,
                (
                    SELECT percent_used
                    FROM chat_context_usage
                    WHERE conversation_id = chat_conversations.id
                    LIMIT 1
                ) AS context_percent_used,
                (
                    SELECT updated_at_ms
                    FROM chat_context_usage
                    WHERE conversation_id = chat_conversations.id
                    LIMIT 1
                ) AS context_updated_at_ms,
                (
                    SELECT COUNT(*)
                    FROM chat_pending_requests
                    WHERE conversation_id = chat_conversations.id
                        AND status IN ('pending', 'resolving')
                ) AS pending_request_count,
                (
                    SELECT id
                    FROM chat_pending_requests
                    WHERE conversation_id = chat_conversations.id
                        AND status IN ('pending', 'resolving')
                    ORDER BY updated_at_ms DESC, sequence DESC, id DESC
                    LIMIT 1
                ) AS latest_pending_request_id,
                (
                    SELECT kind
                    FROM chat_pending_requests
                    WHERE conversation_id = chat_conversations.id
                        AND status IN ('pending', 'resolving')
                    ORDER BY updated_at_ms DESC, sequence DESC, id DESC
                    LIMIT 1
                ) AS latest_pending_request_kind,
                (
                    SELECT status
                    FROM chat_pending_requests
                    WHERE conversation_id = chat_conversations.id
                        AND status IN ('pending', 'resolving')
                    ORDER BY updated_at_ms DESC, sequence DESC, id DESC
                    LIMIT 1
                ) AS latest_pending_request_status,
                revision
            FROM chat_conversations
            WHERE project_id = ?
                AND session_id = ?
                AND (
                    ? = 0
                    OR branch_name = ?
                    OR (branch_name IS NULL AND worktree_id = ?)
                )
                AND (? = 1 OR archived_at_ms IS NULL)
            ORDER BY updated_at_ms DESC, created_at_ms DESC, id DESC
            ",
        )
        .bind(project_id)
        .bind(session_id)
        .bind(if branch_filter { 1_i64 } else { 0_i64 })
        .bind(normalized_branch_name)
        .bind(worktree_id)
        .bind(if include_archived { 1_i64 } else { 0_i64 })
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(conversation_from_row).collect())
    }

    /// List summaries for all chats visible to a session.
    pub async fn list_session_conversations(
        &self,
        session_id: &str,
    ) -> Result<Vec<ChatConversationSummary>, ChatServiceError> {
        let rows = sqlx::query_as::<_, ConversationRow>(
            "
            SELECT
                id, session_id, project_id, worktree_id, branch_name, provider,
                provider_thread_id, title, created_at_ms, updated_at_ms,
                last_activity_at_ms, last_message_at_ms, open_tab_id,
                archived_at_ms, selected_model, selected_effort, selected_permission_mode,
                last_run_state, last_error,
                last_reconciliation_state, last_reconciliation_error,
                (
                    SELECT used_tokens
                    FROM chat_context_usage
                    WHERE conversation_id = chat_conversations.id
                    LIMIT 1
                ) AS context_used_tokens,
                (
                    SELECT max_tokens
                    FROM chat_context_usage
                    WHERE conversation_id = chat_conversations.id
                    LIMIT 1
                ) AS context_max_tokens,
                (
                    SELECT percent_used
                    FROM chat_context_usage
                    WHERE conversation_id = chat_conversations.id
                    LIMIT 1
                ) AS context_percent_used,
                (
                    SELECT updated_at_ms
                    FROM chat_context_usage
                    WHERE conversation_id = chat_conversations.id
                    LIMIT 1
                ) AS context_updated_at_ms,
                (
                    SELECT COUNT(*)
                    FROM chat_pending_requests
                    WHERE conversation_id = chat_conversations.id
                        AND status IN ('pending', 'resolving')
                ) AS pending_request_count,
                (
                    SELECT id
                    FROM chat_pending_requests
                    WHERE conversation_id = chat_conversations.id
                        AND status IN ('pending', 'resolving')
                    ORDER BY updated_at_ms DESC, sequence DESC, id DESC
                    LIMIT 1
                ) AS latest_pending_request_id,
                (
                    SELECT kind
                    FROM chat_pending_requests
                    WHERE conversation_id = chat_conversations.id
                        AND status IN ('pending', 'resolving')
                    ORDER BY updated_at_ms DESC, sequence DESC, id DESC
                    LIMIT 1
                ) AS latest_pending_request_kind,
                (
                    SELECT status
                    FROM chat_pending_requests
                    WHERE conversation_id = chat_conversations.id
                        AND status IN ('pending', 'resolving')
                    ORDER BY updated_at_ms DESC, sequence DESC, id DESC
                    LIMIT 1
                ) AS latest_pending_request_status,
                revision
            FROM chat_conversations
            WHERE session_id = ?
            ORDER BY updated_at_ms DESC, created_at_ms DESC, id DESC
            ",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(conversation_from_row).collect())
    }

    /// Backfill a legacy conversation branch when the opening worktree is
    /// unambiguous.
    pub async fn backfill_conversation_branch(
        &self,
        conversation_id: &str,
        branch_name: &str,
    ) -> Result<Option<ChatConversationSummary>, ChatServiceError> {
        let Some(branch_name) = normalize_branch_name(branch_name) else {
            return self.get_conversation_summary(conversation_id).await;
        };
        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_conversations
            SET branch_name = ?,
                updated_at_ms = ?,
                revision = revision + 1
            WHERE id = ? AND branch_name IS NULL
            ",
        )
        .bind(branch_name)
        .bind(now)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        self.emit_conversation_updated(conversation_id).await
    }

    /// Move all project chat history from an old branch name to a new one.
    pub async fn rename_project_branch(
        &self,
        project_id: &str,
        old_branch: &str,
        new_branch: &str,
    ) -> Result<Vec<ChatConversationSummary>, ChatServiceError> {
        let Some(old_branch) = normalize_branch_name(old_branch) else {
            return Ok(Vec::new());
        };
        let Some(new_branch) = normalize_branch_name(new_branch) else {
            return Ok(Vec::new());
        };
        if old_branch == new_branch {
            return Ok(Vec::new());
        }

        let ids = sqlx::query_scalar::<_, String>(
            "
            SELECT id
            FROM chat_conversations
            WHERE project_id = ? AND branch_name = ?
            ",
        )
        .bind(project_id)
        .bind(&old_branch)
        .fetch_all(&self.pool)
        .await?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }

        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_conversations
            SET branch_name = ?,
                updated_at_ms = ?,
                revision = revision + 1
            WHERE project_id = ? AND branch_name = ?
            ",
        )
        .bind(new_branch)
        .bind(now)
        .bind(project_id)
        .bind(old_branch)
        .execute(&self.pool)
        .await?;

        let mut updated = Vec::new();
        for id in ids {
            if let Some(summary) = self.emit_conversation_updated(&id).await? {
                updated.push(summary);
            }
        }
        Ok(updated)
    }

    /// Archive or unarchive a persisted conversation.
    pub async fn set_conversation_archived(
        self: &Arc<Self>,
        conversation_id: &str,
        archived: bool,
    ) -> Result<ChatConversationSummary, ChatServiceError> {
        let lock = self.operation_lock(conversation_id);
        let _guard = lock.lock().await;
        let existing = self
            .get_conversation_summary(conversation_id)
            .await?
            .ok_or_else(|| ChatServiceError::new(StatusCode::NOT_FOUND, "chat not found"))?;
        if archived && self.conversation_has_active_work(conversation_id).await? {
            return Err(ChatServiceError::new(
                StatusCode::CONFLICT,
                "chat has active work",
            ));
        }

        let now = now_ms() as i64;
        let archived_at = if archived { Some(now) } else { None };
        sqlx::query(
            "
            UPDATE chat_conversations
            SET archived_at_ms = ?,
                updated_at_ms = ?,
                revision = revision + 1
            WHERE id = ?
            ",
        )
        .bind(archived_at)
        .bind(now)
        .bind(&existing.id)
        .execute(&self.pool)
        .await?;
        self.emit_conversation_updated(&existing.id)
            .await?
            .ok_or_else(|| ChatServiceError::new(StatusCode::NOT_FOUND, "chat not found"))
    }

    /// Permanently delete one conversation and all related persisted state.
    pub async fn delete_conversation(
        self: &Arc<Self>,
        conversation_id: &str,
    ) -> Result<ChatConversationSummary, ChatServiceError> {
        let lock = self.operation_lock(conversation_id);
        let _guard = lock.lock().await;
        let summary = self
            .get_conversation_summary(conversation_id)
            .await?
            .ok_or_else(|| ChatServiceError::new(StatusCode::NOT_FOUND, "chat not found"))?;
        if self.conversation_has_active_work(conversation_id).await? {
            return Err(ChatServiceError::new(
                StatusCode::CONFLICT,
                "chat has active work",
            ));
        }

        self.unsubscribe_runtime(conversation_id).await?;
        self.delete_conversation_rows(conversation_id).await?;
        self.cleanup_conversation_runtime(conversation_id);
        self.events.emit(EventKind::ChatConversationDeleted {
            session_id: summary.session_id.clone(),
            conversation_id: summary.id.clone(),
            project_id: summary.project_id.clone(),
            branch_name: summary.branch_name.clone(),
        });
        Ok(summary)
    }

    /// Permanently delete all chat history for a project.
    pub async fn delete_project_conversations(
        self: &Arc<Self>,
        project_id: &str,
    ) -> Result<Vec<ChatConversationSummary>, ChatServiceError> {
        let summaries = sqlx::query_as::<_, ConversationRow>(
            "
            SELECT
                id, session_id, project_id, worktree_id, branch_name, provider,
                provider_thread_id, title, created_at_ms, updated_at_ms,
                last_activity_at_ms, last_message_at_ms, open_tab_id,
                archived_at_ms, selected_model, selected_effort,
                selected_permission_mode, last_run_state, last_error,
                last_reconciliation_state, last_reconciliation_error,
                NULL AS context_used_tokens,
                NULL AS context_max_tokens,
                NULL AS context_percent_used,
                NULL AS context_updated_at_ms,
                0 AS pending_request_count,
                NULL AS latest_pending_request_id,
                NULL AS latest_pending_request_kind,
                NULL AS latest_pending_request_status,
                revision
            FROM chat_conversations
            WHERE project_id = ?
            ",
        )
        .bind(project_id)
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(conversation_from_row)
        .collect::<Vec<_>>();

        let mut lock_guards = Vec::with_capacity(summaries.len());
        for summary in &summaries {
            let guard = self.operation_lock(&summary.id).lock_owned().await;
            self.unsubscribe_runtime(&summary.id).await?;
            lock_guards.push(guard);
        }
        self.delete_project_conversation_rows(project_id).await?;
        for summary in &summaries {
            self.cleanup_conversation_runtime(&summary.id);
        }
        for summary in &summaries {
            self.events.emit(EventKind::ChatConversationDeleted {
                session_id: summary.session_id.clone(),
                conversation_id: summary.id.clone(),
                project_id: summary.project_id.clone(),
                branch_name: summary.branch_name.clone(),
            });
        }
        Ok(summaries)
    }

    /// List lightweight pending requests visible to a session.
    pub async fn list_session_pending_request_summaries(
        &self,
        session_id: &str,
    ) -> Result<Vec<ChatPendingRequestSummary>, ChatServiceError> {
        let rows = sqlx::query_as::<_, PendingRequestSummaryRow>(
            "
            SELECT
                request.id, request.conversation_id, request.method,
                request.kind, request.status, request.created_at_ms,
                request.updated_at_ms
            FROM chat_pending_requests request
            INNER JOIN chat_conversations conversation
                ON conversation.id = request.conversation_id
            WHERE conversation.session_id = ?
                AND request.status IN ('pending', 'resolving')
            ORDER BY request.updated_at_ms DESC, request.sequence DESC, request.id DESC
            ",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(pending_request_summary_from_row)
            .collect())
    }

    /// List latest context usage visible to a session.
    pub async fn list_session_context_usage(
        &self,
        session_id: &str,
    ) -> Result<Vec<ChatContextUsage>, ChatServiceError> {
        let rows = sqlx::query_as::<_, ContextUsageRow>(
            "
            SELECT
                usage.id, usage.conversation_id, usage.provider_thread_id,
                usage.used_tokens, usage.max_tokens, usage.percent_used,
                usage.total_processed_tokens, usage.metadata_json,
                usage.updated_at_ms
            FROM chat_context_usage usage
            INNER JOIN chat_conversations conversation
                ON conversation.id = usage.conversation_id
            WHERE conversation.session_id = ?
            ORDER BY usage.updated_at_ms DESC, usage.id DESC
            ",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(context_usage_from_row).collect())
    }

    /// List latest reconciliation summaries visible to a session.
    pub async fn list_session_reconciliations(
        &self,
        session_id: &str,
    ) -> Result<Vec<ChatReconciliation>, ChatServiceError> {
        let rows = sqlx::query_as::<_, ReconciliationRow>(
            "
            SELECT
                reconciliation.id, reconciliation.conversation_id,
                reconciliation.provider_thread_id, reconciliation.status,
                reconciliation.reason, reconciliation.started_at_ms,
                reconciliation.finished_at_ms, reconciliation.error_message,
                reconciliation.owner_generation, reconciliation.created_at_ms,
                reconciliation.updated_at_ms
            FROM chat_reconciliations reconciliation
            INNER JOIN chat_conversations conversation
                ON conversation.id = reconciliation.conversation_id
            WHERE conversation.session_id = ?
                AND reconciliation.id = (
                    SELECT latest.id
                    FROM chat_reconciliations latest
                    WHERE latest.conversation_id = reconciliation.conversation_id
                    ORDER BY latest.updated_at_ms DESC, latest.id DESC
                    LIMIT 1
                )
            ORDER BY reconciliation.updated_at_ms DESC, reconciliation.id DESC
            ",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(reconciliation_from_row).collect())
    }

    /// Fetch one conversation transcript plus latest run state.
    pub async fn get_conversation_detail(
        &self,
        conversation_id: &str,
    ) -> Result<Option<ChatConversationDetail>, ChatServiceError> {
        let Some(conversation) = self.get_conversation_summary(conversation_id).await? else {
            return Ok(None);
        };

        let message_rows = sqlx::query_as::<_, MessageRow>(
            "
            SELECT
                id, conversation_id, turn_id, item_id, provider_turn_id,
                provider_item_id, role, status, content_text, reasoning_text,
                sequence, created_at_ms, updated_at_ms
            FROM chat_messages
            WHERE conversation_id = ?
            ORDER BY sequence ASC, created_at_ms ASC, id ASC
            ",
        )
        .bind(conversation_id)
        .fetch_all(&self.pool)
        .await?;
        let latest_run = sqlx::query_as::<_, RunRow>(
            "
            SELECT
                id, conversation_id, turn_id, provider_turn_id, status,
                started_at_ms, finished_at_ms, error_message
            FROM chat_runs
            WHERE conversation_id = ?
            ORDER BY started_at_ms DESC, id DESC
            LIMIT 1
            ",
        )
        .bind(conversation_id)
        .fetch_optional(&self.pool)
        .await?;
        let turn_rows = sqlx::query_as::<_, TurnRow>(
            "
            SELECT
                id, conversation_id, run_id, user_message_id,
                assistant_message_id, provider_turn_id, status,
                started_at_ms, completed_at_ms, error_message,
                reconciliation_status, reconciled_at_ms,
                reconciliation_error,
                created_at_ms, updated_at_ms
            FROM chat_turns
            WHERE conversation_id = ?
            ORDER BY started_at_ms ASC, id ASC
            ",
        )
        .bind(conversation_id)
        .fetch_all(&self.pool)
        .await?;
        let item_rows = sqlx::query_as::<_, ItemRow>(
            "
            SELECT
                id, conversation_id, turn_id, provider_turn_id,
                provider_item_id, kind, status, role, sequence, title,
                summary, metadata_json, created_at_ms, updated_at_ms,
                completed_at_ms
            FROM chat_items
            WHERE conversation_id = ?
            ORDER BY sequence ASC, created_at_ms ASC, id ASC
            ",
        )
        .bind(conversation_id)
        .fetch_all(&self.pool)
        .await?;
        let plan_rows = sqlx::query_as::<_, PlanRow>(
            "
            SELECT
                id, conversation_id, turn_id, item_id, provider_turn_id,
                provider_item_id, kind, status, content_text, steps_json,
                metadata_json, owner_generation, sequence, created_at_ms,
                updated_at_ms, completed_at_ms
            FROM chat_plans
            WHERE conversation_id = ?
            ORDER BY sequence ASC, created_at_ms ASC, id ASC
            ",
        )
        .bind(conversation_id)
        .fetch_all(&self.pool)
        .await?;
        let diff_rows = sqlx::query_as::<_, DiffSummaryRow>(
            "
            SELECT
                id, conversation_id, turn_id, provider_turn_id,
                changed_file_count, additions, deletions, files_json,
                metadata_json, owner_generation, sequence, created_at_ms,
                updated_at_ms
            FROM chat_diff_summaries
            WHERE conversation_id = ?
            ORDER BY sequence ASC, created_at_ms ASC, id ASC
            ",
        )
        .bind(conversation_id)
        .fetch_all(&self.pool)
        .await?;
        let context_usage = sqlx::query_as::<_, ContextUsageRow>(
            "
            SELECT
                id, conversation_id, provider_thread_id, used_tokens,
                max_tokens, percent_used, total_processed_tokens,
                metadata_json, updated_at_ms
            FROM chat_context_usage
            WHERE conversation_id = ?
            LIMIT 1
            ",
        )
        .bind(conversation_id)
        .fetch_optional(&self.pool)
        .await?;
        let pending_rows = sqlx::query_as::<_, PendingRequestRow>(
            "
            SELECT
                id, conversation_id, turn_id, item_id, provider_request_id,
                provider_turn_id, provider_item_id, method, kind, status,
                decision, payload_json, response_json, error_message,
                owner_generation, sequence, created_at_ms, updated_at_ms,
                resolved_at_ms
            FROM chat_pending_requests
            WHERE conversation_id = ?
            ORDER BY sequence ASC, created_at_ms ASC, id ASC
            ",
        )
        .bind(conversation_id)
        .fetch_all(&self.pool)
        .await?;
        let latest_reconciliation = sqlx::query_as::<_, ReconciliationRow>(
            "
            SELECT
                id, conversation_id, provider_thread_id, status, reason,
                started_at_ms, finished_at_ms, error_message,
                owner_generation, created_at_ms, updated_at_ms
            FROM chat_reconciliations
            WHERE conversation_id = ?
            ORDER BY updated_at_ms DESC, id DESC
            LIMIT 1
            ",
        )
        .bind(conversation_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(Some(ChatConversationDetail {
            conversation,
            messages: message_rows.into_iter().map(message_from_row).collect(),
            turns: turn_rows.into_iter().map(turn_from_row).collect(),
            items: item_rows.into_iter().map(item_from_row).collect(),
            plans: plan_rows.into_iter().map(plan_from_row).collect(),
            diff_summaries: diff_rows.into_iter().map(diff_summary_from_row).collect(),
            context_usage: context_usage.map(context_usage_from_row),
            pending_requests: pending_rows
                .into_iter()
                .map(pending_request_from_row)
                .collect(),
            latest_reconciliation: latest_reconciliation.map(reconciliation_from_row),
            latest_run: latest_run.map(run_from_row),
        }))
    }

    /// Fetch one activity item with its persisted output stream.
    pub async fn get_activity_detail(
        &self,
        conversation_id: &str,
        item_id: &str,
    ) -> Result<Option<ChatActivityDetail>, ChatServiceError> {
        let Some(item) = self.get_item_by_id(conversation_id, item_id).await? else {
            return Ok(None);
        };
        let output_rows = sqlx::query_as::<_, ItemOutputRow>(
            "
            SELECT
                id, conversation_id, item_id, stream_kind, sequence,
                content_text, byte_count, created_at_ms, updated_at_ms
            FROM chat_item_outputs
            WHERE conversation_id = ? AND item_id = ?
            ORDER BY sequence ASC, created_at_ms ASC, id ASC
            ",
        )
        .bind(conversation_id)
        .bind(item_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(Some(ChatActivityDetail {
            item,
            outputs: output_rows.into_iter().map(item_output_from_row).collect(),
        }))
    }

    /// Find the currently open tab for a conversation if it still exists.
    pub async fn open_tab_id_for_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<Option<String>, ChatServiceError> {
        Ok(
            sqlx::query("SELECT open_tab_id FROM chat_conversations WHERE id = ?")
                .bind(conversation_id)
                .fetch_optional(&self.pool)
                .await?
                .and_then(|row| row.try_get::<Option<String>, _>("open_tab_id").ok())
                .flatten(),
        )
    }

    /// Atomically claim the open-tab slot or return the existing canonical tab.
    pub async fn claim_open_tab_id_for_conversation(
        &self,
        conversation_id: &str,
        desired_tab_id: &str,
    ) -> Result<String, ChatServiceError> {
        let now = now_ms() as i64;
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query("SELECT open_tab_id FROM chat_conversations WHERE id = ?")
            .bind(conversation_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| ChatServiceError::new(StatusCode::NOT_FOUND, "chat not found"))?;
        if let Some(existing) = row
            .try_get::<Option<String>, _>("open_tab_id")
            .ok()
            .flatten()
            && !existing.is_empty()
        {
            tx.commit().await?;
            return Ok(existing);
        }

        sqlx::query(
            "
            UPDATE chat_conversations
            SET open_tab_id = ?, updated_at_ms = ?
            WHERE id = ?
            ",
        )
        .bind(desired_tab_id)
        .bind(now)
        .bind(conversation_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        let _ = self.emit_conversation_updated(conversation_id).await?;
        Ok(desired_tab_id.to_string())
    }

    /// Update the open-tab mapping for a conversation.
    pub async fn set_open_tab_id(
        &self,
        conversation_id: &str,
        open_tab_id: Option<&str>,
    ) -> Result<Option<ChatConversationSummary>, ChatServiceError> {
        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_conversations
            SET open_tab_id = ?, updated_at_ms = ?
            WHERE id = ?
            ",
        )
        .bind(open_tab_id)
        .bind(now)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        self.emit_conversation_updated(conversation_id).await
    }

    /// Clear any conversation rows pointing at a closed chat tab.
    pub async fn clear_open_tab_id_for_tab(
        &self,
        tab_id: &str,
    ) -> Result<Vec<ChatConversationSummary>, ChatServiceError> {
        let now = now_ms() as i64;
        let ids = sqlx::query("SELECT id FROM chat_conversations WHERE open_tab_id = ?")
            .bind(tab_id)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .filter_map(|row| row.try_get::<String, _>("id").ok())
            .collect::<Vec<_>>();

        if ids.is_empty() {
            return Ok(Vec::new());
        }

        sqlx::query(
            "
            UPDATE chat_conversations
            SET open_tab_id = NULL, updated_at_ms = ?
            WHERE open_tab_id = ?
            ",
        )
        .bind(now)
        .bind(tab_id)
        .execute(&self.pool)
        .await?;

        let mut updated = Vec::new();
        for conversation_id in ids {
            if let Some(summary) = self.emit_conversation_updated(&conversation_id).await? {
                updated.push(summary);
            }
        }
        Ok(updated)
    }

    /// Touch an existing runtime without starting a new process.
    pub async fn touch_runtime(&self, conversation_id: &str) {
        if let Some(runtime) = self.runtimes.get(conversation_id) {
            let mut state = runtime.state.lock().await;
            state.idle_generation = state.idle_generation.saturating_add(1);
            state.inactive_deadline_at = None;
        }
    }

    /// Return the shared Codex app-server process status.
    pub async fn app_server_status(&self) -> ChatAppServerStatus {
        self.app_server.status().await
    }

    /// List live thread stream summaries visible to a session.
    pub async fn list_thread_stream_statuses(
        &self,
        session_id: &str,
    ) -> Result<Vec<ChatThreadStreamStatus>, ChatServiceError> {
        let mut statuses = Vec::new();
        for runtime in &self.runtimes {
            let state = runtime.state.lock().await.clone();
            if state.session_id != session_id {
                continue;
            }
            statuses.push(thread_stream_status_from_state(runtime.key(), state, None));
        }
        statuses.sort_by(|left, right| {
            left.updated_at
                .cmp(&right.updated_at)
                .reverse()
                .then_with(|| left.conversation_id.cmp(&right.conversation_id))
        });
        Ok(statuses)
    }

    /// List live runtime summaries visible to a session.
    pub async fn list_runtime_statuses(
        &self,
        session_id: &str,
    ) -> Result<Vec<ChatRuntimeStatus>, ChatServiceError> {
        let mut statuses = Vec::new();
        for runtime in &self.runtimes {
            let state = runtime.state.lock().await;
            if state.session_id != session_id {
                continue;
            }
            statuses.push(ChatRuntimeStatus {
                conversation_id: runtime.key().clone(),
                session_id: state.session_id.clone(),
                project_id: state.project_id.clone(),
                worktree_id: state.worktree_id.clone(),
                lifecycle: state.lifecycle,
                active_run_id: state.active_run_id.clone(),
                active_message_id: state.active_message_id.clone(),
                provider_thread_id: state.provider_thread_id.clone(),
                last_error: state.last_error.clone(),
                updated_at: now_ms(),
            });
        }
        statuses.sort_by(|left, right| {
            left.updated_at
                .cmp(&right.updated_at)
                .reverse()
                .then_with(|| left.conversation_id.cmp(&right.conversation_id))
        });
        Ok(statuses)
    }

    /// List Codex models available to the current app-server installation.
    pub async fn list_models(&self) -> Result<Vec<ChatModelOption>, ChatServiceError> {
        let response = self
            .app_server
            .request("model/list", json!({ "includeHidden": false }))
            .await?;

        let models = response
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(model_option_from_value)
            .collect::<Vec<_>>();
        Ok(models)
    }

    /// Persist conversation-level model settings used for future turns.
    pub async fn update_conversation_settings(
        &self,
        conversation_id: &str,
        patch: ChatConversationSettingsPatch,
    ) -> Result<ChatConversationSummary, ChatServiceError> {
        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_conversations
            SET
                selected_model = ?,
                selected_effort = ?,
                selected_permission_mode = ?,
                updated_at_ms = ?,
                last_activity_at_ms = ?,
                revision = revision + 1
            WHERE id = ?
            ",
        )
        .bind(normalize_model_override(patch.selected_model))
        .bind(
            patch
                .selected_effort
                .map(|value| value.as_str().to_string()),
        )
        .bind(
            patch
                .selected_permission_mode
                .map(|value| value.as_str().to_string()),
        )
        .bind(now)
        .bind(now)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;

        self.emit_conversation_updated(conversation_id)
            .await?
            .ok_or_else(|| ChatServiceError::new(StatusCode::NOT_FOUND, "chat not found"))
    }

    /// Persist a new user message, ensure a runtime exists, and start a turn.
    pub async fn send_message(
        self: &Arc<Self>,
        conversation_id: &str,
        worktree_path: &str,
        text: String,
    ) -> Result<(), ChatServiceError> {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err(ChatServiceError::new(
                StatusCode::BAD_REQUEST,
                "message cannot be empty",
            ));
        }

        let lock = self.operation_lock(conversation_id);
        let _guard = lock.lock().await;
        let conversation = self
            .get_conversation_summary(conversation_id)
            .await?
            .ok_or_else(|| ChatServiceError::new(StatusCode::NOT_FOUND, "chat not found"))?;
        if conversation.archived_at.is_some() {
            return Err(ChatServiceError::new(
                StatusCode::CONFLICT,
                "chat is archived",
            ));
        }
        let user_message_id = uuid::Uuid::new_v4().to_string();
        let assistant_message_id = uuid::Uuid::new_v4().to_string();
        let run_id = uuid::Uuid::new_v4().to_string();
        let turn_id = uuid::Uuid::new_v4().to_string();

        let runtime = self
            .ensure_runtime(conversation_id, &conversation, worktree_path)
            .await?;

        self.persist_run_start(
            &conversation,
            &user_message_id,
            &assistant_message_id,
            &run_id,
            &turn_id,
            &text,
        )
        .await?;
        {
            let mut state = runtime.state.lock().await;
            state.active_run_id = Some(run_id.clone());
            state.active_turn_id = Some(turn_id.clone());
            state.active_message_id = Some(assistant_message_id.clone());
            state.lifecycle = ChatRuntimeLifecycle::Running;
            state.reset_text_projection_state();
            state.active_error = None;
            state.last_error = None;
            state.inactive_deadline_at = None;
            state.idle_generation = state.idle_generation.saturating_add(1);
        }
        self.emit_thread_stream_status(conversation_id, &runtime.state, None)
            .await;

        let thread_id = runtime
            .state
            .lock()
            .await
            .provider_thread_id
            .clone()
            .ok_or_else(|| {
                ChatServiceError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "chat runtime missing thread id",
                )
            })?;
        let turn_params = build_turn_start_params(&thread_id, worktree_path, &text, &conversation);

        let turn_response = self
            .app_server
            .request("turn/start", Value::Object(turn_params))
            .await?;
        let provider_turn_id = extract_turn_id(&turn_response);
        if let Some(provider_turn_id) = provider_turn_id.as_deref() {
            self.register_turn_route(conversation_id, &runtime, provider_turn_id)
                .await;
        }
        self.attach_turn_to_run(
            conversation_id,
            &run_id,
            &turn_id,
            &assistant_message_id,
            provider_turn_id.as_deref(),
        )
        .await?;

        Ok(())
    }

    /// Interrupt the active provider turn if a runtime is present.
    pub async fn interrupt(
        self: &Arc<Self>,
        conversation_id: &str,
    ) -> Result<(), ChatServiceError> {
        let lock = self.operation_lock(conversation_id);
        let _guard = lock.lock().await;
        let runtime = self
            .runtimes
            .get(conversation_id)
            .map(|entry| entry.clone())
            .ok_or_else(|| ChatServiceError::new(StatusCode::CONFLICT, "chat is not running"))?;
        let thread_id = runtime
            .state
            .lock()
            .await
            .provider_thread_id
            .clone()
            .ok_or_else(|| {
                ChatServiceError::new(StatusCode::CONFLICT, "chat runtime missing thread id")
            })?;
        self.app_server
            .request("turn/interrupt", json!({ "threadId": thread_id }))
            .await?;
        Ok(())
    }

    async fn ensure_runtime(
        self: &Arc<Self>,
        conversation_id: &str,
        conversation: &ChatConversationSummary,
        worktree_path: &str,
    ) -> Result<RuntimeEntry, ChatServiceError> {
        let runtime = if let Some(existing) = self.runtimes.get(conversation_id) {
            existing.clone()
        } else {
            let runtime = RuntimeEntry {
                state: Arc::new(Mutex::new(RuntimeState::new(conversation, worktree_path))),
            };
            self.runtimes
                .insert(conversation_id.to_string(), runtime.clone());
            runtime
        };

        let client = self.app_server.ensure_client().await?;
        self.ensure_provider_event_loop(client);
        self.emit_app_server_status().await;

        let already_resumed = {
            let mut state = runtime.state.lock().await;
            state.worktree_path = worktree_path.to_string();
            state.idle_generation = state.idle_generation.saturating_add(1);
            state.inactive_deadline_at = None;
            matches!(
                state.stream_lifecycle.resume_state(),
                ThreadStreamResumeState::Resumed
            ) && state.provider_thread_id.is_some()
        };
        if already_resumed {
            return Ok(runtime);
        }

        {
            let mut state = runtime.state.lock().await;
            state.stream_lifecycle.mark_resuming();
            state.lifecycle = ChatRuntimeLifecycle::Starting;
            state.last_error = None;
        }
        self.emit_thread_stream_status(conversation_id, &runtime.state, None)
            .await;

        let resume_or_start = if let Some(provider_thread_id) = &conversation.provider_thread_id {
            let mut params = serde_json::Map::new();
            params.insert(
                "threadId".to_string(),
                Value::String(provider_thread_id.clone()),
            );
            params.insert("cwd".to_string(), Value::String(worktree_path.to_string()));
            apply_thread_permission_mode(&mut params, conversation.selected_permission_mode);
            let result = self
                .app_server
                .request("thread/resume", Value::Object(params))
                .await?;
            if has_blank_model_field(&result) {
                tracing::warn!(
                    conversation_id,
                    provider_thread_id,
                    "resumed codex thread has blank model; starting a replacement thread"
                );
                start_provider_thread(
                    &self.app_server,
                    worktree_path,
                    conversation.selected_model.as_deref(),
                    conversation.selected_permission_mode,
                )
                .await?
            } else {
                (
                    extract_thread_id(&result).unwrap_or_else(|| provider_thread_id.clone()),
                    result,
                )
            }
        } else {
            start_provider_thread(
                &self.app_server,
                worktree_path,
                conversation.selected_model.as_deref(),
                conversation.selected_permission_mode,
            )
            .await?
        };
        let (provider_thread_id, thread_response) = resume_or_start;

        {
            let mut state = runtime.state.lock().await;
            state.owner_generation = self.stream_owner_generation.load(Ordering::Acquire);
            state.provider_thread_id = Some(provider_thread_id.clone());
            state.lifecycle = ChatRuntimeLifecycle::Ready;
            state.stream_lifecycle.mark_resumed();
            state.inactive_deadline_at = None;
            state.last_error = None;
            state.idle_generation = state.idle_generation.saturating_add(1);
        }
        self.register_provider_thread_route(conversation_id, &runtime, &provider_thread_id)
            .await;

        self.persist_provider_thread_id(conversation_id, &provider_thread_id)
            .await?;
        self.persist_thread_preferences(
            conversation_id,
            extract_model(&thread_response),
            extract_reasoning_effort(&thread_response),
        )
        .await?;
        self.emit_thread_stream_status(conversation_id, &runtime.state, None)
            .await;
        self.reconcile_inflight_run_if_needed(conversation_id, &runtime, worktree_path)
            .await?;
        Ok(runtime)
    }

    fn ensure_provider_event_loop(self: &Arc<Self>, client: CodexAppServerConnectionRef) {
        if self.app_event_loop_started.swap(true, Ordering::AcqRel) {
            return;
        }

        let service = self.clone();
        tokio::spawn(async move {
            let mut rx = client.subscribe();
            loop {
                match rx.recv().await {
                    Ok(CodexStreamEvent::ServerRequest {
                        id,
                        method,
                        params,
                        thread_id,
                        mut route_hints,
                    }) => {
                        if route_hints.thread_id.is_none() {
                            route_hints.thread_id = thread_id;
                        }
                        let response = if let Some((conversation_id, runtime)) =
                            service.runtime_for_provider_event(&route_hints).await
                        {
                            service
                                .register_route_hints(&conversation_id, &runtime, &route_hints)
                                .await;
                            service
                                .register_pending_server_request(
                                    &conversation_id,
                                    &runtime,
                                    &method,
                                    &route_hints,
                                )
                                .await;
                            match service
                                .handle_provider_request(
                                    id.clone(),
                                    &conversation_id,
                                    &runtime,
                                    &method,
                                    params,
                                    &route_hints,
                                )
                                .await
                            {
                                Ok(Some(result)) => {
                                    service.app_server.respond_result(id, result).await
                                }
                                Ok(None) => Ok(()),
                                Err(error) => Err(error),
                            }
                        } else {
                            tracing::warn!(
                                method,
                                "unroutable codex app-server request; declining"
                            );
                            service
                                .app_server
                                .respond_result(id, json!({ "decision": "decline" }))
                                .await
                        };
                        if let Err(error) = response {
                            tracing::warn!(method, "chat provider request failed: {error}");
                        }
                    }
                    Ok(CodexStreamEvent::Notification {
                        method,
                        params,
                        thread_id,
                        mut route_hints,
                    }) => {
                        if route_hints.thread_id.is_none() {
                            route_hints.thread_id = thread_id;
                        }
                        let Some((conversation_id, runtime)) =
                            service.runtime_for_provider_event(&route_hints).await
                        else {
                            if is_global_provider_notification(&method) {
                                tracing::debug!(
                                    method,
                                    "unroutable global codex app-server notification"
                                );
                            } else {
                                tracing::warn!(method, "unroutable codex app-server notification");
                            }
                            continue;
                        };
                        service
                            .register_route_hints(&conversation_id, &runtime, &route_hints)
                            .await;
                        if let Err(error) = service
                            .handle_provider_notification(
                                &conversation_id,
                                &runtime,
                                &method,
                                params,
                            )
                            .await
                        {
                            tracing::warn!(
                                conversation_id,
                                "chat provider notification failed: {error}"
                            );
                        }
                    }
                    Ok(CodexStreamEvent::Closed { reason }) => {
                        service
                            .app_event_loop_started
                            .store(false, Ordering::Release);
                        let _ = service.handle_provider_closed(reason).await;
                        break;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => {
                        service
                            .app_event_loop_started
                            .store(false, Ordering::Release);
                        break;
                    }
                }
            }
        });
    }

    async fn runtime_for_provider_event(
        &self,
        route_hints: &RouteHints,
    ) -> Option<(String, RuntimeEntry)> {
        if let Some(thread_id) = route_hints.thread_id.as_deref()
            && let Some(runtime) = self
                .runtime_for_route_entry(self.thread_to_conversation.get(thread_id).as_deref())
                .await
        {
            return Some(runtime);
        }
        if let Some(turn_id) = route_hints.turn_id.as_deref()
            && let Some(runtime) = self
                .runtime_for_route_entry(self.turn_to_conversation.get(turn_id).as_deref())
                .await
        {
            return Some(runtime);
        }
        if let Some(item_id) = route_hints.item_id.as_deref()
            && let Some(runtime) = self
                .runtime_for_route_entry(self.item_to_conversation.get(item_id).as_deref())
                .await
        {
            return Some(runtime);
        }
        if let Some(request_id) = route_hints.request_id.as_deref()
            && let Some(route) = self.server_request_to_conversation.get(request_id)
            && let Some(runtime) = self.runtime_for_route_entry(Some(&route.route)).await
        {
            return Some(runtime);
        }

        let runtimes = self
            .runtimes
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect::<Vec<_>>();
        if let Some(thread_id) = route_hints.thread_id.as_deref() {
            for (conversation_id, runtime) in &runtimes {
                let state = runtime.state.lock().await;
                if state.provider_thread_id.as_deref() == Some(thread_id) {
                    self.thread_to_conversation.insert(
                        thread_id.to_string(),
                        RouteEntry {
                            conversation_id: conversation_id.clone(),
                            owner_generation: state.owner_generation,
                        },
                    );
                    return Some((conversation_id.clone(), runtime.clone()));
                }
            }
        }

        if route_hints.thread_id.is_some()
            || route_hints.turn_id.is_some()
            || route_hints.item_id.is_some()
            || route_hints.request_id.is_some()
        {
            return None;
        }

        let mut active = Vec::new();
        for (conversation_id, runtime) in runtimes {
            let state = runtime.state.lock().await;
            if state.active_run_id.is_some()
                || matches!(state.lifecycle, ChatRuntimeLifecycle::Running)
            {
                active.push((conversation_id, runtime.clone()));
            }
        }
        if active.len() == 1 {
            active.into_iter().next()
        } else {
            None
        }
    }

    async fn runtime_for_route_entry(
        &self,
        route: Option<&RouteEntry>,
    ) -> Option<(String, RuntimeEntry)> {
        let route = route?;
        let runtime = self
            .runtimes
            .get(&route.conversation_id)
            .map(|entry| entry.value().clone())?;
        let state = runtime.state.lock().await;
        if state.owner_generation != route.owner_generation {
            return None;
        }
        drop(state);
        Some((route.conversation_id.clone(), runtime))
    }

    async fn register_provider_thread_route(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        thread_id: &str,
    ) {
        let owner_generation = runtime.state.lock().await.owner_generation;
        self.thread_to_conversation.insert(
            thread_id.to_string(),
            RouteEntry {
                conversation_id: conversation_id.to_string(),
                owner_generation,
            },
        );
    }

    async fn register_turn_route(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        turn_id: &str,
    ) {
        let owner_generation = runtime.state.lock().await.owner_generation;
        self.turn_to_conversation.insert(
            turn_id.to_string(),
            RouteEntry {
                conversation_id: conversation_id.to_string(),
                owner_generation,
            },
        );
    }

    async fn register_item_route(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        item_id: &str,
    ) {
        let owner_generation = runtime.state.lock().await.owner_generation;
        self.item_to_conversation.insert(
            item_id.to_string(),
            RouteEntry {
                conversation_id: conversation_id.to_string(),
                owner_generation,
            },
        );
    }

    async fn register_route_hints(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        route_hints: &RouteHints,
    ) {
        if let Some(thread_id) = route_hints.thread_id.as_deref() {
            self.register_provider_thread_route(conversation_id, runtime, thread_id)
                .await;
        }
        if let Some(turn_id) = route_hints.turn_id.as_deref() {
            self.register_turn_route(conversation_id, runtime, turn_id)
                .await;
        }
        if let Some(item_id) = route_hints.item_id.as_deref() {
            self.register_item_route(conversation_id, runtime, item_id)
                .await;
        }
    }

    async fn register_pending_server_request(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        method: &str,
        route_hints: &RouteHints,
    ) {
        let Some(request_id) = route_hints.request_id.as_deref() else {
            return;
        };
        let owner_generation = runtime.state.lock().await.owner_generation;
        self.server_request_to_conversation.insert(
            request_id.to_string(),
            PendingServerRequestRoute {
                route: RouteEntry {
                    conversation_id: conversation_id.to_string(),
                    owner_generation,
                },
                method: method.to_string(),
                turn_id: route_hints.turn_id.clone(),
                item_id: route_hints.item_id.clone(),
            },
        );
    }

    fn clear_pending_server_request(&self, request_id: &str) {
        if let Some((_, route)) = self.server_request_to_conversation.remove(request_id) {
            tracing::trace!(
                request_id,
                method = route.method,
                turn_id = route.turn_id.as_deref().unwrap_or(""),
                item_id = route.item_id.as_deref().unwrap_or(""),
                "cleared codex app-server request route"
            );
        }
        if let Some((_, responder)) = self.pending_server_responders.remove(request_id) {
            self.pending_server_responders
                .remove(&responder.provider_request_id);
        }
    }

    fn clear_route_indexes(&self) {
        self.thread_to_conversation.clear();
        self.turn_to_conversation.clear();
        self.item_to_conversation.clear();
        self.server_request_to_conversation.clear();
        self.pending_server_responders.clear();
    }

    async fn persist_provider_request(
        self: &Arc<Self>,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        request: PersistProviderRequest,
    ) -> Result<ChatPendingRequest, ChatServiceError> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let provider_request_id = request
            .route_hints
            .request_id
            .clone()
            .unwrap_or_else(|| provider_request_id_from_jsonrpc_id(&request.jsonrpc_id));
        let (owner_generation, provider_turn_id, provider_item_id) = {
            let state = runtime.state.lock().await;
            (
                state.owner_generation,
                request
                    .route_hints
                    .turn_id
                    .clone()
                    .or(state.active_turn_id.clone()),
                request.route_hints.item_id.clone(),
            )
        };
        let now = now_ms() as i64;
        let next_sequence = sqlx::query(
            "
            SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
            FROM chat_pending_requests
            WHERE conversation_id = ?
            ",
        )
        .bind(conversation_id)
        .fetch_one(&self.pool)
        .await?
        .try_get::<i64, _>("next_sequence")
        .unwrap_or(1);
        let payload_json = compact_payload_json(&request.params);
        let decision_text = request
            .decision
            .as_ref()
            .map(pending_request_decision_as_str);
        sqlx::query(
            "
            INSERT INTO chat_pending_requests (
                id, conversation_id, turn_id, item_id, provider_request_id,
                provider_turn_id, provider_item_id, method, kind, status,
                decision, payload_json, response_json, error_message,
                owner_generation, sequence, created_at_ms, updated_at_ms,
                resolved_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
            ",
        )
        .bind(&request_id)
        .bind(conversation_id)
        .bind(request.route_hints.turn_id.as_deref())
        .bind(request.route_hints.item_id.as_deref())
        .bind(&provider_request_id)
        .bind(provider_turn_id.as_deref())
        .bind(provider_item_id.as_deref())
        .bind(&request.method)
        .bind(pending_request_kind_for_method(&request.method).as_str())
        .bind(request.status.as_str())
        .bind(decision_text)
        .bind(payload_json)
        .bind(&request.error_message)
        .bind(owner_generation as i64)
        .bind(next_sequence)
        .bind(now)
        .bind(now)
        .bind(if request.status.is_attention() {
            None
        } else {
            Some(now)
        })
        .execute(&self.pool)
        .await?;

        if request.status.is_attention() {
            let responder = PendingServerResponder {
                jsonrpc_id: request.jsonrpc_id,
                conversation_id: conversation_id.to_string(),
                provider_request_id: provider_request_id.clone(),
                owner_generation,
            };
            self.pending_server_responders
                .insert(request_id.clone(), responder.clone());
            self.pending_server_responders
                .insert(provider_request_id.clone(), responder);
        }

        self.get_pending_request_by_id(conversation_id, &request_id)
            .await?
            .ok_or_else(|| {
                ChatServiceError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "pending request missing after insert",
                )
            })
    }

    async fn get_pending_request_by_id(
        &self,
        conversation_id: &str,
        request_id: &str,
    ) -> Result<Option<ChatPendingRequest>, ChatServiceError> {
        let row = sqlx::query_as::<_, PendingRequestRow>(
            "
            SELECT
                id, conversation_id, turn_id, item_id, provider_request_id,
                provider_turn_id, provider_item_id, method, kind, status,
                decision, payload_json, response_json, error_message,
                owner_generation, sequence, created_at_ms, updated_at_ms,
                resolved_at_ms
            FROM chat_pending_requests
            WHERE conversation_id = ? AND id = ?
            ",
        )
        .bind(conversation_id)
        .bind(request_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(pending_request_from_row))
    }

    async fn update_pending_request_terminal(
        &self,
        conversation_id: &str,
        request_id: &str,
        status: ChatPendingRequestStatus,
        decision: Option<&ChatPendingRequestDecision>,
        response: Option<&Value>,
        error_message: Option<&str>,
    ) -> Result<Option<ChatPendingRequest>, ChatServiceError> {
        let now = now_ms() as i64;
        let response_json = response.map(compact_payload_json);
        sqlx::query(
            "
            UPDATE chat_pending_requests
            SET status = ?, decision = COALESCE(?, decision),
                response_json = COALESCE(?, response_json),
                error_message = ?, updated_at_ms = ?, resolved_at_ms = ?
            WHERE conversation_id = ? AND id = ?
            ",
        )
        .bind(status.as_str())
        .bind(decision.map(pending_request_decision_as_str))
        .bind(response_json.as_deref())
        .bind(error_message)
        .bind(now)
        .bind(now)
        .bind(conversation_id)
        .bind(request_id)
        .execute(&self.pool)
        .await?;
        let request = self
            .get_pending_request_by_id(conversation_id, request_id)
            .await?;
        if let Some(request) = request.as_ref() {
            self.clear_pending_server_request(&request.provider_request_id);
            self.pending_server_responders.remove(&request.id);
        }
        Ok(request)
    }

    async fn mark_pending_requests_stale_for_conversation(
        &self,
        conversation_id: &str,
        reason: &str,
    ) -> Result<(), ChatServiceError> {
        let rows = sqlx::query_as::<_, PendingRequestRow>(
            "
            SELECT
                id, conversation_id, turn_id, item_id, provider_request_id,
                provider_turn_id, provider_item_id, method, kind, status,
                decision, payload_json, response_json, error_message,
                owner_generation, sequence, created_at_ms, updated_at_ms,
                resolved_at_ms
            FROM chat_pending_requests
            WHERE conversation_id = ? AND status IN ('pending', 'resolving')
            ",
        )
        .bind(conversation_id)
        .fetch_all(&self.pool)
        .await?;
        for row in rows {
            if let Some(request) = self
                .update_pending_request_terminal(
                    conversation_id,
                    &row.id,
                    ChatPendingRequestStatus::Stale,
                    None,
                    None,
                    Some(reason),
                )
                .await?
            {
                self.events.emit(EventKind::ChatPendingRequestUpdated {
                    session_id: request_session_id(self, conversation_id).await?,
                    request,
                });
            }
        }
        let _ = self.emit_conversation_updated(conversation_id).await?;
        Ok(())
    }

    async fn reconcile_provider_request_resolved(
        &self,
        conversation_id: &str,
        provider_request_id: &str,
    ) -> Result<(), ChatServiceError> {
        let row = sqlx::query_as::<_, PendingRequestRow>(
            "
            SELECT
                id, conversation_id, turn_id, item_id, provider_request_id,
                provider_turn_id, provider_item_id, method, kind, status,
                decision, payload_json, response_json, error_message,
                owner_generation, sequence, created_at_ms, updated_at_ms,
                resolved_at_ms
            FROM chat_pending_requests
            WHERE conversation_id = ? AND provider_request_id = ?
            ",
        )
        .bind(conversation_id)
        .bind(provider_request_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(());
        };
        let status = parse_pending_request_status(&row.status);
        if status.is_attention()
            && let Some(request) = self
                .update_pending_request_terminal(
                    conversation_id,
                    &row.id,
                    ChatPendingRequestStatus::Resolved,
                    None,
                    None,
                    None,
                )
                .await?
        {
            self.events.emit(EventKind::ChatPendingRequestResolved {
                session_id: request_session_id(self, conversation_id).await?,
                request,
            });
            let _ = self.emit_conversation_updated(conversation_id).await?;
        }
        Ok(())
    }

    /// Resolve one pending Codex server request from any browser client.
    pub async fn resolve_pending_request(
        self: &Arc<Self>,
        conversation_id: &str,
        request_id: &str,
        resolution: ResolveChatPendingRequestRequest,
    ) -> Result<ChatPendingRequest, ChatServiceError> {
        let lock = self.operation_lock(conversation_id);
        let _guard = lock.lock().await;
        let Some(existing) = self
            .get_pending_request_by_id(conversation_id, request_id)
            .await?
        else {
            return Err(ChatServiceError::new(
                StatusCode::NOT_FOUND,
                "pending request not found",
            ));
        };
        if !matches!(existing.status, ChatPendingRequestStatus::Pending) {
            return Err(ChatServiceError::new(
                StatusCode::CONFLICT,
                "pending request has already been resolved",
            ));
        }
        sqlx::query(
            "
            UPDATE chat_pending_requests
            SET status = ?, updated_at_ms = ?
            WHERE conversation_id = ? AND id = ? AND status = ?
            ",
        )
        .bind(ChatPendingRequestStatus::Resolving.as_str())
        .bind(now_ms() as i64)
        .bind(conversation_id)
        .bind(request_id)
        .bind(ChatPendingRequestStatus::Pending.as_str())
        .execute(&self.pool)
        .await?;
        if let Some(request) = self
            .get_pending_request_by_id(conversation_id, request_id)
            .await?
        {
            self.events.emit(EventKind::ChatPendingRequestUpdated {
                session_id: request_session_id(self, conversation_id).await?,
                request,
            });
        }

        let responder = self
            .pending_server_responders
            .get(request_id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| {
                ChatServiceError::new(
                    StatusCode::CONFLICT,
                    "codex request can no longer be answered",
                )
            });
        let responder = match responder {
            Ok(responder) => responder,
            Err(error) => {
                if let Some(request) = self
                    .update_pending_request_terminal(
                        conversation_id,
                        request_id,
                        ChatPendingRequestStatus::Stale,
                        None,
                        None,
                        Some(&error.message),
                    )
                    .await?
                {
                    self.events.emit(EventKind::ChatPendingRequestUpdated {
                        session_id: request_session_id(self, conversation_id).await?,
                        request,
                    });
                }
                return Err(error);
            }
        };
        if responder.conversation_id != conversation_id {
            return Err(ChatServiceError::new(
                StatusCode::CONFLICT,
                "pending request belongs to another conversation",
            ));
        }
        let Some(runtime) = self
            .runtimes
            .get(conversation_id)
            .map(|entry| entry.value().clone())
        else {
            self.mark_pending_requests_stale_for_conversation(
                conversation_id,
                "codex runtime is no longer available",
            )
            .await?;
            return Err(ChatServiceError::new(
                StatusCode::CONFLICT,
                "codex runtime is no longer available",
            ));
        };
        let owner_matches =
            runtime.state.lock().await.owner_generation == responder.owner_generation;
        if !owner_matches {
            self.mark_pending_requests_stale_for_conversation(
                conversation_id,
                "codex stream ownership changed before the request was answered",
            )
            .await?;
            return Err(ChatServiceError::new(
                StatusCode::CONFLICT,
                "codex request can no longer be answered",
            ));
        }

        let response = provider_response_for_pending_request(&existing, &resolution)?;
        let send_result = self
            .app_server
            .respond_result(responder.jsonrpc_id.clone(), response.clone())
            .await;
        match send_result {
            Ok(()) => {
                let status = resolution.decision.terminal_status();
                let request = self
                    .update_pending_request_terminal(
                        conversation_id,
                        request_id,
                        status,
                        Some(&resolution.decision),
                        Some(&response),
                        None,
                    )
                    .await?
                    .ok_or_else(|| {
                        ChatServiceError::new(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "pending request missing after resolution",
                        )
                    })?;
                self.events.emit(EventKind::ChatPendingRequestResolved {
                    session_id: request_session_id(self, conversation_id).await?,
                    request: request.clone(),
                });
                let _ = self.emit_conversation_updated(conversation_id).await?;
                Ok(request)
            }
            Err(error) => {
                let request = self
                    .update_pending_request_terminal(
                        conversation_id,
                        request_id,
                        ChatPendingRequestStatus::Failed,
                        Some(&resolution.decision),
                        Some(&response),
                        Some(&error.message),
                    )
                    .await?
                    .ok_or_else(|| {
                        ChatServiceError::new(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "pending request missing after failed resolution",
                        )
                    })?;
                self.events.emit(EventKind::ChatPendingRequestUpdated {
                    session_id: request_session_id(self, conversation_id).await?,
                    request,
                });
                let _ = self.emit_conversation_updated(conversation_id).await?;
                Err(error)
            }
        }
    }

    async fn handle_provider_request(
        self: &Arc<Self>,
        jsonrpc_id: Value,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        method: &str,
        params: Value,
        route_hints: &RouteHints,
    ) -> Result<Option<Value>, ChatServiceError> {
        let kind = pending_request_kind_for_method(method);
        if matches!(kind, ChatPendingRequestKind::Unsupported) {
            let request = self
                .persist_provider_request(
                    conversation_id,
                    runtime,
                    PersistProviderRequest {
                        jsonrpc_id,
                        method: method.to_string(),
                        params,
                        route_hints: route_hints.clone(),
                        status: ChatPendingRequestStatus::Declined,
                        decision: Some(ChatPendingRequestDecision::Decline),
                        error_message: Some(format!(
                            "unsupported codex app-server request: {method}"
                        )),
                    },
                )
                .await?;
            self.events.emit(EventKind::ChatPendingRequestResolved {
                session_id: request_session_id(self, conversation_id).await?,
                request,
            });
            return Ok(Some(json!({ "decision": "decline" })));
        }

        let request = self
            .persist_provider_request(
                conversation_id,
                runtime,
                PersistProviderRequest {
                    jsonrpc_id,
                    method: method.to_string(),
                    params,
                    route_hints: route_hints.clone(),
                    status: ChatPendingRequestStatus::Pending,
                    decision: None,
                    error_message: None,
                },
            )
            .await?;
        self.events.emit(EventKind::ChatPendingRequestCreated {
            session_id: request_session_id(self, conversation_id).await?,
            request,
        });
        let _ = self.emit_conversation_updated(conversation_id).await?;
        self.emit_thread_stream_status(conversation_id, &runtime.state, None)
            .await;
        Ok(None)
    }

    async fn handle_provider_notification(
        self: &Arc<Self>,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        method: &str,
        params: Value,
    ) -> Result<(), ChatServiceError> {
        match method {
            "error" => {
                let error_message = params
                    .get("error")
                    .and_then(extract_error_message)
                    .unwrap_or_else(|| "codex turn failed".to_string());
                {
                    let mut state = runtime.state.lock().await;
                    state.active_error = Some(error_message.clone());
                    state.last_error = Some(error_message.clone());
                }
                self.emit_thread_stream_status(
                    conversation_id,
                    &runtime.state,
                    Some(error_message),
                )
                .await;
            }
            "serverRequest/resolved" => {
                let route_hints = RouteHints::from_value(&params);
                if let Some(request_id) = route_hints.request_id.as_deref() {
                    self.reconcile_provider_request_resolved(conversation_id, request_id)
                        .await?;
                    self.clear_pending_server_request(request_id);
                }
            }
            "turn/started" => {
                let provider_turn_id = RouteHints::from_value(&params)
                    .turn_id
                    .or_else(|| extract_turn_id(&params));
                let (run_id, turn_id, message_id) = {
                    let state = runtime.state.lock().await;
                    (
                        state.active_run_id.clone(),
                        state.active_turn_id.clone(),
                        state.active_message_id.clone(),
                    )
                };
                if let Some(provider_turn_id) = provider_turn_id.as_deref() {
                    self.register_turn_route(conversation_id, runtime, provider_turn_id)
                        .await;
                }
                if let (Some(run_id), Some(turn_id), Some(message_id)) =
                    (run_id, turn_id, message_id)
                {
                    self.attach_turn_to_run(
                        conversation_id,
                        &run_id,
                        &turn_id,
                        &message_id,
                        provider_turn_id.as_deref(),
                    )
                    .await?;
                }
            }
            "item/started" => {
                trace_codex_text_event("item/started", conversation_id, &params);
                let kind = item_kind_from_params(&params);
                let projection = agent_message_projection_from_value(&params);
                let route_hints = RouteHints::from_value(&params);
                if let (Some(item_id), Some(projection)) =
                    (route_hints.item_id.as_deref(), projection)
                {
                    runtime
                        .state
                        .lock()
                        .await
                        .agent_message_projection_by_item_id
                        .insert(item_id.to_string(), projection);
                }
                let persisted_kind = if projection == Some(AgentMessageProjection::Reasoning) {
                    ChatItemKind::Reasoning
                } else {
                    kind
                };
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        persisted_kind,
                        ChatItemStatus::Started,
                    )
                    .await?;
            }
            "item/commandExecution/outputDelta" | "command/exec/outputDelta" => {
                self.append_activity_output(
                    conversation_id,
                    runtime,
                    &params,
                    ChatItemKind::CommandExecution,
                    "stdout",
                )
                .await?;
            }
            "item/fileChange/outputDelta" => {
                self.append_activity_output(
                    conversation_id,
                    runtime,
                    &params,
                    ChatItemKind::FileChange,
                    "patch",
                )
                .await?;
            }
            "item/fileChange/patchUpdated" => {
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        ChatItemKind::FileChange,
                        ChatItemStatus::Streaming,
                    )
                    .await?;
            }
            "item/mcpToolCall/progress" => {
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        ChatItemKind::McpToolCall,
                        ChatItemStatus::Streaming,
                    )
                    .await?;
            }
            "item/autoApprovalReview/started" => {
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        ChatItemKind::AutoApprovalReview,
                        ChatItemStatus::Started,
                    )
                    .await?;
            }
            "item/autoApprovalReview/completed" => {
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        ChatItemKind::AutoApprovalReview,
                        ChatItemStatus::Completed,
                    )
                    .await?;
            }
            "hook/started" => {
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        ChatItemKind::Hook,
                        ChatItemStatus::Started,
                    )
                    .await?;
            }
            "hook/completed" => {
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        ChatItemKind::Hook,
                        ChatItemStatus::Completed,
                    )
                    .await?;
            }
            "model/rerouted" => {
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        ChatItemKind::ModelReroute,
                        ChatItemStatus::Completed,
                    )
                    .await?;
            }
            "turn/plan/updated" => {
                self.upsert_active_plan(conversation_id, runtime, &params)
                    .await?;
            }
            "item/plan/delta" => {
                let delta = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !delta.is_empty() {
                    self.append_proposed_plan_delta(conversation_id, runtime, &params, delta)
                        .await?;
                }
            }
            "turn/diff/updated" => {
                self.upsert_diff_summary(conversation_id, runtime, &params)
                    .await?;
            }
            "thread/tokenUsage/updated" => {
                self.upsert_context_usage(conversation_id, runtime, &params)
                    .await?;
            }
            "item/reasoning/summaryTextDelta" => {
                trace_codex_text_event("item/reasoning/summaryTextDelta", conversation_id, &params);
                let delta = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if delta.is_empty() {
                    return Ok(());
                }
                let _ = self
                    .append_reasoning_item_delta(
                        conversation_id,
                        runtime,
                        &params,
                        delta,
                        ChatItemStatus::Streaming,
                    )
                    .await?;
                let summary_index = params
                    .get("summaryIndex")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let (message_id, session_id, prefixed_delta) = {
                    let mut state = runtime.state.lock().await;
                    let Some(message_id) = state.active_message_id.clone() else {
                        return Ok(());
                    };
                    let needs_separator = matches!(
                        state.active_reasoning_summary_index,
                        Some(current) if current != summary_index
                    );
                    state.active_reasoning_summary_index = Some(summary_index);
                    state.has_reasoning_projection = true;
                    let prefix = if needs_separator { "\n\n" } else { "" };
                    (
                        message_id,
                        state.session_id.clone(),
                        format!("{prefix}{delta}"),
                    )
                };
                let Some(message) = self
                    .append_message_reasoning_delta(conversation_id, &message_id, &prefixed_delta)
                    .await?
                else {
                    return Ok(());
                };
                self.events.emit(EventKind::ChatMessageUpdated {
                    session_id,
                    conversation_id: conversation_id.to_string(),
                    message,
                });
            }
            "item/agentMessage/delta" => {
                trace_codex_text_event("item/agentMessage/delta", conversation_id, &params);
                let delta = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if delta.is_empty() {
                    return Ok(());
                }
                let route_hints = RouteHints::from_value(&params);
                let (message_id, session_id, is_reasoning_delta, prefixed_delta) = {
                    let mut state = runtime.state.lock().await;
                    let is_reasoning_delta = is_commentary_phase(&params)
                        || route_hints.item_id.as_deref().is_some_and(|item_id| {
                            state
                                .agent_message_projection_by_item_id
                                .get(item_id)
                                .is_some_and(|projection| {
                                    matches!(projection, AgentMessageProjection::Reasoning)
                                })
                        });
                    let prefixed_delta = if is_reasoning_delta {
                        let item_changed = route_hints.item_id.as_ref().is_some_and(|item_id| {
                            state.active_commentary_item_id.as_ref() != Some(item_id)
                        });
                        let prefix = if item_changed && state.has_reasoning_projection {
                            "\n\n"
                        } else {
                            ""
                        };
                        if let Some(item_id) = route_hints.item_id.as_ref() {
                            state.active_commentary_item_id = Some(item_id.clone());
                            state.commentary_delta_seen_item_ids.insert(item_id.clone());
                        }
                        state.has_reasoning_projection = true;
                        format!("{prefix}{delta}")
                    } else {
                        delta.clone()
                    };
                    (
                        state.active_message_id.clone(),
                        state.session_id.clone(),
                        is_reasoning_delta,
                        prefixed_delta,
                    )
                };
                let Some(message_id) = message_id else {
                    return Ok(());
                };
                if is_reasoning_delta {
                    let _ = self
                        .append_reasoning_item_delta(
                            conversation_id,
                            runtime,
                            &params,
                            &delta,
                            ChatItemStatus::Streaming,
                        )
                        .await?;
                    let Some(message) = self
                        .append_message_reasoning_delta(
                            conversation_id,
                            &message_id,
                            &prefixed_delta,
                        )
                        .await?
                    else {
                        return Ok(());
                    };
                    self.events.emit(EventKind::ChatMessageUpdated {
                        session_id,
                        conversation_id: conversation_id.to_string(),
                        message,
                    });
                    return Ok(());
                }
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        ChatItemKind::AgentMessage,
                        ChatItemStatus::Streaming,
                    )
                    .await?;
                self.append_message_delta(conversation_id, &message_id, &delta)
                    .await?;
                if let Some(summary) = self.get_conversation_summary(conversation_id).await? {
                    self.events.emit(EventKind::ChatMessageDelta {
                        session_id,
                        conversation_id: conversation_id.to_string(),
                        message_id,
                        delta,
                        revision: summary.revision,
                    });
                }
            }
            "item/completed" => {
                trace_codex_text_event("item/completed", conversation_id, &params);
                let item = params.get("item").cloned().unwrap_or(Value::Null);
                let kind = item_kind_from_params(&params);
                let is_commentary_agent_message = matches!(kind, ChatItemKind::AgentMessage)
                    && (is_commentary_phase(&params) || is_commentary_phase(&item));
                let route_hints = RouteHints::from_value(&params);
                let projection = agent_message_projection_from_value(&params);
                if let (Some(item_id), Some(projection)) =
                    (route_hints.item_id.as_deref(), projection)
                {
                    runtime
                        .state
                        .lock()
                        .await
                        .agent_message_projection_by_item_id
                        .insert(item_id.to_string(), projection);
                }
                self.finalize_proposed_plan_for_item(conversation_id, runtime, &params)
                    .await?;
                if is_plan_payload(&params) {
                    return Ok(());
                }
                let persisted_kind = if is_commentary_agent_message {
                    ChatItemKind::Reasoning
                } else {
                    kind
                };
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        persisted_kind,
                        ChatItemStatus::Completed,
                    )
                    .await?;
                if matches!(kind, ChatItemKind::AgentMessage)
                    && let Some(text) = item.get("text").and_then(Value::as_str)
                {
                    let (message_id, reasoning_completion_delta) = {
                        let mut state = runtime.state.lock().await;
                        let reasoning_completion_delta = if is_commentary_agent_message {
                            let item_id = route_hints.item_id.as_ref();
                            let already_streamed = item_id.is_some_and(|item_id| {
                                state.commentary_delta_seen_item_ids.contains(item_id)
                            });
                            let already_completed = item_id.is_some_and(|item_id| {
                                state.commentary_completed_item_ids.contains(item_id)
                            });
                            if !already_streamed && !already_completed {
                                let prefix = if state.has_reasoning_projection {
                                    "\n\n"
                                } else {
                                    ""
                                };
                                state.has_reasoning_projection = true;
                                if let Some(item_id) = item_id {
                                    state.active_commentary_item_id = Some(item_id.clone());
                                    state.commentary_completed_item_ids.insert(item_id.clone());
                                }
                                Some(format!("{prefix}{text}"))
                            } else {
                                if let Some(item_id) = item_id {
                                    state.commentary_completed_item_ids.insert(item_id.clone());
                                }
                                None
                            }
                        } else {
                            None
                        };
                        (state.active_message_id.clone(), reasoning_completion_delta)
                    };
                    if let Some(message_id) = message_id {
                        if let Some(reasoning_completion_delta) = reasoning_completion_delta {
                            let _ = self
                                .append_reasoning_item_delta(
                                    conversation_id,
                                    runtime,
                                    &params,
                                    text,
                                    ChatItemStatus::Completed,
                                )
                                .await?;
                            let Some(message) = self
                                .append_message_reasoning_delta(
                                    conversation_id,
                                    &message_id,
                                    &reasoning_completion_delta,
                                )
                                .await?
                            else {
                                return Ok(());
                            };
                            if let Some(summary) =
                                self.get_conversation_summary(conversation_id).await?
                            {
                                self.events.emit(EventKind::ChatMessageUpdated {
                                    session_id: summary.session_id,
                                    conversation_id: conversation_id.to_string(),
                                    message,
                                });
                            }
                        } else if is_commentary_agent_message {
                            return Ok(());
                        } else {
                            self.replace_message_content(
                                conversation_id,
                                &message_id,
                                text,
                                ChatMessageStatus::Streaming,
                            )
                            .await?;
                        }
                    }
                }
            }
            "turn/completed" => {
                trace_codex_text_event("turn/completed", conversation_id, &params);
                let status = params
                    .get("turn")
                    .and_then(|turn| turn.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                let (run_id, turn_id, message_id, session_id, generation, active_error) = {
                    let mut state = runtime.state.lock().await;
                    state.lifecycle = ChatRuntimeLifecycle::Ready;
                    state.reset_text_projection_state();
                    state.idle_generation = state.idle_generation.saturating_add(1);
                    let generation = state.idle_generation;
                    let active_error = state.active_error.take();
                    (
                        state.active_run_id.take(),
                        state.active_turn_id.take(),
                        state.active_message_id.take(),
                        state.session_id.clone(),
                        generation,
                        active_error,
                    )
                };
                let mut run_status = parse_turn_status(status);
                if let Some(run_id) = run_id {
                    let provider_turn_id = extract_turn_id(&params);
                    let error_message = params
                        .get("turn")
                        .and_then(|turn| turn.get("error"))
                        .and_then(extract_error_message)
                        .or(active_error);
                    let final_text = params
                        .get("turn")
                        .and_then(extract_turn_text)
                        .unwrap_or_default();
                    if matches!(run_status, ChatRunStatus::Completed)
                        && error_message.is_some()
                        && final_text.is_empty()
                    {
                        run_status = ChatRunStatus::Failed;
                    }
                    let message_status = match run_status {
                        ChatRunStatus::Completed => ChatMessageStatus::Completed,
                        ChatRunStatus::Interrupted => ChatMessageStatus::Interrupted,
                        ChatRunStatus::Failed => ChatMessageStatus::Failed,
                        ChatRunStatus::Starting | ChatRunStatus::Running => {
                            ChatMessageStatus::Completed
                        }
                    };
                    let finalized_message = if let Some(message_id) = message_id.as_deref() {
                        self.finalize_assistant_message(
                            conversation_id,
                            message_id,
                            &final_text,
                            message_status,
                        )
                        .await?
                    } else {
                        None
                    };
                    let run = self
                        .finalize_run(conversation_id, &run_id, run_status, error_message.clone())
                        .await?;
                    if let Some(turn_id) = turn_id.as_deref() {
                        let turn = self
                            .finalize_turn(
                                conversation_id,
                                turn_id,
                                chat_turn_status_from_run_status(run_status),
                                error_message.clone(),
                            )
                            .await?;
                        self.finalize_streaming_plans_for_turn(
                            conversation_id,
                            &session_id,
                            turn_id,
                            provider_turn_id.as_deref(),
                            ChatPlanStatus::Completed,
                        )
                        .await?;
                        self.events.emit(EventKind::ChatTurnUpdated {
                            session_id: session_id.clone(),
                            conversation_id: conversation_id.to_string(),
                            turn,
                        });
                    }
                    if let Some(message) = finalized_message {
                        self.events.emit(EventKind::ChatMessageUpdated {
                            session_id: session_id.clone(),
                            conversation_id: conversation_id.to_string(),
                            message,
                        });
                    }
                    self.events.emit(EventKind::ChatRunUpdated {
                        session_id: session_id.clone(),
                        conversation_id: conversation_id.to_string(),
                        run,
                    });
                    if let Some(summary) = self.emit_conversation_updated(conversation_id).await? {
                        self.events.emit(EventKind::ChatConversationUpdated {
                            session_id,
                            conversation: summary,
                        });
                    }
                }
                self.emit_thread_stream_status(conversation_id, &runtime.state, None)
                    .await;
                self.mark_pending_requests_stale_for_conversation(
                    conversation_id,
                    "codex turn completed before this request was answered",
                )
                .await?;
                self.schedule_idle_unsubscribe(conversation_id.to_string(), generation);
                self.enforce_inactive_stream_limit().await;
            }
            _ => {}
        }
        Ok(())
    }

    async fn handle_provider_closed(
        self: &Arc<Self>,
        reason: String,
    ) -> Result<(), ChatServiceError> {
        self.stream_owner_generation.fetch_add(1, Ordering::AcqRel);
        self.clear_route_indexes();
        self.app_server.mark_fatal(reason.clone()).await;
        self.emit_app_server_status().await;
        let runtimes = self
            .runtimes
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect::<Vec<_>>();
        for (conversation_id, runtime) in runtimes {
            let (run_id, turn_id, message_id, provider_thread_id, owner_generation) = {
                let mut state = runtime.state.lock().await;
                state.lifecycle = ChatRuntimeLifecycle::Failed;
                state.stream_lifecycle.mark_process_lost();
                state.reset_text_projection_state();
                state.inactive_deadline_at = None;
                state.last_error = Some(reason.clone());
                (
                    state.active_run_id.take(),
                    state.active_turn_id.take(),
                    state.active_message_id.take(),
                    state.provider_thread_id.clone(),
                    state.owner_generation,
                )
            };
            if run_id.is_some() || turn_id.is_some() || message_id.is_some() {
                let reconciliation = self
                    .mark_reconciliation_pending(
                        &conversation_id,
                        provider_thread_id,
                        "codex app-server exited before the active turn completed",
                        owner_generation,
                    )
                    .await?;
                if let Some(summary) = self.emit_conversation_updated(&conversation_id).await? {
                    self.events.emit(EventKind::ChatReconciliationStarted {
                        session_id: summary.session_id,
                        reconciliation,
                    });
                }
            }
            self.emit_thread_stream_status(&conversation_id, &runtime.state, Some(reason.clone()))
                .await;
            self.mark_pending_requests_stale_for_conversation(
                &conversation_id,
                "codex app-server exited before this request was answered",
            )
            .await?;
        }
        Ok(())
    }

    fn schedule_idle_unsubscribe(self: &Arc<Self>, conversation_id: String, generation: u64) {
        let service = self.clone();
        tokio::spawn(async move {
            let minutes = service
                .settings
                .get()
                .await
                .settings
                .chat
                .idle_timeout_minutes;
            let timeout = Duration::from_secs(u64::from(minutes) * 60);
            service
                .schedule_unsubscribe_after(conversation_id, generation, timeout)
                .await;
        });
    }

    fn schedule_unsubscribe_retry(self: &Arc<Self>, conversation_id: String, generation: u64) {
        let service = self.clone();
        tokio::spawn(async move {
            service
                .schedule_unsubscribe_after(conversation_id, generation, UNSUBSCRIBE_RETRY_DELAY)
                .await;
        });
    }

    async fn schedule_unsubscribe_after(
        self: Arc<Self>,
        conversation_id: String,
        generation: u64,
        timeout: Duration,
    ) {
        let deadline = now_ms().saturating_add(timeout.as_millis() as u64);
        if let Some(runtime) = self.runtimes.get(&conversation_id) {
            let mut state = runtime.state.lock().await;
            if state.idle_generation == generation {
                state.inactive_deadline_at = Some(deadline);
            }
        }
        tokio::time::sleep(timeout).await;
        let should_unsubscribe = if let Some(runtime) = self.runtimes.get(&conversation_id) {
            let state = runtime.state.lock().await;
            state.active_run_id.is_none()
                && state.idle_generation == generation
                && state.provider_thread_id.is_some()
                && matches!(
                    state.stream_lifecycle.resume_state(),
                    ThreadStreamResumeState::Resumed
                )
        } else {
            false
        };
        if should_unsubscribe {
            let _ = self.unsubscribe_runtime(&conversation_id).await;
        }
    }

    async fn unsubscribe_runtime(
        self: &Arc<Self>,
        conversation_id: &str,
    ) -> Result<(), ChatServiceError> {
        let runtime = {
            self.runtimes
                .get(conversation_id)
                .map(|entry| entry.value().clone())
        };
        let Some(runtime) = runtime else {
            return Ok(());
        };
        let provider_thread_id = {
            let mut state = runtime.state.lock().await;
            let provider_thread_id = state.provider_thread_id.clone();
            state.lifecycle = ChatRuntimeLifecycle::Stopping;
            state.inactive_deadline_at = None;
            provider_thread_id
        };
        self.emit_thread_stream_status(conversation_id, &runtime.state, None)
            .await;
        let Some(provider_thread_id) = provider_thread_id else {
            return Ok(());
        };
        match self
            .app_server
            .request(
                "thread/unsubscribe",
                json!({ "threadId": provider_thread_id }),
            )
            .await
        {
            Ok(_) => {
                {
                    let mut state = runtime.state.lock().await;
                    state.lifecycle = ChatRuntimeLifecycle::Stopped;
                    state.stream_lifecycle.mark_needs_resume();
                    state.inactive_deadline_at = None;
                    state.last_error = None;
                }
                self.mark_pending_requests_stale_for_conversation(
                    conversation_id,
                    "codex thread stream was unsubscribed before this request was answered",
                )
                .await?;
                self.emit_thread_stream_status(conversation_id, &runtime.state, None)
                    .await;
            }
            Err(error) => {
                let retry_at = now_ms().saturating_add(UNSUBSCRIBE_RETRY_DELAY.as_millis() as u64);
                let generation = {
                    let mut state = runtime.state.lock().await;
                    state.lifecycle = ChatRuntimeLifecycle::Ready;
                    state.inactive_deadline_at = Some(retry_at);
                    state.last_error = Some(error.message.clone());
                    state.idle_generation = state.idle_generation.saturating_add(1);
                    state.idle_generation
                };
                self.emit_thread_stream_status(
                    conversation_id,
                    &runtime.state,
                    Some(error.message),
                )
                .await;
                self.schedule_unsubscribe_retry(conversation_id.to_string(), generation);
            }
        }
        Ok(())
    }

    async fn enforce_inactive_stream_limit(self: &Arc<Self>) {
        let runtimes = self
            .runtimes
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect::<Vec<_>>();
        let mut inactive = Vec::new();
        for (conversation_id, runtime) in runtimes {
            let state = runtime.state.lock().await;
            if state.active_run_id.is_none()
                && matches!(state.lifecycle, ChatRuntimeLifecycle::Ready)
                && matches!(
                    state.stream_lifecycle.resume_state(),
                    ThreadStreamResumeState::Resumed
                )
            {
                inactive.push((state.idle_generation, conversation_id));
            }
        }
        inactive.sort_by_key(|(generation, _)| *generation);
        let overflow = inactive.len().saturating_sub(MAX_INACTIVE_THREAD_STREAMS);
        for (_, conversation_id) in inactive.into_iter().take(overflow) {
            let _ = self.unsubscribe_runtime(&conversation_id).await;
        }
    }

    async fn reconcile_inflight_run_if_needed(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        _worktree_path: &str,
    ) -> Result<(), ChatServiceError> {
        let latest = sqlx::query_as::<_, RunRow>(
            "
            SELECT
                id, conversation_id, turn_id, provider_turn_id, status,
                started_at_ms, finished_at_ms, error_message
            FROM chat_runs
            WHERE conversation_id = ?
            ORDER BY started_at_ms DESC, id DESC
            LIMIT 1
            ",
        )
        .bind(conversation_id)
        .fetch_optional(&self.pool)
        .await?;
        let latest_reconciliation = self.latest_reconciliation(conversation_id).await?;
        let needs_reconciliation = latest
            .as_ref()
            .map(|run| parse_run_status(&run.status))
            .is_some_and(|status| {
                !matches!(
                    status,
                    ChatRunStatus::Completed | ChatRunStatus::Interrupted | ChatRunStatus::Failed
                )
            })
            || latest_reconciliation
                .as_ref()
                .is_some_and(|reconciliation| reconciliation.status.is_active());
        if !needs_reconciliation {
            return Ok(());
        };
        let provider_thread_id = runtime.state.lock().await.provider_thread_id.clone();
        let Some(provider_thread_id) = provider_thread_id else {
            if let Some(run) = latest {
                self.interrupt_uncertain_run(
                    conversation_id,
                    &run,
                    "chat runtime restarted before turn completed",
                )
                .await?;
            }
            return Ok(());
        };
        let reconciliation = self
            .start_reconciliation(
                conversation_id,
                Some(provider_thread_id.clone()),
                "recovering Codex thread state",
                runtime,
            )
            .await?;
        let result = self
            .app_server
            .request(
                "thread/read",
                json!({
                    "threadId": provider_thread_id,
                    "includeTurns": true,
                }),
            )
            .await;
        match result {
            Ok(result) => {
                self.apply_thread_read_replay(conversation_id, runtime, &result)
                    .await?;
                self.finish_reconciliation(
                    conversation_id,
                    &reconciliation.id,
                    ChatReconciliationStatus::Completed,
                    None,
                )
                .await?;
            }
            Err(error) => {
                if let Some(run) = latest.as_ref() {
                    self.interrupt_uncertain_run(conversation_id, run, &error.message)
                        .await?;
                }
                self.finish_reconciliation(
                    conversation_id,
                    &reconciliation.id,
                    ChatReconciliationStatus::Failed,
                    Some(error.message),
                )
                .await?;
            }
        }
        Ok(())
    }

    async fn latest_reconciliation(
        &self,
        conversation_id: &str,
    ) -> Result<Option<ChatReconciliation>, ChatServiceError> {
        Ok(sqlx::query_as::<_, ReconciliationRow>(
            "
            SELECT
                id, conversation_id, provider_thread_id, status, reason,
                started_at_ms, finished_at_ms, error_message,
                owner_generation, created_at_ms, updated_at_ms
            FROM chat_reconciliations
            WHERE conversation_id = ?
            ORDER BY updated_at_ms DESC, id DESC
            LIMIT 1
            ",
        )
        .bind(conversation_id)
        .fetch_optional(&self.pool)
        .await?
        .map(reconciliation_from_row))
    }

    async fn mark_reconciliation_pending(
        &self,
        conversation_id: &str,
        provider_thread_id: Option<String>,
        reason: &str,
        owner_generation: u64,
    ) -> Result<ChatReconciliation, ChatServiceError> {
        let now = now_ms() as i64;
        let existing = self.latest_reconciliation(conversation_id).await?;
        let reconciliation_id = if let Some(existing) = existing
            && existing.status.is_active()
        {
            existing.id
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            sqlx::query(
                "
                INSERT INTO chat_reconciliations (
                    id, conversation_id, provider_thread_id, status, reason,
                    started_at_ms, owner_generation, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ",
            )
            .bind(&id)
            .bind(conversation_id)
            .bind(&provider_thread_id)
            .bind(ChatReconciliationStatus::Pending.as_str())
            .bind(reason)
            .bind(now)
            .bind(owner_generation as i64)
            .bind(now)
            .bind(now)
            .execute(&self.pool)
            .await?;
            id
        };
        sqlx::query(
            "
            UPDATE chat_reconciliations
            SET provider_thread_id = COALESCE(?, provider_thread_id),
                status = ?, reason = ?, error_message = NULL,
                owner_generation = ?, updated_at_ms = ?
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(&provider_thread_id)
        .bind(ChatReconciliationStatus::Pending.as_str())
        .bind(reason)
        .bind(owner_generation as i64)
        .bind(now)
        .bind(&reconciliation_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        self.update_conversation_reconciliation_state(
            conversation_id,
            ChatReconciliationStatus::Pending,
            None,
        )
        .await?;
        self.latest_reconciliation(conversation_id)
            .await?
            .ok_or_else(|| {
                ChatServiceError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "chat reconciliation missing after pending update",
                )
            })
    }

    async fn start_reconciliation(
        &self,
        conversation_id: &str,
        provider_thread_id: Option<String>,
        reason: &str,
        runtime: &RuntimeEntry,
    ) -> Result<ChatReconciliation, ChatServiceError> {
        let owner_generation = runtime.state.lock().await.owner_generation;
        let pending = self
            .mark_reconciliation_pending(
                conversation_id,
                provider_thread_id,
                reason,
                owner_generation,
            )
            .await?;
        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_reconciliations
            SET status = ?, started_at_ms = ?, finished_at_ms = NULL,
                error_message = NULL, updated_at_ms = ?
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(ChatReconciliationStatus::Running.as_str())
        .bind(now)
        .bind(now)
        .bind(&pending.id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        self.update_turn_reconciliation_state(
            conversation_id,
            ChatReconciliationStatus::Running,
            None,
        )
        .await?;
        self.update_conversation_reconciliation_state(
            conversation_id,
            ChatReconciliationStatus::Running,
            None,
        )
        .await?;
        let reconciliation = self.latest_reconciliation(conversation_id).await?.unwrap();
        if let Some(summary) = self.get_conversation_summary(conversation_id).await? {
            self.events.emit(EventKind::ChatReconciliationStarted {
                session_id: summary.session_id,
                reconciliation: reconciliation.clone(),
            });
        }
        Ok(reconciliation)
    }

    async fn finish_reconciliation(
        &self,
        conversation_id: &str,
        reconciliation_id: &str,
        status: ChatReconciliationStatus,
        error_message: Option<String>,
    ) -> Result<(), ChatServiceError> {
        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_reconciliations
            SET status = ?, finished_at_ms = ?, error_message = ?,
                updated_at_ms = ?
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(status.as_str())
        .bind(now)
        .bind(&error_message)
        .bind(now)
        .bind(reconciliation_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        self.update_turn_reconciliation_state(conversation_id, status, error_message.clone())
            .await?;
        self.update_conversation_reconciliation_state(conversation_id, status, error_message)
            .await?;
        let Some(reconciliation) = self.latest_reconciliation(conversation_id).await? else {
            return Ok(());
        };
        if let Some(summary) = self.emit_conversation_updated(conversation_id).await? {
            match status {
                ChatReconciliationStatus::Completed => {
                    self.events.emit(EventKind::ChatReconciliationCompleted {
                        session_id: summary.session_id,
                        reconciliation,
                    });
                }
                ChatReconciliationStatus::Failed => {
                    self.events.emit(EventKind::ChatReconciliationFailed {
                        session_id: summary.session_id,
                        reconciliation,
                    });
                }
                _ => {}
            }
        }
        Ok(())
    }

    async fn update_conversation_reconciliation_state(
        &self,
        conversation_id: &str,
        status: ChatReconciliationStatus,
        error_message: Option<String>,
    ) -> Result<(), ChatServiceError> {
        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_conversations
            SET last_reconciliation_state = ?,
                last_reconciliation_error = ?,
                updated_at_ms = ?,
                last_activity_at_ms = ?,
                revision = revision + 1
            WHERE id = ?
            ",
        )
        .bind(status.as_str())
        .bind(error_message)
        .bind(now)
        .bind(now)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn update_turn_reconciliation_state(
        &self,
        conversation_id: &str,
        status: ChatReconciliationStatus,
        error_message: Option<String>,
    ) -> Result<(), ChatServiceError> {
        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_turns
            SET reconciliation_status = ?,
                reconciled_at_ms = CASE WHEN ? THEN ? ELSE reconciled_at_ms END,
                reconciliation_error = ?,
                updated_at_ms = ?
            WHERE conversation_id = ?
                AND status IN ('starting', 'running')
            ",
        )
        .bind(status.as_str())
        .bind(matches!(
            status,
            ChatReconciliationStatus::Completed | ChatReconciliationStatus::Failed
        ))
        .bind(now)
        .bind(error_message)
        .bind(now)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn interrupt_uncertain_run(
        &self,
        conversation_id: &str,
        run: &RunRow,
        reason: &str,
    ) -> Result<(), ChatServiceError> {
        if let Some(message_id) = self.latest_assistant_message_id(conversation_id).await? {
            self.finalize_assistant_message(
                conversation_id,
                &message_id,
                "",
                ChatMessageStatus::Interrupted,
            )
            .await?;
        }
        self.finalize_run(
            conversation_id,
            &run.id,
            ChatRunStatus::Interrupted,
            Some(reason.to_string()),
        )
        .await?;
        let _ = self.emit_conversation_updated(conversation_id).await?;
        Ok(())
    }

    async fn apply_thread_read_replay(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        result: &Value,
    ) -> Result<(), ChatServiceError> {
        if let Some(usage) = result
            .get("usage")
            .or_else(|| result.get("tokenUsage"))
            .or_else(|| result.pointer("/thread/usage"))
            .or_else(|| result.pointer("/thread/tokenUsage"))
        {
            self.upsert_context_usage(conversation_id, runtime, usage)
                .await?;
        }

        let mut replayed_turn = false;
        for provider_turn in thread_read_turns(result) {
            let provider_turn_id = extract_turn_id(&provider_turn);
            let Some(turn) = self
                .turn_for_provider_replay(conversation_id, provider_turn_id.as_deref())
                .await?
            else {
                continue;
            };
            replayed_turn = true;
            self.attach_provider_turn_replay(conversation_id, &turn, provider_turn_id.as_deref())
                .await?;
            if let Some(provider_turn_id) = provider_turn_id.as_deref() {
                self.register_turn_route(conversation_id, runtime, provider_turn_id)
                    .await;
            }

            let previous = {
                let mut state = runtime.state.lock().await;
                let previous = (
                    state.active_turn_id.clone(),
                    state.active_message_id.clone(),
                    state.active_run_id.clone(),
                );
                state.active_turn_id = Some(turn.id.clone());
                state.active_message_id = Some(turn.assistant_message_id.clone());
                state.active_run_id = Some(turn.run_id.clone());
                previous
            };

            for item in provider_turn_items(&provider_turn) {
                let params = replay_item_params(&item, provider_turn_id.as_deref());
                if is_plan_payload(&params) {
                    continue;
                }
                let kind = item_kind_from_params(&params);
                let status = replay_item_status(&item);
                let _ = self
                    .upsert_chat_item(conversation_id, runtime, &params, kind, status)
                    .await?;
                match kind {
                    ChatItemKind::AgentMessage => {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            if is_commentary_phase(&item) {
                                let message = self
                                    .replace_message_reasoning(
                                        conversation_id,
                                        &turn.assistant_message_id,
                                        text,
                                        ChatMessageStatus::Streaming,
                                    )
                                    .await?;
                                if let Some(summary) =
                                    self.get_conversation_summary(conversation_id).await?
                                {
                                    self.events.emit(EventKind::ChatMessageUpdated {
                                        session_id: summary.session_id,
                                        conversation_id: conversation_id.to_string(),
                                        message,
                                    });
                                }
                            } else {
                                self.replace_message_content(
                                    conversation_id,
                                    &turn.assistant_message_id,
                                    text,
                                    ChatMessageStatus::Streaming,
                                )
                                .await?;
                            }
                        }
                    }
                    ChatItemKind::Reasoning => {
                        if let Some(text) = replay_reasoning_text(&item) {
                            let message = self
                                .replace_message_reasoning(
                                    conversation_id,
                                    &turn.assistant_message_id,
                                    &text,
                                    ChatMessageStatus::Streaming,
                                )
                                .await?;
                            if let Some(summary) =
                                self.get_conversation_summary(conversation_id).await?
                            {
                                self.events.emit(EventKind::ChatMessageUpdated {
                                    session_id: summary.session_id,
                                    conversation_id: conversation_id.to_string(),
                                    message,
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }

            if let Some(plan) = provider_turn.get("plan") {
                self.upsert_active_plan(conversation_id, runtime, plan)
                    .await?;
            }
            if let Some(diff) = provider_turn.get("diff") {
                self.upsert_diff_summary(conversation_id, runtime, diff)
                    .await?;
            }

            let run_status = parse_turn_status(
                provider_turn
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("completed"),
            );
            let message_status = match run_status {
                ChatRunStatus::Completed => ChatMessageStatus::Completed,
                ChatRunStatus::Interrupted => ChatMessageStatus::Interrupted,
                ChatRunStatus::Failed => ChatMessageStatus::Failed,
                ChatRunStatus::Starting | ChatRunStatus::Running => ChatMessageStatus::Streaming,
            };
            let final_text = extract_turn_text(&provider_turn).unwrap_or_default();
            let message = self
                .finalize_assistant_message(
                    conversation_id,
                    &turn.assistant_message_id,
                    &final_text,
                    message_status,
                )
                .await?;
            if !self.run_is_terminal(conversation_id, &turn.run_id).await? {
                let run = self
                    .finalize_run(conversation_id, &turn.run_id, run_status, None)
                    .await?;
                if let Some(summary) = self.get_conversation_summary(conversation_id).await? {
                    self.events.emit(EventKind::ChatRunUpdated {
                        session_id: summary.session_id,
                        conversation_id: conversation_id.to_string(),
                        run,
                    });
                }
            }
            let finalized_turn = self
                .finalize_turn(
                    conversation_id,
                    &turn.id,
                    chat_turn_status_from_run_status(run_status),
                    None,
                )
                .await?;
            if let Some(summary) = self.get_conversation_summary(conversation_id).await? {
                if let Some(message) = message {
                    self.events.emit(EventKind::ChatMessageUpdated {
                        session_id: summary.session_id.clone(),
                        conversation_id: conversation_id.to_string(),
                        message,
                    });
                }
                self.events.emit(EventKind::ChatTurnUpdated {
                    session_id: summary.session_id,
                    conversation_id: conversation_id.to_string(),
                    turn: finalized_turn,
                });
            }

            {
                let mut state = runtime.state.lock().await;
                state.active_turn_id = previous.0;
                state.active_message_id = previous.1;
                state.active_run_id = previous.2;
            }
        }

        if !replayed_turn
            && let Some(text) = extract_thread_read_text(result)
            && let Some(message_id) = self.latest_assistant_message_id(conversation_id).await?
        {
            let message = self
                .finalize_assistant_message(
                    conversation_id,
                    &message_id,
                    &text,
                    ChatMessageStatus::Completed,
                )
                .await?;
            if let Some(summary) = self.get_conversation_summary(conversation_id).await?
                && let Some(message) = message
            {
                self.events.emit(EventKind::ChatMessageUpdated {
                    session_id: summary.session_id,
                    conversation_id: conversation_id.to_string(),
                    message,
                });
            }
        }
        let _ = self.emit_conversation_updated(conversation_id).await?;
        Ok(())
    }

    async fn turn_for_provider_replay(
        &self,
        conversation_id: &str,
        provider_turn_id: Option<&str>,
    ) -> Result<Option<ChatTurn>, ChatServiceError> {
        if let Some(provider_turn_id) = provider_turn_id
            && let Some(row) = sqlx::query_as::<_, TurnRow>(
                "
                SELECT
                    id, conversation_id, run_id, user_message_id,
                    assistant_message_id, provider_turn_id, status,
                    started_at_ms, completed_at_ms, error_message,
                    reconciliation_status, reconciled_at_ms,
                    reconciliation_error, created_at_ms, updated_at_ms
                FROM chat_turns
                WHERE conversation_id = ? AND provider_turn_id = ?
                LIMIT 1
                ",
            )
            .bind(conversation_id)
            .bind(provider_turn_id)
            .fetch_optional(&self.pool)
            .await?
        {
            return Ok(Some(turn_from_row(row)));
        }
        Ok(sqlx::query_as::<_, TurnRow>(
            "
            SELECT
                id, conversation_id, run_id, user_message_id,
                assistant_message_id, provider_turn_id, status,
                started_at_ms, completed_at_ms, error_message,
                reconciliation_status, reconciled_at_ms,
                reconciliation_error, created_at_ms, updated_at_ms
            FROM chat_turns
            WHERE conversation_id = ?
                AND status IN ('starting', 'running')
            ORDER BY started_at_ms DESC, id DESC
            LIMIT 1
            ",
        )
        .bind(conversation_id)
        .fetch_optional(&self.pool)
        .await?
        .map(turn_from_row))
    }

    async fn attach_provider_turn_replay(
        &self,
        conversation_id: &str,
        turn: &ChatTurn,
        provider_turn_id: Option<&str>,
    ) -> Result<(), ChatServiceError> {
        let Some(provider_turn_id) = provider_turn_id else {
            return Ok(());
        };
        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_messages
            SET provider_turn_id = COALESCE(provider_turn_id, ?),
                updated_at_ms = ?
            WHERE turn_id = ? AND conversation_id = ?
            ",
        )
        .bind(provider_turn_id)
        .bind(now)
        .bind(&turn.id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "
            UPDATE chat_runs
            SET provider_turn_id = COALESCE(provider_turn_id, ?)
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(provider_turn_id)
        .bind(&turn.run_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "
            UPDATE chat_turns
            SET provider_turn_id = COALESCE(provider_turn_id, ?),
                updated_at_ms = ?
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(provider_turn_id)
        .bind(now)
        .bind(&turn.id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn run_is_terminal(
        &self,
        conversation_id: &str,
        run_id: &str,
    ) -> Result<bool, ChatServiceError> {
        let status = sqlx::query(
            "
            SELECT status
            FROM chat_runs
            WHERE conversation_id = ? AND id = ?
            LIMIT 1
            ",
        )
        .bind(conversation_id)
        .bind(run_id)
        .fetch_optional(&self.pool)
        .await?
        .and_then(|row| row.try_get::<String, _>("status").ok())
        .map(|status| parse_run_status(&status));
        Ok(matches!(
            status,
            Some(ChatRunStatus::Completed | ChatRunStatus::Interrupted | ChatRunStatus::Failed)
        ))
    }

    async fn persist_provider_thread_id(
        &self,
        conversation_id: &str,
        provider_thread_id: &str,
    ) -> Result<(), ChatServiceError> {
        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_conversations
            SET provider_thread_id = ?, updated_at_ms = ?, last_activity_at_ms = ?
            WHERE id = ?
            ",
        )
        .bind(provider_thread_id)
        .bind(now)
        .bind(now)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        let _ = self.emit_conversation_updated(conversation_id).await?;
        Ok(())
    }

    async fn persist_thread_preferences(
        &self,
        conversation_id: &str,
        selected_model: Option<String>,
        selected_effort: Option<ChatReasoningEffort>,
    ) -> Result<(), ChatServiceError> {
        if selected_model.is_none() && selected_effort.is_none() {
            return Ok(());
        }

        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_conversations
            SET
                selected_model = COALESCE(?, selected_model),
                selected_effort = COALESCE(?, selected_effort),
                updated_at_ms = ?,
                last_activity_at_ms = ?,
                revision = revision + 1
            WHERE id = ?
            ",
        )
        .bind(normalize_model_override(selected_model))
        .bind(selected_effort.map(|value| value.as_str().to_string()))
        .bind(now)
        .bind(now)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        let _ = self.emit_conversation_updated(conversation_id).await?;
        Ok(())
    }

    async fn persist_run_start(
        &self,
        conversation: &ChatConversationSummary,
        user_message_id: &str,
        assistant_message_id: &str,
        run_id: &str,
        turn_id: &str,
        text: &str,
    ) -> Result<(u32, i64), ChatServiceError> {
        let now = now_ms() as i64;
        let next_sequence = sqlx::query(
            "
            SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
            FROM chat_messages
            WHERE conversation_id = ?
            ",
        )
        .bind(&conversation.id)
        .fetch_one(&self.pool)
        .await?
        .try_get::<i64, _>("next_sequence")
        .unwrap_or(1) as u32;
        let title = if conversation.title == DEFAULT_CHAT_TITLE {
            derive_chat_title(text)
        } else {
            conversation.title.clone()
        };

        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "
            INSERT INTO chat_messages (
                id, conversation_id, turn_id, role, status, content_text,
                reasoning_text, sequence, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
        )
        .bind(user_message_id)
        .bind(&conversation.id)
        .bind(turn_id)
        .bind(ChatMessageRole::User.as_str())
        .bind(ChatMessageStatus::Completed.as_str())
        .bind(text)
        .bind("")
        .bind(i64::from(next_sequence))
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "
            INSERT INTO chat_messages (
                id, conversation_id, turn_id, role, status, content_text,
                reasoning_text, sequence, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
        )
        .bind(assistant_message_id)
        .bind(&conversation.id)
        .bind(turn_id)
        .bind(ChatMessageRole::Assistant.as_str())
        .bind(ChatMessageStatus::Streaming.as_str())
        .bind("")
        .bind("")
        .bind(i64::from(next_sequence + 1))
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "
            INSERT INTO chat_runs (
                id, conversation_id, turn_id, status, started_at_ms
            ) VALUES (?, ?, ?, ?, ?)
            ",
        )
        .bind(run_id)
        .bind(&conversation.id)
        .bind(turn_id)
        .bind(ChatRunStatus::Starting.as_str())
        .bind(now)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "
            INSERT INTO chat_turns (
                id, conversation_id, run_id, user_message_id,
                assistant_message_id, status, started_at_ms,
                created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
        )
        .bind(turn_id)
        .bind(&conversation.id)
        .bind(run_id)
        .bind(user_message_id)
        .bind(assistant_message_id)
        .bind(ChatTurnStatus::Starting.as_str())
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "
            UPDATE chat_conversations
            SET
                title = ?,
                updated_at_ms = ?,
                last_activity_at_ms = ?,
                last_message_at_ms = ?,
                last_run_state = ?,
                last_error = NULL,
                last_reconciliation_state = ?,
                last_reconciliation_error = NULL,
                revision = revision + 1
            WHERE id = ?
            ",
        )
        .bind(&title)
        .bind(now)
        .bind(now)
        .bind(now)
        .bind(ChatRunStatus::Starting.as_str())
        .bind(ChatReconciliationStatus::NotNeeded.as_str())
        .bind(&conversation.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;

        if let Some(summary) = self.emit_conversation_updated(&conversation.id).await? {
            if let Some(message) = self
                .get_message_by_id(&conversation.id, Some(user_message_id))
                .await?
            {
                self.events.emit(EventKind::ChatMessageUpdated {
                    session_id: summary.session_id.clone(),
                    conversation_id: conversation.id.clone(),
                    message,
                });
            }
            if let Some(message) = self
                .get_message_by_id(&conversation.id, Some(assistant_message_id))
                .await?
            {
                self.events.emit(EventKind::ChatMessageUpdated {
                    session_id: summary.session_id.clone(),
                    conversation_id: conversation.id.clone(),
                    message,
                });
            }
            if let Some(run) = self.latest_run(&conversation.id).await? {
                self.events.emit(EventKind::ChatRunUpdated {
                    session_id: summary.session_id.clone(),
                    conversation_id: conversation.id.clone(),
                    run,
                });
            }
            if let Some(turn) = self.get_turn_by_id(&conversation.id, turn_id).await? {
                self.events.emit(EventKind::ChatTurnUpdated {
                    session_id: summary.session_id.clone(),
                    conversation_id: conversation.id.clone(),
                    turn,
                });
            }
        }
        Ok((next_sequence + 1, now))
    }

    async fn attach_turn_to_run(
        &self,
        conversation_id: &str,
        run_id: &str,
        turn_id: &str,
        assistant_message_id: &str,
        provider_turn_id: Option<&str>,
    ) -> Result<(), ChatServiceError> {
        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_messages
            SET provider_turn_id = ?, updated_at_ms = ?
            WHERE turn_id = ? AND conversation_id = ?
            ",
        )
        .bind(provider_turn_id)
        .bind(now)
        .bind(turn_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "
            UPDATE chat_runs
            SET provider_turn_id = ?, status = ?
            WHERE id = ?
            ",
        )
        .bind(provider_turn_id)
        .bind(ChatRunStatus::Running.as_str())
        .bind(run_id)
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "
            UPDATE chat_turns
            SET provider_turn_id = ?, status = ?, updated_at_ms = ?
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(provider_turn_id)
        .bind(ChatTurnStatus::Running.as_str())
        .bind(now)
        .bind(turn_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "
            UPDATE chat_conversations
            SET last_run_state = ?, updated_at_ms = ?, last_activity_at_ms = ?, revision = revision + 1
            WHERE id = ?
            ",
        )
        .bind(ChatRunStatus::Running.as_str())
        .bind(now)
        .bind(now)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        if let Some(summary) = self.emit_conversation_updated(conversation_id).await? {
            let session_id = summary.session_id.clone();
            if let Some(turn) = self.get_turn_by_id(conversation_id, turn_id).await? {
                self.events.emit(EventKind::ChatTurnUpdated {
                    session_id: session_id.clone(),
                    conversation_id: conversation_id.to_string(),
                    turn,
                });
            }
            if let Some(message) = self
                .get_message_by_id(conversation_id, Some(assistant_message_id))
                .await?
            {
                self.events.emit(EventKind::ChatMessageUpdated {
                    session_id,
                    conversation_id: conversation_id.to_string(),
                    message,
                });
            }
        }
        Ok(())
    }

    async fn append_message_delta(
        &self,
        conversation_id: &str,
        message_id: &str,
        delta: &str,
    ) -> Result<(), ChatServiceError> {
        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_messages
            SET content_text = content_text || ?, updated_at_ms = ?, status = ?
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(delta)
        .bind(now)
        .bind(ChatMessageStatus::Streaming.as_str())
        .bind(message_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "
            UPDATE chat_conversations
            SET updated_at_ms = ?, last_activity_at_ms = ?, revision = revision + 1
            WHERE id = ?
            ",
        )
        .bind(now)
        .bind(now)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn append_message_reasoning_delta(
        &self,
        conversation_id: &str,
        message_id: &str,
        delta: &str,
    ) -> Result<Option<ChatMessage>, ChatServiceError> {
        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_messages
            SET reasoning_text = reasoning_text || ?, updated_at_ms = ?,
                status = ?
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(delta)
        .bind(now)
        .bind(ChatMessageStatus::Streaming.as_str())
        .bind(message_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "
            UPDATE chat_conversations
            SET updated_at_ms = ?, last_activity_at_ms = ?, revision = revision + 1
            WHERE id = ?
            ",
        )
        .bind(now)
        .bind(now)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        self.get_message_by_id(conversation_id, Some(message_id))
            .await
    }

    async fn replace_message_content(
        &self,
        conversation_id: &str,
        message_id: &str,
        text: &str,
        status: ChatMessageStatus,
    ) -> Result<(), ChatServiceError> {
        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_messages
            SET content_text = ?, updated_at_ms = ?, status = ?
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(text)
        .bind(now)
        .bind(status.as_str())
        .bind(message_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn replace_message_reasoning(
        &self,
        conversation_id: &str,
        message_id: &str,
        text: &str,
        status: ChatMessageStatus,
    ) -> Result<ChatMessage, ChatServiceError> {
        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_messages
            SET reasoning_text = ?, updated_at_ms = ?, status = ?
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(text)
        .bind(now)
        .bind(status.as_str())
        .bind(message_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        self.get_message_by_id(conversation_id, Some(message_id))
            .await?
            .ok_or_else(|| {
                ChatServiceError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "chat message missing after reasoning update",
                )
            })
    }

    async fn finalize_assistant_message(
        &self,
        conversation_id: &str,
        message_id: &str,
        text: &str,
        status: ChatMessageStatus,
    ) -> Result<Option<ChatMessage>, ChatServiceError> {
        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_messages
            SET content_text = CASE WHEN ? = '' THEN content_text ELSE ? END,
                updated_at_ms = ?, status = ?
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(text)
        .bind(text)
        .bind(now)
        .bind(status.as_str())
        .bind(message_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        self.get_message_by_id(conversation_id, Some(message_id))
            .await
    }

    async fn finalize_run(
        &self,
        conversation_id: &str,
        run_id: &str,
        status: ChatRunStatus,
        error_message: Option<String>,
    ) -> Result<ChatRun, ChatServiceError> {
        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_runs
            SET status = ?, finished_at_ms = ?, error_message = ?
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(status.as_str())
        .bind(now)
        .bind(&error_message)
        .bind(run_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "
            UPDATE chat_conversations
            SET
                updated_at_ms = ?,
                last_activity_at_ms = ?,
                last_run_state = ?,
                last_error = ?,
                revision = revision + 1
            WHERE id = ?
            ",
        )
        .bind(now)
        .bind(now)
        .bind(status.as_str())
        .bind(&error_message)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "
            UPDATE chat_turns
            SET status = ?, completed_at_ms = COALESCE(completed_at_ms, ?),
                error_message = ?, updated_at_ms = ?
            WHERE run_id = ? AND conversation_id = ?
            ",
        )
        .bind(chat_turn_status_from_run_status(status).as_str())
        .bind(now)
        .bind(&error_message)
        .bind(now)
        .bind(run_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        self.latest_run(conversation_id).await?.ok_or_else(|| {
            ChatServiceError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "chat run missing after finalization",
            )
        })
    }

    async fn latest_run(&self, conversation_id: &str) -> Result<Option<ChatRun>, ChatServiceError> {
        Ok(sqlx::query_as::<_, RunRow>(
            "
            SELECT
                id, conversation_id, turn_id, provider_turn_id, status,
                started_at_ms, finished_at_ms, error_message
            FROM chat_runs
            WHERE conversation_id = ?
            ORDER BY started_at_ms DESC, id DESC
            LIMIT 1
            ",
        )
        .bind(conversation_id)
        .fetch_optional(&self.pool)
        .await?
        .map(run_from_row))
    }

    async fn latest_assistant_message_id(
        &self,
        conversation_id: &str,
    ) -> Result<Option<String>, ChatServiceError> {
        Ok(sqlx::query(
            "
            SELECT id
            FROM chat_messages
            WHERE conversation_id = ? AND role = ?
            ORDER BY sequence DESC, created_at_ms DESC, id DESC
            LIMIT 1
            ",
        )
        .bind(conversation_id)
        .bind(ChatMessageRole::Assistant.as_str())
        .fetch_optional(&self.pool)
        .await?
        .and_then(|row| row.try_get::<String, _>("id").ok()))
    }

    async fn get_message_by_id(
        &self,
        conversation_id: &str,
        message_id: Option<&str>,
    ) -> Result<Option<ChatMessage>, ChatServiceError> {
        let Some(message_id) = message_id else {
            return Ok(None);
        };
        Ok(sqlx::query_as::<_, MessageRow>(
            "
            SELECT
                id, conversation_id, turn_id, item_id, provider_turn_id,
                provider_item_id, role, status, content_text, reasoning_text,
                sequence, created_at_ms, updated_at_ms
            FROM chat_messages
            WHERE conversation_id = ? AND id = ?
            ",
        )
        .bind(conversation_id)
        .bind(message_id)
        .fetch_optional(&self.pool)
        .await?
        .map(message_from_row))
    }

    async fn get_turn_by_id(
        &self,
        conversation_id: &str,
        turn_id: &str,
    ) -> Result<Option<ChatTurn>, ChatServiceError> {
        Ok(sqlx::query_as::<_, TurnRow>(
            "
            SELECT
                id, conversation_id, run_id, user_message_id,
                assistant_message_id, provider_turn_id, status,
                started_at_ms, completed_at_ms, error_message,
                reconciliation_status, reconciled_at_ms,
                reconciliation_error,
                created_at_ms, updated_at_ms
            FROM chat_turns
            WHERE conversation_id = ? AND id = ?
            ",
        )
        .bind(conversation_id)
        .bind(turn_id)
        .fetch_optional(&self.pool)
        .await?
        .map(turn_from_row))
    }

    async fn get_item_by_id(
        &self,
        conversation_id: &str,
        item_id: &str,
    ) -> Result<Option<ChatItem>, ChatServiceError> {
        Ok(sqlx::query_as::<_, ItemRow>(
            "
            SELECT
                id, conversation_id, turn_id, provider_turn_id,
                provider_item_id, kind, status, role, sequence, title,
                summary, metadata_json, created_at_ms, updated_at_ms,
                completed_at_ms
            FROM chat_items
            WHERE conversation_id = ? AND id = ?
            ",
        )
        .bind(conversation_id)
        .bind(item_id)
        .fetch_optional(&self.pool)
        .await?
        .map(item_from_row))
    }

    async fn get_item_output_by_id(
        &self,
        conversation_id: &str,
        output_id: &str,
    ) -> Result<Option<ChatItemOutput>, ChatServiceError> {
        Ok(sqlx::query_as::<_, ItemOutputRow>(
            "
            SELECT
                id, conversation_id, item_id, stream_kind, sequence,
                content_text, byte_count, created_at_ms, updated_at_ms
            FROM chat_item_outputs
            WHERE conversation_id = ? AND id = ?
            ",
        )
        .bind(conversation_id)
        .bind(output_id)
        .fetch_optional(&self.pool)
        .await?
        .map(item_output_from_row))
    }

    async fn latest_item_id_for_turn_kind(
        &self,
        conversation_id: &str,
        turn_id: Option<&str>,
        kind: ChatItemKind,
    ) -> Result<Option<String>, ChatServiceError> {
        let Some(turn_id) = turn_id else {
            return Ok(None);
        };
        Ok(sqlx::query(
            "
            SELECT id
            FROM chat_items
            WHERE conversation_id = ? AND turn_id = ? AND kind = ?
            ORDER BY sequence DESC, created_at_ms DESC, id DESC
            LIMIT 1
            ",
        )
        .bind(conversation_id)
        .bind(turn_id)
        .bind(kind.as_str())
        .fetch_optional(&self.pool)
        .await?
        .and_then(|row| row.try_get::<String, _>("id").ok()))
    }

    async fn upsert_chat_item(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        params: &Value,
        kind: ChatItemKind,
        status: ChatItemStatus,
    ) -> Result<Option<ChatItem>, ChatServiceError> {
        let route_hints = RouteHints::from_value(params);
        let item = params.get("item").unwrap_or(params);
        let (title, summary) = item_title_summary(kind, params);
        let provider_item_id = route_hints.item_id.or_else(|| {
            item.get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        });
        let provider_turn_id = route_hints.turn_id.or_else(|| {
            item.get("turnId")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        });
        let (turn_id, message_id, session_id) = {
            let state = runtime.state.lock().await;
            (
                state.active_turn_id.clone(),
                state.active_message_id.clone(),
                state.session_id.clone(),
            )
        };
        let existing_id = if let Some(provider_item_id) = provider_item_id.as_deref() {
            sqlx::query(
                "
                SELECT id
                FROM chat_items
                WHERE conversation_id = ? AND provider_item_id = ?
                LIMIT 1
                ",
            )
            .bind(conversation_id)
            .bind(provider_item_id)
            .fetch_optional(&self.pool)
            .await?
            .and_then(|row| row.try_get::<String, _>("id").ok())
        } else {
            self.latest_item_id_for_turn_kind(conversation_id, turn_id.as_deref(), kind)
                .await?
        };

        let now = now_ms() as i64;
        let item_id = if let Some(existing_id) = existing_id {
            existing_id
        } else {
            let next_sequence = sqlx::query(
                "
                SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
                FROM chat_items
                WHERE conversation_id = ?
                ",
            )
            .bind(conversation_id)
            .fetch_one(&self.pool)
            .await?
            .try_get::<i64, _>("next_sequence")
            .unwrap_or(1);
            let item_id = uuid::Uuid::new_v4().to_string();
            sqlx::query(
                "
                INSERT INTO chat_items (
                    id, conversation_id, turn_id, provider_turn_id,
                    provider_item_id, kind, status, role, sequence,
                    title, summary, metadata_json, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ",
            )
            .bind(&item_id)
            .bind(conversation_id)
            .bind(&turn_id)
            .bind(&provider_turn_id)
            .bind(&provider_item_id)
            .bind(kind.as_str())
            .bind(status.as_str())
            .bind(item_role_for_kind(kind).map(|role| role.as_str()))
            .bind(next_sequence)
            .bind(&title)
            .bind(&summary)
            .bind(item_metadata_json(params))
            .bind(now)
            .bind(now)
            .execute(&self.pool)
            .await?;
            item_id
        };

        sqlx::query(
            "
            UPDATE chat_items
            SET
                turn_id = COALESCE(turn_id, ?),
                provider_turn_id = COALESCE(provider_turn_id, ?),
                provider_item_id = COALESCE(provider_item_id, ?),
                kind = ?,
                status = ?,
                title = COALESCE(?, title),
                summary = COALESCE(?, summary),
                metadata_json = ?,
                updated_at_ms = ?,
                completed_at_ms = CASE WHEN ? THEN ? ELSE completed_at_ms END
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(&turn_id)
        .bind(&provider_turn_id)
        .bind(&provider_item_id)
        .bind(kind.as_str())
        .bind(status.as_str())
        .bind(&title)
        .bind(&summary)
        .bind(item_metadata_json(params))
        .bind(now)
        .bind(matches!(
            status,
            ChatItemStatus::Completed | ChatItemStatus::Failed
        ))
        .bind(now)
        .bind(&item_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;

        if let Some(provider_item_id) = provider_item_id.as_deref() {
            self.register_item_route(conversation_id, runtime, provider_item_id)
                .await;
        }
        if matches!(kind, ChatItemKind::AgentMessage)
            && let Some(message_id) = message_id.as_deref()
        {
            sqlx::query(
                "
                UPDATE chat_messages
                SET item_id = COALESCE(item_id, ?),
                    provider_item_id = COALESCE(provider_item_id, ?),
                    updated_at_ms = ?
                WHERE id = ? AND conversation_id = ?
                ",
            )
            .bind(&item_id)
            .bind(&provider_item_id)
            .bind(now)
            .bind(message_id)
            .bind(conversation_id)
            .execute(&self.pool)
            .await?;
        }

        let item = self.get_item_by_id(conversation_id, &item_id).await?;
        if let Some(item) = item.clone() {
            if kind.is_activity() {
                self.events.emit(EventKind::ChatActivityUpdated {
                    session_id: session_id.clone(),
                    conversation_id: conversation_id.to_string(),
                    item: item.clone(),
                });
            }
            self.events.emit(EventKind::ChatItemUpdated {
                session_id,
                conversation_id: conversation_id.to_string(),
                item,
            });
        }
        Ok(item)
    }

    async fn append_activity_output(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        params: &Value,
        kind: ChatItemKind,
        default_stream_kind: &str,
    ) -> Result<(), ChatServiceError> {
        let Some(delta) = extract_activity_delta(params) else {
            let _ = self
                .upsert_chat_item(
                    conversation_id,
                    runtime,
                    params,
                    kind,
                    ChatItemStatus::Streaming,
                )
                .await?;
            return Ok(());
        };
        if delta.is_empty() {
            return Ok(());
        }
        let Some(item) = self
            .upsert_chat_item(
                conversation_id,
                runtime,
                params,
                kind,
                ChatItemStatus::Streaming,
            )
            .await?
        else {
            return Ok(());
        };

        let stream_kind = extract_stream_kind(params).unwrap_or(default_stream_kind);
        let next_sequence = sqlx::query(
            "
            SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
            FROM chat_item_outputs
            WHERE conversation_id = ? AND item_id = ?
            ",
        )
        .bind(conversation_id)
        .bind(&item.id)
        .fetch_one(&self.pool)
        .await?
        .try_get::<i64, _>("next_sequence")
        .unwrap_or(1);
        let now = now_ms() as i64;
        let output_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "
            INSERT INTO chat_item_outputs (
                id, conversation_id, item_id, stream_kind, sequence,
                content_text, byte_count, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
        )
        .bind(&output_id)
        .bind(conversation_id)
        .bind(&item.id)
        .bind(stream_kind)
        .bind(next_sequence)
        .bind(&delta)
        .bind(delta.len() as i64)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;

        let summary = summarize_activity_text(&delta);
        sqlx::query(
            "
            UPDATE chat_items
            SET summary = CASE
                    WHEN summary IS NULL OR summary = '' THEN ?
                    ELSE substr(summary || ?, 1, 240)
                END,
                updated_at_ms = ?
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(&summary)
        .bind(&summary)
        .bind(now)
        .bind(&item.id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;

        let Some(updated_item) = self.get_item_by_id(conversation_id, &item.id).await? else {
            return Ok(());
        };
        let Some(output) = self
            .get_item_output_by_id(conversation_id, &output_id)
            .await?
        else {
            return Ok(());
        };
        let session_id = { runtime.state.lock().await.session_id.clone() };
        self.events.emit(EventKind::ChatActivityDelta {
            session_id: session_id.clone(),
            conversation_id: conversation_id.to_string(),
            item_id: item.id.clone(),
            output,
        });
        self.events.emit(EventKind::ChatActivityUpdated {
            session_id: session_id.clone(),
            conversation_id: conversation_id.to_string(),
            item: updated_item.clone(),
        });
        self.events.emit(EventKind::ChatItemUpdated {
            session_id,
            conversation_id: conversation_id.to_string(),
            item: updated_item,
        });
        Ok(())
    }

    async fn append_reasoning_item_delta(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        params: &Value,
        delta: &str,
        status: ChatItemStatus,
    ) -> Result<Option<ChatItem>, ChatServiceError> {
        if delta.is_empty() {
            return self
                .upsert_chat_item(
                    conversation_id,
                    runtime,
                    params,
                    ChatItemKind::Reasoning,
                    status,
                )
                .await;
        }
        let Some(item) = self
            .upsert_chat_item(
                conversation_id,
                runtime,
                params,
                ChatItemKind::Reasoning,
                status,
            )
            .await?
        else {
            return Ok(None);
        };

        let next_sequence = sqlx::query(
            "
            SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
            FROM chat_item_outputs
            WHERE conversation_id = ? AND item_id = ?
            ",
        )
        .bind(conversation_id)
        .bind(&item.id)
        .fetch_one(&self.pool)
        .await?
        .try_get::<i64, _>("next_sequence")
        .unwrap_or(1);
        let now = now_ms() as i64;
        let output_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "
            INSERT INTO chat_item_outputs (
                id, conversation_id, item_id, stream_kind, sequence,
                content_text, byte_count, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
        )
        .bind(&output_id)
        .bind(conversation_id)
        .bind(&item.id)
        .bind("reasoning")
        .bind(next_sequence)
        .bind(delta)
        .bind(delta.len() as i64)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;

        sqlx::query(
            "
            UPDATE chat_items
            SET summary = CASE
                    WHEN summary IS NULL OR summary = '' THEN substr(?, 1, 1200)
                    ELSE substr(summary || ?, 1, 1200)
                END,
                updated_at_ms = ?
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(delta)
        .bind(delta)
        .bind(now)
        .bind(&item.id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;

        let Some(updated_item) = self.get_item_by_id(conversation_id, &item.id).await? else {
            return Ok(None);
        };
        let Some(output) = self
            .get_item_output_by_id(conversation_id, &output_id)
            .await?
        else {
            return Ok(Some(updated_item));
        };
        let session_id = { runtime.state.lock().await.session_id.clone() };
        self.events.emit(EventKind::ChatActivityDelta {
            session_id: session_id.clone(),
            conversation_id: conversation_id.to_string(),
            item_id: updated_item.id.clone(),
            output,
        });
        self.events.emit(EventKind::ChatItemUpdated {
            session_id,
            conversation_id: conversation_id.to_string(),
            item: updated_item.clone(),
        });
        Ok(Some(updated_item))
    }

    async fn get_plan_by_id(
        &self,
        conversation_id: &str,
        plan_id: &str,
    ) -> Result<Option<ChatPlan>, ChatServiceError> {
        Ok(sqlx::query_as::<_, PlanRow>(
            "
            SELECT
                id, conversation_id, turn_id, item_id, provider_turn_id,
                provider_item_id, kind, status, content_text, steps_json,
                metadata_json, owner_generation, sequence, created_at_ms,
                updated_at_ms, completed_at_ms
            FROM chat_plans
            WHERE conversation_id = ? AND id = ?
            ",
        )
        .bind(conversation_id)
        .bind(plan_id)
        .fetch_optional(&self.pool)
        .await?
        .map(plan_from_row))
    }

    async fn get_diff_summary_by_id(
        &self,
        conversation_id: &str,
        diff_id: &str,
    ) -> Result<Option<ChatDiffSummary>, ChatServiceError> {
        Ok(sqlx::query_as::<_, DiffSummaryRow>(
            "
            SELECT
                id, conversation_id, turn_id, provider_turn_id,
                changed_file_count, additions, deletions, files_json,
                metadata_json, owner_generation, sequence, created_at_ms,
                updated_at_ms
            FROM chat_diff_summaries
            WHERE conversation_id = ? AND id = ?
            ",
        )
        .bind(conversation_id)
        .bind(diff_id)
        .fetch_optional(&self.pool)
        .await?
        .map(diff_summary_from_row))
    }

    async fn get_context_usage_by_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<Option<ChatContextUsage>, ChatServiceError> {
        Ok(sqlx::query_as::<_, ContextUsageRow>(
            "
            SELECT
                id, conversation_id, provider_thread_id, used_tokens,
                max_tokens, percent_used, total_processed_tokens,
                metadata_json, updated_at_ms
            FROM chat_context_usage
            WHERE conversation_id = ?
            ",
        )
        .bind(conversation_id)
        .fetch_optional(&self.pool)
        .await?
        .map(context_usage_from_row))
    }

    async fn next_plan_sequence(&self, conversation_id: &str) -> Result<i64, ChatServiceError> {
        Ok(sqlx::query(
            "
            SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
            FROM (
                SELECT sequence FROM chat_items WHERE conversation_id = ?
                UNION ALL
                SELECT sequence FROM chat_pending_requests WHERE conversation_id = ?
                UNION ALL
                SELECT sequence FROM chat_plans WHERE conversation_id = ?
                UNION ALL
                SELECT sequence FROM chat_diff_summaries WHERE conversation_id = ?
            ) AS sequences
            ",
        )
        .bind(conversation_id)
        .bind(conversation_id)
        .bind(conversation_id)
        .bind(conversation_id)
        .fetch_one(&self.pool)
        .await?
        .try_get::<i64, _>("next_sequence")
        .unwrap_or(1))
    }

    async fn upsert_active_plan(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        params: &Value,
    ) -> Result<Option<ChatPlan>, ChatServiceError> {
        let route_hints = RouteHints::from_value(params);
        let (turn_id, owner_generation, session_id) = {
            let state = runtime.state.lock().await;
            (
                state.active_turn_id.clone(),
                state.owner_generation,
                state.session_id.clone(),
            )
        };
        let provider_turn_id = route_hints.turn_id.or_else(|| extract_turn_id(params));
        let existing_id = if let Some(turn_id) = turn_id.as_deref() {
            sqlx::query(
                "
                SELECT id
                FROM chat_plans
                WHERE conversation_id = ? AND turn_id = ? AND kind = ?
                LIMIT 1
                ",
            )
            .bind(conversation_id)
            .bind(turn_id)
            .bind(ChatPlanKind::ActiveTask.as_str())
            .fetch_optional(&self.pool)
            .await?
            .and_then(|row| row.try_get::<String, _>("id").ok())
        } else {
            None
        };
        let now = now_ms() as i64;
        let plan_id = if let Some(existing_id) = existing_id {
            existing_id
        } else {
            let plan_id = uuid::Uuid::new_v4().to_string();
            let sequence = self.next_plan_sequence(conversation_id).await?;
            sqlx::query(
                "
                INSERT INTO chat_plans (
                    id, conversation_id, turn_id, provider_turn_id, kind,
                    status, content_text, steps_json, metadata_json,
                    owner_generation, sequence, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, '', '[]', '{}', ?, ?, ?, ?)
                ",
            )
            .bind(&plan_id)
            .bind(conversation_id)
            .bind(&turn_id)
            .bind(&provider_turn_id)
            .bind(ChatPlanKind::ActiveTask.as_str())
            .bind(ChatPlanStatus::Streaming.as_str())
            .bind(owner_generation as i64)
            .bind(sequence)
            .bind(now)
            .bind(now)
            .execute(&self.pool)
            .await?;
            plan_id
        };

        let steps_json = normalize_plan_steps_json(params);
        let content_text = extract_plan_text(params);
        sqlx::query(
            "
            UPDATE chat_plans
            SET turn_id = COALESCE(turn_id, ?),
                provider_turn_id = COALESCE(provider_turn_id, ?),
                status = ?,
                content_text = ?,
                steps_json = ?,
                metadata_json = ?,
                owner_generation = ?,
                updated_at_ms = ?
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(&turn_id)
        .bind(&provider_turn_id)
        .bind(ChatPlanStatus::Streaming.as_str())
        .bind(content_text)
        .bind(steps_json)
        .bind(compact_payload_json(params))
        .bind(owner_generation as i64)
        .bind(now)
        .bind(&plan_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        let plan = self.get_plan_by_id(conversation_id, &plan_id).await?;
        if let Some(plan) = plan.clone() {
            self.events.emit(EventKind::ChatPlanUpdated {
                session_id,
                conversation_id: conversation_id.to_string(),
                plan,
            });
        }
        Ok(plan)
    }

    async fn append_proposed_plan_delta(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        params: &Value,
        delta: &str,
    ) -> Result<Option<ChatPlan>, ChatServiceError> {
        let route_hints = RouteHints::from_value(params);
        let (turn_id, owner_generation, session_id) = {
            let state = runtime.state.lock().await;
            (
                state.active_turn_id.clone(),
                state.owner_generation,
                state.session_id.clone(),
            )
        };
        let provider_item_id = route_hints.item_id.clone();
        let provider_turn_id = route_hints.turn_id.or_else(|| extract_turn_id(params));
        let item_id = if let Some(provider_item_id) = provider_item_id.as_deref() {
            sqlx::query(
                "
                SELECT id
                FROM chat_items
                WHERE conversation_id = ? AND provider_item_id = ?
                LIMIT 1
                ",
            )
            .bind(conversation_id)
            .bind(provider_item_id)
            .fetch_optional(&self.pool)
            .await?
            .and_then(|row| row.try_get::<String, _>("id").ok())
        } else {
            None
        };
        let existing_id = if let Some(provider_item_id) = provider_item_id.as_deref() {
            sqlx::query(
                "
                SELECT id
                FROM chat_plans
                WHERE conversation_id = ? AND provider_item_id = ?
                LIMIT 1
                ",
            )
            .bind(conversation_id)
            .bind(provider_item_id)
            .fetch_optional(&self.pool)
            .await?
            .and_then(|row| row.try_get::<String, _>("id").ok())
        } else if let Some(turn_id) = turn_id.as_deref() {
            sqlx::query(
                "
                SELECT id
                FROM chat_plans
                WHERE conversation_id = ? AND turn_id = ? AND kind = ?
                ORDER BY sequence DESC, created_at_ms DESC, id DESC
                LIMIT 1
                ",
            )
            .bind(conversation_id)
            .bind(turn_id)
            .bind(ChatPlanKind::ProposedPlan.as_str())
            .fetch_optional(&self.pool)
            .await?
            .and_then(|row| row.try_get::<String, _>("id").ok())
        } else {
            None
        };
        let now = now_ms() as i64;
        let plan_id = if let Some(existing_id) = existing_id {
            existing_id
        } else {
            let plan_id = uuid::Uuid::new_v4().to_string();
            let sequence = self.next_plan_sequence(conversation_id).await?;
            sqlx::query(
                "
                INSERT INTO chat_plans (
                    id, conversation_id, turn_id, item_id, provider_turn_id,
                    provider_item_id, kind, status, content_text, steps_json,
                    metadata_json, owner_generation, sequence, created_at_ms,
                    updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '[]', '{}', ?, ?, ?, ?)
                ",
            )
            .bind(&plan_id)
            .bind(conversation_id)
            .bind(&turn_id)
            .bind(&item_id)
            .bind(&provider_turn_id)
            .bind(&provider_item_id)
            .bind(ChatPlanKind::ProposedPlan.as_str())
            .bind(ChatPlanStatus::Streaming.as_str())
            .bind(owner_generation as i64)
            .bind(sequence)
            .bind(now)
            .bind(now)
            .execute(&self.pool)
            .await?;
            plan_id
        };

        sqlx::query(
            "
            UPDATE chat_plans
            SET turn_id = COALESCE(turn_id, ?),
                item_id = COALESCE(item_id, ?),
                provider_turn_id = COALESCE(provider_turn_id, ?),
                provider_item_id = COALESCE(provider_item_id, ?),
                status = ?,
                content_text = content_text || ?,
                metadata_json = ?,
                owner_generation = ?,
                updated_at_ms = ?
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(&turn_id)
        .bind(&item_id)
        .bind(&provider_turn_id)
        .bind(&provider_item_id)
        .bind(ChatPlanStatus::Streaming.as_str())
        .bind(delta)
        .bind(compact_payload_json(params))
        .bind(owner_generation as i64)
        .bind(now)
        .bind(&plan_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        let plan = self.get_plan_by_id(conversation_id, &plan_id).await?;
        if let Some(plan) = plan.clone() {
            self.events.emit(EventKind::ChatPlanUpdated {
                session_id,
                conversation_id: conversation_id.to_string(),
                plan,
            });
        }
        Ok(plan)
    }

    async fn finalize_proposed_plan_for_item(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        params: &Value,
    ) -> Result<(), ChatServiceError> {
        let route_hints = RouteHints::from_value(params);
        let Some(provider_item_id) = route_hints.item_id.as_deref() else {
            return Ok(());
        };
        let row = sqlx::query_as::<_, PlanRow>(
            "
            SELECT
                id, conversation_id, turn_id, item_id, provider_turn_id,
                provider_item_id, kind, status, content_text, steps_json,
                metadata_json, owner_generation, sequence, created_at_ms,
                updated_at_ms, completed_at_ms
            FROM chat_plans
            WHERE conversation_id = ? AND provider_item_id = ? AND kind = ?
            LIMIT 1
            ",
        )
        .bind(conversation_id)
        .bind(provider_item_id)
        .bind(ChatPlanKind::ProposedPlan.as_str())
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(());
        };
        let session_id = { runtime.state.lock().await.session_id.clone() };
        let now = now_ms() as i64;
        let item = params.get("item").unwrap_or(params);
        let final_text = item
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty());
        sqlx::query(
            "
            UPDATE chat_plans
            SET status = ?,
                content_text = COALESCE(?, content_text),
                metadata_json = ?,
                updated_at_ms = ?,
                completed_at_ms = ?
            WHERE conversation_id = ? AND id = ?
            ",
        )
        .bind(ChatPlanStatus::Completed.as_str())
        .bind(final_text)
        .bind(compact_payload_json(params))
        .bind(now)
        .bind(now)
        .bind(conversation_id)
        .bind(&row.id)
        .execute(&self.pool)
        .await?;
        if let Some(plan) = self.get_plan_by_id(conversation_id, &row.id).await? {
            self.events.emit(EventKind::ChatPlanUpdated {
                session_id,
                conversation_id: conversation_id.to_string(),
                plan,
            });
        }
        Ok(())
    }

    async fn finalize_streaming_plans_for_turn(
        &self,
        conversation_id: &str,
        session_id: &str,
        turn_id: &str,
        provider_turn_id: Option<&str>,
        status: ChatPlanStatus,
    ) -> Result<(), ChatServiceError> {
        let rows = sqlx::query_as::<_, PlanRow>(
            "
            SELECT
                id, conversation_id, turn_id, item_id, provider_turn_id,
                provider_item_id, kind, status, content_text, steps_json,
                metadata_json, owner_generation, sequence, created_at_ms,
                updated_at_ms, completed_at_ms
            FROM chat_plans
            WHERE conversation_id = ? AND status = ?
                AND (
                    turn_id = ?
                    OR (? IS NOT NULL AND provider_turn_id = ?)
                )
            ",
        )
        .bind(conversation_id)
        .bind(ChatPlanStatus::Streaming.as_str())
        .bind(turn_id)
        .bind(provider_turn_id)
        .bind(provider_turn_id)
        .fetch_all(&self.pool)
        .await?;
        let now = now_ms() as i64;
        for row in rows {
            sqlx::query(
                "
                UPDATE chat_plans
                SET status = ?, updated_at_ms = ?, completed_at_ms = ?
                WHERE conversation_id = ? AND id = ?
                ",
            )
            .bind(status.as_str())
            .bind(now)
            .bind(now)
            .bind(conversation_id)
            .bind(&row.id)
            .execute(&self.pool)
            .await?;
            if let Some(plan) = self.get_plan_by_id(conversation_id, &row.id).await? {
                self.events.emit(EventKind::ChatPlanUpdated {
                    session_id: session_id.to_string(),
                    conversation_id: conversation_id.to_string(),
                    plan,
                });
            }
        }
        Ok(())
    }

    async fn upsert_diff_summary(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        params: &Value,
    ) -> Result<Option<ChatDiffSummary>, ChatServiceError> {
        let route_hints = RouteHints::from_value(params);
        let (turn_id, owner_generation, session_id) = {
            let state = runtime.state.lock().await;
            (
                state.active_turn_id.clone(),
                state.owner_generation,
                state.session_id.clone(),
            )
        };
        let provider_turn_id = route_hints.turn_id.or_else(|| extract_turn_id(params));
        let existing_id = if let Some(turn_id) = turn_id.as_deref() {
            sqlx::query(
                "
                SELECT id
                FROM chat_diff_summaries
                WHERE conversation_id = ? AND turn_id = ?
                LIMIT 1
                ",
            )
            .bind(conversation_id)
            .bind(turn_id)
            .fetch_optional(&self.pool)
            .await?
            .and_then(|row| row.try_get::<String, _>("id").ok())
        } else {
            None
        };
        let now = now_ms() as i64;
        let diff_id = if let Some(existing_id) = existing_id {
            existing_id
        } else {
            let diff_id = uuid::Uuid::new_v4().to_string();
            let sequence = self.next_plan_sequence(conversation_id).await?;
            sqlx::query(
                "
                INSERT INTO chat_diff_summaries (
                    id, conversation_id, turn_id, provider_turn_id,
                    changed_file_count, files_json, metadata_json,
                    owner_generation, sequence, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, 0, '[]', '{}', ?, ?, ?, ?)
                ",
            )
            .bind(&diff_id)
            .bind(conversation_id)
            .bind(&turn_id)
            .bind(&provider_turn_id)
            .bind(owner_generation as i64)
            .bind(sequence)
            .bind(now)
            .bind(now)
            .execute(&self.pool)
            .await?;
            diff_id
        };
        let files = extract_diff_files(params);
        let additions = extract_u32_field(params, &["additions", "addedLines", "insertions"]);
        let deletions = extract_u32_field(params, &["deletions", "deletedLines", "removals"]);
        let changed_file_count = extract_u32_field(params, &["changedFileCount", "fileCount"])
            .unwrap_or(files.len() as u32);
        sqlx::query(
            "
            UPDATE chat_diff_summaries
            SET turn_id = COALESCE(turn_id, ?),
                provider_turn_id = COALESCE(provider_turn_id, ?),
                changed_file_count = ?,
                additions = ?,
                deletions = ?,
                files_json = ?,
                metadata_json = ?,
                owner_generation = ?,
                updated_at_ms = ?
            WHERE conversation_id = ? AND id = ?
            ",
        )
        .bind(&turn_id)
        .bind(&provider_turn_id)
        .bind(changed_file_count as i64)
        .bind(additions.map(|value| value as i64))
        .bind(deletions.map(|value| value as i64))
        .bind(serde_json::to_string(&files).unwrap_or_else(|_| "[]".to_string()))
        .bind(compact_payload_json(params))
        .bind(owner_generation as i64)
        .bind(now)
        .bind(conversation_id)
        .bind(&diff_id)
        .execute(&self.pool)
        .await?;
        let diff = self
            .get_diff_summary_by_id(conversation_id, &diff_id)
            .await?;
        if let Some(diff) = diff.clone() {
            self.events.emit(EventKind::ChatDiffUpdated {
                session_id,
                conversation_id: conversation_id.to_string(),
                diff,
            });
        }
        Ok(diff)
    }

    async fn upsert_context_usage(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        params: &Value,
    ) -> Result<Option<ChatContextUsage>, ChatServiceError> {
        let (provider_thread_id, session_id) = {
            let state = runtime.state.lock().await;
            (state.provider_thread_id.clone(), state.session_id.clone())
        };
        let used_tokens = extract_u32_field(
            params,
            &[
                "usedTokens",
                "tokensUsed",
                "inputTokens",
                "contextUsedTokens",
            ],
        );
        let max_tokens = extract_u32_field(
            params,
            &[
                "maxTokens",
                "contextWindow",
                "contextWindowTokens",
                "limitTokens",
            ],
        );
        let total_processed_tokens = extract_u32_field(
            params,
            &["totalProcessedTokens", "totalTokens", "processedTokens"],
        );
        let percent_used = extract_f64_field(params, &["percentUsed", "contextPercentUsed"])
            .or_else(|| match (used_tokens, max_tokens) {
                (Some(used), Some(max)) if max > 0 => Some((used as f64 / max as f64) * 100.0),
                _ => None,
            })
            .map(|value| value.clamp(0.0, 100.0));
        let now = now_ms() as i64;
        let usage_id = sqlx::query(
            "
            SELECT id
            FROM chat_context_usage
            WHERE conversation_id = ?
            LIMIT 1
            ",
        )
        .bind(conversation_id)
        .fetch_optional(&self.pool)
        .await?
        .and_then(|row| row.try_get::<String, _>("id").ok())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        sqlx::query(
            "
            INSERT INTO chat_context_usage (
                id, conversation_id, provider_thread_id, used_tokens,
                max_tokens, percent_used, total_processed_tokens,
                metadata_json, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(conversation_id) DO UPDATE SET
                provider_thread_id = COALESCE(excluded.provider_thread_id, provider_thread_id),
                used_tokens = excluded.used_tokens,
                max_tokens = excluded.max_tokens,
                percent_used = excluded.percent_used,
                total_processed_tokens = excluded.total_processed_tokens,
                metadata_json = excluded.metadata_json,
                updated_at_ms = excluded.updated_at_ms
            ",
        )
        .bind(&usage_id)
        .bind(conversation_id)
        .bind(&provider_thread_id)
        .bind(used_tokens.map(|value| value as i64))
        .bind(max_tokens.map(|value| value as i64))
        .bind(percent_used)
        .bind(total_processed_tokens.map(|value| value as i64))
        .bind(compact_payload_json(params))
        .bind(now)
        .execute(&self.pool)
        .await?;
        let usage = self
            .get_context_usage_by_conversation(conversation_id)
            .await?;
        if let Some(usage) = usage.clone() {
            self.events
                .emit(EventKind::ChatContextUsageUpdated { session_id, usage });
            let _ = self.emit_conversation_updated(conversation_id).await?;
        }
        Ok(usage)
    }

    async fn finalize_turn(
        &self,
        conversation_id: &str,
        turn_id: &str,
        status: ChatTurnStatus,
        error_message: Option<String>,
    ) -> Result<ChatTurn, ChatServiceError> {
        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_turns
            SET status = ?, completed_at_ms = ?, error_message = ?,
                updated_at_ms = ?
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(status.as_str())
        .bind(now)
        .bind(&error_message)
        .bind(now)
        .bind(turn_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await?;
        self.get_turn_by_id(conversation_id, turn_id)
            .await?
            .ok_or_else(|| {
                ChatServiceError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "chat turn missing after finalization",
                )
            })
    }

    async fn emit_app_server_status(&self) {
        self.events.emit(EventKind::ChatAppServerUpdated {
            app_server: self.app_server.status().await,
        });
    }

    async fn emit_thread_stream_status(
        &self,
        conversation_id: &str,
        runtime_state: &Arc<Mutex<RuntimeState>>,
        last_error: Option<String>,
    ) {
        let state = runtime_state.lock().await.clone();
        self.events.emit(EventKind::ChatThreadStreamUpdated {
            session_id: state.session_id.clone(),
            stream: thread_stream_status_from_state(
                conversation_id,
                state.clone(),
                last_error.clone(),
            ),
        });
        self.events.emit(EventKind::ChatRuntimeUpdated {
            session_id: state.session_id.clone(),
            runtime: ChatRuntimeStatus {
                conversation_id: conversation_id.to_string(),
                session_id: state.session_id.clone(),
                project_id: state.project_id.clone(),
                worktree_id: state.worktree_id.clone(),
                lifecycle: state.lifecycle,
                active_run_id: state.active_run_id.clone(),
                active_message_id: state.active_message_id.clone(),
                provider_thread_id: state.provider_thread_id.clone(),
                last_error: last_error.or(state.last_error),
                updated_at: now_ms(),
            },
        });
    }

    async fn emit_conversation_updated(
        &self,
        conversation_id: &str,
    ) -> Result<Option<ChatConversationSummary>, ChatServiceError> {
        let Some(summary) = self.get_conversation_summary(conversation_id).await? else {
            return Ok(None);
        };
        self.events.emit(EventKind::ChatConversationUpdated {
            session_id: summary.session_id.clone(),
            conversation: summary.clone(),
        });
        Ok(Some(summary))
    }

    fn cleanup_conversation_runtime(&self, conversation_id: &str) {
        self.runtimes.remove(conversation_id);
        self.op_locks.remove(conversation_id);
        self.thread_to_conversation
            .retain(|_, route| route.conversation_id != conversation_id);
        self.turn_to_conversation
            .retain(|_, route| route.conversation_id != conversation_id);
        self.item_to_conversation
            .retain(|_, route| route.conversation_id != conversation_id);
        self.server_request_to_conversation
            .retain(|_, route| route.route.conversation_id != conversation_id);
        self.pending_server_responders
            .retain(|_, responder| responder.conversation_id != conversation_id);
    }

    async fn conversation_has_active_work(
        &self,
        conversation_id: &str,
    ) -> Result<bool, ChatServiceError> {
        let row: (i64,) = sqlx::query_as(
            "
            SELECT EXISTS(
                SELECT 1
                FROM chat_runs
                WHERE conversation_id = ?
                    AND status IN ('starting', 'running')
                UNION ALL
                SELECT 1
                FROM chat_pending_requests
                WHERE conversation_id = ?
                    AND status IN ('pending', 'resolving')
                UNION ALL
                SELECT 1
                FROM chat_reconciliations
                WHERE conversation_id = ?
                    AND status IN ('pending', 'running')
            )
            ",
        )
        .bind(conversation_id)
        .bind(conversation_id)
        .bind(conversation_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.0 != 0)
    }

    async fn delete_conversation_rows(
        &self,
        conversation_id: &str,
    ) -> Result<(), ChatServiceError> {
        let mut tx = self.pool.begin().await?;
        delete_chat_conversation_rows_in_tx(&mut tx, conversation_id).await?;
        tx.commit().await?;
        Ok(())
    }

    async fn delete_project_conversation_rows(
        &self,
        project_id: &str,
    ) -> Result<(), ChatServiceError> {
        let mut tx = self.pool.begin().await?;
        delete_project_chat_rows_in_tx(&mut tx, project_id).await?;
        tx.commit().await?;
        Ok(())
    }

    fn operation_lock(&self, conversation_id: &str) -> Arc<Mutex<()>> {
        self.op_locks
            .entry(conversation_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

fn normalize_branch_name(value: impl AsRef<str>) -> Option<String> {
    let trimmed = value.as_ref().trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

async fn delete_chat_conversation_rows_in_tx(
    tx: &mut Transaction<'_, Sqlite>,
    conversation_id: &str,
) -> Result<(), sqlx::Error> {
    for table in [
        "chat_item_outputs",
        "chat_reconciliations",
        "chat_context_usage",
        "chat_diff_summaries",
        "chat_plans",
        "chat_pending_requests",
        "chat_items",
        "chat_turns",
        "chat_runs",
        "chat_messages",
    ] {
        let sql = format!("DELETE FROM {table} WHERE conversation_id = ?");
        sqlx::query(&sql)
            .bind(conversation_id)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query("DELETE FROM chat_conversations WHERE id = ?")
        .bind(conversation_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn delete_project_chat_rows_in_tx(
    tx: &mut Transaction<'_, Sqlite>,
    project_id: &str,
) -> Result<(), sqlx::Error> {
    for table in [
        "chat_item_outputs",
        "chat_reconciliations",
        "chat_context_usage",
        "chat_diff_summaries",
        "chat_plans",
        "chat_pending_requests",
        "chat_items",
        "chat_turns",
        "chat_runs",
        "chat_messages",
    ] {
        let sql = format!(
            "DELETE FROM {table}
             WHERE conversation_id IN (
                 SELECT id FROM chat_conversations WHERE project_id = ?
             )"
        );
        sqlx::query(&sql)
            .bind(project_id)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query("DELETE FROM chat_conversations WHERE project_id = ?")
        .bind(project_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

fn conversation_from_row(row: ConversationRow) -> ChatConversationSummary {
    ChatConversationSummary {
        id: row.id,
        session_id: row.session_id,
        project_id: row.project_id,
        worktree_id: row.worktree_id,
        branch_name: row.branch_name.and_then(normalize_branch_name),
        provider: parse_provider(&row.provider),
        provider_thread_id: row.provider_thread_id,
        title: row.title,
        created_at: row.created_at_ms.max(0) as u64,
        updated_at: row.updated_at_ms.max(0) as u64,
        last_activity_at: row.last_activity_at_ms.max(0) as u64,
        last_message_at: row.last_message_at_ms.map(|value| value.max(0) as u64),
        open_tab_id: row.open_tab_id,
        archived_at: row.archived_at_ms.map(|value| value.max(0) as u64),
        selected_model: normalize_model_override(row.selected_model),
        selected_effort: row.selected_effort.as_deref().map(parse_reasoning_effort),
        selected_permission_mode: row
            .selected_permission_mode
            .as_deref()
            .and_then(parse_permission_mode),
        last_run_state: parse_run_status(&row.last_run_state),
        last_error: row.last_error,
        last_reconciliation_state: parse_reconciliation_status(&row.last_reconciliation_state),
        last_reconciliation_error: row.last_reconciliation_error,
        context_used_tokens: row.context_used_tokens.map(|value| value.max(0) as u32),
        context_max_tokens: row.context_max_tokens.map(|value| value.max(0) as u32),
        context_percent_used: row.context_percent_used,
        context_updated_at: row.context_updated_at_ms.map(|value| value.max(0) as u64),
        pending_request_count: row.pending_request_count.max(0) as u32,
        latest_pending_request_id: row.latest_pending_request_id,
        latest_pending_request_kind: row
            .latest_pending_request_kind
            .as_deref()
            .map(parse_pending_request_kind),
        latest_pending_request_status: row
            .latest_pending_request_status
            .as_deref()
            .map(parse_pending_request_status),
        has_pending_request_attention: row.pending_request_count > 0,
        revision: row.revision.max(0) as u64,
    }
}

fn chat_app_server_lifecycle_from_process(state: AppServerProcessState) -> ChatAppServerLifecycle {
    match state {
        AppServerProcessState::Stopped => ChatAppServerLifecycle::Stopped,
        AppServerProcessState::Starting => ChatAppServerLifecycle::Starting,
        AppServerProcessState::Initializing => ChatAppServerLifecycle::Initializing,
        AppServerProcessState::Ready => ChatAppServerLifecycle::Ready,
        AppServerProcessState::Stopping => ChatAppServerLifecycle::Stopping,
        AppServerProcessState::Fatal => ChatAppServerLifecycle::Fatal,
    }
}

fn chat_thread_resume_state_from_lifecycle(
    state: ThreadStreamResumeState,
) -> ChatThreadStreamResumeState {
    match state {
        ThreadStreamResumeState::NotStarted => ChatThreadStreamResumeState::NotStarted,
        ThreadStreamResumeState::NeedsResume => ChatThreadStreamResumeState::NeedsResume,
        ThreadStreamResumeState::Resuming => ChatThreadStreamResumeState::Resuming,
        ThreadStreamResumeState::Resumed => ChatThreadStreamResumeState::Resumed,
    }
}

fn thread_stream_status_from_state(
    conversation_id: &str,
    state: RuntimeState,
    last_error: Option<String>,
) -> ChatThreadStreamStatus {
    ChatThreadStreamStatus {
        conversation_id: conversation_id.to_string(),
        session_id: state.session_id,
        project_id: state.project_id,
        worktree_id: state.worktree_id,
        resume_state: chat_thread_resume_state_from_lifecycle(
            state.stream_lifecycle.resume_state(),
        ),
        lifecycle: state.lifecycle,
        active_run_id: state.active_run_id,
        active_message_id: state.active_message_id,
        provider_thread_id: state.provider_thread_id,
        inactive_deadline_at: state.inactive_deadline_at,
        last_error: last_error.or(state.last_error),
        updated_at: now_ms(),
    }
}

fn parse_provider(provider: &str) -> ChatProvider {
    match provider {
        "codex" => ChatProvider::Codex,
        _ => ChatProvider::Codex,
    }
}

fn provider_request_id_from_jsonrpc_id(id: &Value) -> String {
    id.as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| id.to_string())
}

fn pending_request_kind_for_method(method: &str) -> ChatPendingRequestKind {
    match method {
        "item/commandExecution/requestApproval" => ChatPendingRequestKind::CommandApproval,
        "item/fileChange/requestApproval" => ChatPendingRequestKind::FileApproval,
        "item/permissions/requestApproval" => ChatPendingRequestKind::PermissionApproval,
        "item/tool/requestUserInput" => ChatPendingRequestKind::StructuredInput,
        "mcpServer/elicitation/request" => ChatPendingRequestKind::McpElicitation,
        _ => ChatPendingRequestKind::Unsupported,
    }
}

fn pending_request_decision_as_str(decision: &ChatPendingRequestDecision) -> &'static str {
    match decision {
        ChatPendingRequestDecision::Accept => "accept",
        ChatPendingRequestDecision::AcceptForSession => "acceptForSession",
        ChatPendingRequestDecision::Decline => "decline",
        ChatPendingRequestDecision::Cancel => "cancel",
        ChatPendingRequestDecision::AcceptWithExecpolicyAmendment => {
            "acceptWithExecpolicyAmendment"
        }
        ChatPendingRequestDecision::ApplyNetworkPolicyAmendment => "applyNetworkPolicyAmendment",
        ChatPendingRequestDecision::Submit => "submit",
    }
}

fn compact_payload_json(value: &Value) -> String {
    let mut text = serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string());
    const MAX_LEN: usize = 64 * 1024;
    if text.len() <= MAX_LEN {
        return text;
    }
    text.truncate(MAX_LEN);
    serde_json::to_string(&json!({
        "truncated": true,
        "prefix": text,
    }))
    .unwrap_or_else(|_| "{\"truncated\":true}".to_string())
}

fn pending_request_payload(request: &ChatPendingRequest) -> Value {
    serde_json::from_str(&request.payload_json).unwrap_or(Value::Null)
}

fn provider_response_for_pending_request(
    request: &ChatPendingRequest,
    resolution: &ResolveChatPendingRequestRequest,
) -> Result<Value, ChatServiceError> {
    let payload = pending_request_payload(request);
    let decision = &resolution.decision;
    match request.kind {
        ChatPendingRequestKind::PermissionApproval => {
            if matches!(
                decision,
                ChatPendingRequestDecision::Decline | ChatPendingRequestDecision::Cancel
            ) {
                return Ok(json!({ "permissions": {}, "scope": "turn" }));
            }
            let permissions = resolution
                .value
                .clone()
                .or_else(|| payload.get("permissions").cloned())
                .unwrap_or_else(|| json!({}));
            Ok(json!({ "permissions": permissions, "scope": "turn" }))
        }
        ChatPendingRequestKind::StructuredInput | ChatPendingRequestKind::McpElicitation => {
            if matches!(decision, ChatPendingRequestDecision::Cancel) {
                return Ok(json!({ "decision": "cancel" }));
            }
            if matches!(decision, ChatPendingRequestDecision::Decline) {
                return Ok(json!({ "decision": "decline" }));
            }
            Ok(resolution
                .value
                .clone()
                .unwrap_or_else(|| json!({ "answers": {} })))
        }
        _ => Ok(match decision {
            ChatPendingRequestDecision::Accept => json!({ "decision": "accept" }),
            ChatPendingRequestDecision::AcceptForSession => {
                json!({ "decision": "acceptForSession" })
            }
            ChatPendingRequestDecision::Decline => json!({ "decision": "decline" }),
            ChatPendingRequestDecision::Cancel => json!({ "decision": "cancel" }),
            ChatPendingRequestDecision::AcceptWithExecpolicyAmendment => {
                let value = resolution
                    .value
                    .clone()
                    .or_else(|| payload.get("proposedExecpolicyAmendment").cloned())
                    .ok_or_else(|| {
                        ChatServiceError::new(
                            StatusCode::BAD_REQUEST,
                            "execpolicy amendment decision requires a value",
                        )
                    })?;
                json!({
                    "decision": {
                        "acceptWithExecpolicyAmendment": value
                    }
                })
            }
            ChatPendingRequestDecision::ApplyNetworkPolicyAmendment => {
                let value = resolution
                    .value
                    .clone()
                    .or_else(|| payload.get("proposedNetworkPolicyAmendment").cloned())
                    .or_else(|| payload.get("proposedNetworkPolicyAmendments").cloned())
                    .ok_or_else(|| {
                        ChatServiceError::new(
                            StatusCode::BAD_REQUEST,
                            "network policy amendment decision requires a value",
                        )
                    })?;
                json!({
                    "decision": {
                        "applyNetworkPolicyAmendment": value
                    }
                })
            }
            ChatPendingRequestDecision::Submit => {
                return Err(ChatServiceError::new(
                    StatusCode::BAD_REQUEST,
                    "submit is only valid for structured input requests",
                ));
            }
        }),
    }
}

async fn request_session_id(
    service: &ChatService,
    conversation_id: &str,
) -> Result<String, ChatServiceError> {
    service
        .get_conversation_summary(conversation_id)
        .await?
        .map(|summary| summary.session_id)
        .ok_or_else(|| ChatServiceError::new(StatusCode::NOT_FOUND, "chat not found"))
}

fn parse_pending_request_kind(kind: &str) -> ChatPendingRequestKind {
    match kind {
        "command_approval" => ChatPendingRequestKind::CommandApproval,
        "file_approval" => ChatPendingRequestKind::FileApproval,
        "permission_approval" => ChatPendingRequestKind::PermissionApproval,
        "structured_input" => ChatPendingRequestKind::StructuredInput,
        "mcp_elicitation" => ChatPendingRequestKind::McpElicitation,
        _ => ChatPendingRequestKind::Unsupported,
    }
}

fn parse_pending_request_status(status: &str) -> ChatPendingRequestStatus {
    match status {
        "pending" => ChatPendingRequestStatus::Pending,
        "resolving" => ChatPendingRequestStatus::Resolving,
        "resolved" => ChatPendingRequestStatus::Resolved,
        "declined" => ChatPendingRequestStatus::Declined,
        "cancelled" => ChatPendingRequestStatus::Cancelled,
        "stale" => ChatPendingRequestStatus::Stale,
        "failed" => ChatPendingRequestStatus::Failed,
        _ => ChatPendingRequestStatus::Failed,
    }
}

fn parse_pending_request_decision(decision: Option<String>) -> Option<ChatPendingRequestDecision> {
    decision.as_deref().map(|decision| match decision {
        "accept" => ChatPendingRequestDecision::Accept,
        "acceptForSession" => ChatPendingRequestDecision::AcceptForSession,
        "decline" => ChatPendingRequestDecision::Decline,
        "cancel" => ChatPendingRequestDecision::Cancel,
        "acceptWithExecpolicyAmendment" => {
            ChatPendingRequestDecision::AcceptWithExecpolicyAmendment
        }
        "applyNetworkPolicyAmendment" => ChatPendingRequestDecision::ApplyNetworkPolicyAmendment,
        "submit" => ChatPendingRequestDecision::Submit,
        _ => ChatPendingRequestDecision::Decline,
    })
}

fn message_from_row(row: MessageRow) -> ChatMessage {
    ChatMessage {
        id: row.id,
        conversation_id: row.conversation_id,
        turn_id: row.turn_id,
        item_id: row.item_id,
        provider_turn_id: row.provider_turn_id,
        provider_item_id: row.provider_item_id,
        role: if row.role == "assistant" {
            ChatMessageRole::Assistant
        } else {
            ChatMessageRole::User
        },
        status: parse_message_status(&row.status),
        content_text: row.content_text,
        reasoning_text: row.reasoning_text,
        sequence: row.sequence.max(0) as u32,
        created_at: row.created_at_ms.max(0) as u64,
        updated_at: row.updated_at_ms.max(0) as u64,
    }
}

fn run_from_row(row: RunRow) -> ChatRun {
    ChatRun {
        id: row.id,
        conversation_id: row.conversation_id,
        turn_id: row.turn_id,
        provider_turn_id: row.provider_turn_id,
        status: parse_run_status(&row.status),
        started_at: row.started_at_ms.max(0) as u64,
        finished_at: row.finished_at_ms.map(|value| value.max(0) as u64),
        error_message: row.error_message,
    }
}

fn turn_from_row(row: TurnRow) -> ChatTurn {
    ChatTurn {
        id: row.id,
        conversation_id: row.conversation_id,
        run_id: row.run_id,
        user_message_id: row.user_message_id,
        assistant_message_id: row.assistant_message_id,
        provider_turn_id: row.provider_turn_id,
        status: parse_turn_row_status(&row.status),
        started_at: row.started_at_ms.max(0) as u64,
        completed_at: row.completed_at_ms.map(|value| value.max(0) as u64),
        error_message: row.error_message,
        reconciliation_status: parse_reconciliation_status(&row.reconciliation_status),
        reconciled_at: row.reconciled_at_ms.map(|value| value.max(0) as u64),
        reconciliation_error: row.reconciliation_error,
        created_at: row.created_at_ms.max(0) as u64,
        updated_at: row.updated_at_ms.max(0) as u64,
    }
}

fn item_from_row(row: ItemRow) -> ChatItem {
    ChatItem {
        id: row.id,
        conversation_id: row.conversation_id,
        turn_id: row.turn_id,
        provider_turn_id: row.provider_turn_id,
        provider_item_id: row.provider_item_id,
        kind: parse_item_kind(&row.kind),
        status: parse_item_status(&row.status),
        role: row.role.as_deref().map(parse_message_role),
        sequence: row.sequence.max(0) as u32,
        title: row.title,
        summary: row.summary,
        metadata_json: row.metadata_json,
        created_at: row.created_at_ms.max(0) as u64,
        updated_at: row.updated_at_ms.max(0) as u64,
        completed_at: row.completed_at_ms.map(|value| value.max(0) as u64),
    }
}

fn item_output_from_row(row: ItemOutputRow) -> ChatItemOutput {
    ChatItemOutput {
        id: row.id,
        conversation_id: row.conversation_id,
        item_id: row.item_id,
        stream_kind: row.stream_kind,
        sequence: row.sequence.max(0) as u32,
        content_text: row.content_text,
        byte_count: row.byte_count.max(0) as u32,
        created_at: row.created_at_ms.max(0) as u64,
        updated_at: row.updated_at_ms.max(0) as u64,
    }
}

fn plan_from_row(row: PlanRow) -> ChatPlan {
    ChatPlan {
        id: row.id,
        conversation_id: row.conversation_id,
        turn_id: row.turn_id,
        item_id: row.item_id,
        provider_turn_id: row.provider_turn_id,
        provider_item_id: row.provider_item_id,
        kind: parse_plan_kind(&row.kind),
        status: parse_plan_status(&row.status),
        content_text: row.content_text,
        steps_json: row.steps_json,
        metadata_json: row.metadata_json,
        owner_generation: row.owner_generation.max(0) as u64,
        sequence: row.sequence.max(0) as u32,
        created_at: row.created_at_ms.max(0) as u64,
        updated_at: row.updated_at_ms.max(0) as u64,
        completed_at: row.completed_at_ms.map(|value| value.max(0) as u64),
    }
}

fn diff_summary_from_row(row: DiffSummaryRow) -> ChatDiffSummary {
    ChatDiffSummary {
        id: row.id,
        conversation_id: row.conversation_id,
        turn_id: row.turn_id,
        provider_turn_id: row.provider_turn_id,
        changed_file_count: row.changed_file_count.max(0) as u32,
        additions: row.additions.map(|value| value.max(0) as u32),
        deletions: row.deletions.map(|value| value.max(0) as u32),
        files: parse_diff_files_json(&row.files_json),
        metadata_json: row.metadata_json,
        owner_generation: row.owner_generation.max(0) as u64,
        sequence: row.sequence.max(0) as u32,
        created_at: row.created_at_ms.max(0) as u64,
        updated_at: row.updated_at_ms.max(0) as u64,
    }
}

fn context_usage_from_row(row: ContextUsageRow) -> ChatContextUsage {
    ChatContextUsage {
        id: row.id,
        conversation_id: row.conversation_id,
        provider_thread_id: row.provider_thread_id,
        used_tokens: row.used_tokens.map(|value| value.max(0) as u32),
        max_tokens: row.max_tokens.map(|value| value.max(0) as u32),
        percent_used: row.percent_used,
        total_processed_tokens: row.total_processed_tokens.map(|value| value.max(0) as u32),
        metadata_json: row.metadata_json,
        updated_at: row.updated_at_ms.max(0) as u64,
    }
}

fn pending_request_from_row(row: PendingRequestRow) -> ChatPendingRequest {
    ChatPendingRequest {
        id: row.id,
        conversation_id: row.conversation_id,
        turn_id: row.turn_id,
        item_id: row.item_id,
        provider_request_id: row.provider_request_id,
        provider_turn_id: row.provider_turn_id,
        provider_item_id: row.provider_item_id,
        method: row.method,
        kind: parse_pending_request_kind(&row.kind),
        status: parse_pending_request_status(&row.status),
        decision: parse_pending_request_decision(row.decision),
        payload_json: row.payload_json,
        response_json: row.response_json,
        error_message: row.error_message,
        owner_generation: row.owner_generation.max(0) as u64,
        sequence: row.sequence.max(0) as u32,
        created_at: row.created_at_ms.max(0) as u64,
        updated_at: row.updated_at_ms.max(0) as u64,
        resolved_at: row.resolved_at_ms.map(|value| value.max(0) as u64),
    }
}

fn pending_request_summary_from_row(row: PendingRequestSummaryRow) -> ChatPendingRequestSummary {
    ChatPendingRequestSummary {
        id: row.id,
        conversation_id: row.conversation_id,
        kind: parse_pending_request_kind(&row.kind),
        status: parse_pending_request_status(&row.status),
        method: row.method,
        created_at: row.created_at_ms.max(0) as u64,
        updated_at: row.updated_at_ms.max(0) as u64,
    }
}

fn reconciliation_from_row(row: ReconciliationRow) -> ChatReconciliation {
    ChatReconciliation {
        id: row.id,
        conversation_id: row.conversation_id,
        provider_thread_id: row.provider_thread_id,
        status: parse_reconciliation_status(&row.status),
        reason: row.reason,
        started_at: row.started_at_ms.max(0) as u64,
        finished_at: row.finished_at_ms.map(|value| value.max(0) as u64),
        error_message: row.error_message,
        owner_generation: row.owner_generation.max(0) as u64,
        created_at: row.created_at_ms.max(0) as u64,
        updated_at: row.updated_at_ms.max(0) as u64,
    }
}

fn parse_message_role(value: &str) -> ChatMessageRole {
    if value == "assistant" {
        ChatMessageRole::Assistant
    } else {
        ChatMessageRole::User
    }
}

fn parse_message_status(value: &str) -> ChatMessageStatus {
    match value {
        "pending" => ChatMessageStatus::Pending,
        "streaming" => ChatMessageStatus::Streaming,
        "interrupted" => ChatMessageStatus::Interrupted,
        "failed" => ChatMessageStatus::Failed,
        _ => ChatMessageStatus::Completed,
    }
}

fn parse_run_status(value: &str) -> ChatRunStatus {
    match value {
        "starting" => ChatRunStatus::Starting,
        "running" => ChatRunStatus::Running,
        "interrupted" => ChatRunStatus::Interrupted,
        "failed" => ChatRunStatus::Failed,
        _ => ChatRunStatus::Completed,
    }
}

fn parse_turn_row_status(value: &str) -> ChatTurnStatus {
    match value {
        "starting" => ChatTurnStatus::Starting,
        "running" => ChatTurnStatus::Running,
        "interrupted" => ChatTurnStatus::Interrupted,
        "failed" => ChatTurnStatus::Failed,
        _ => ChatTurnStatus::Completed,
    }
}

fn chat_turn_status_from_run_status(status: ChatRunStatus) -> ChatTurnStatus {
    match status {
        ChatRunStatus::Starting => ChatTurnStatus::Starting,
        ChatRunStatus::Running => ChatTurnStatus::Running,
        ChatRunStatus::Completed => ChatTurnStatus::Completed,
        ChatRunStatus::Interrupted => ChatTurnStatus::Interrupted,
        ChatRunStatus::Failed => ChatTurnStatus::Failed,
    }
}

fn parse_item_kind(value: &str) -> ChatItemKind {
    match value {
        "agent_message" => ChatItemKind::AgentMessage,
        "reasoning" => ChatItemKind::Reasoning,
        "command_execution" => ChatItemKind::CommandExecution,
        "file_change" => ChatItemKind::FileChange,
        "mcp_tool_call" => ChatItemKind::McpToolCall,
        "dynamic_tool_call" => ChatItemKind::DynamicToolCall,
        "web_search" => ChatItemKind::WebSearch,
        "image_view" => ChatItemKind::ImageView,
        "hook" => ChatItemKind::Hook,
        "auto_approval_review" => ChatItemKind::AutoApprovalReview,
        "model_reroute" => ChatItemKind::ModelReroute,
        _ => ChatItemKind::Unknown,
    }
}

fn parse_item_status(value: &str) -> ChatItemStatus {
    match value {
        "started" => ChatItemStatus::Started,
        "completed" => ChatItemStatus::Completed,
        "failed" => ChatItemStatus::Failed,
        _ => ChatItemStatus::Streaming,
    }
}

fn parse_reconciliation_status(value: &str) -> ChatReconciliationStatus {
    match value {
        "pending" => ChatReconciliationStatus::Pending,
        "running" => ChatReconciliationStatus::Running,
        "completed" => ChatReconciliationStatus::Completed,
        "failed" => ChatReconciliationStatus::Failed,
        _ => ChatReconciliationStatus::NotNeeded,
    }
}

fn parse_plan_kind(value: &str) -> ChatPlanKind {
    match value {
        "proposed_plan" => ChatPlanKind::ProposedPlan,
        _ => ChatPlanKind::ActiveTask,
    }
}

fn parse_plan_status(value: &str) -> ChatPlanStatus {
    match value {
        "completed" => ChatPlanStatus::Completed,
        "failed" => ChatPlanStatus::Failed,
        _ => ChatPlanStatus::Streaming,
    }
}

fn parse_diff_files_json(value: &str) -> Vec<ChatDiffFileSummary> {
    serde_json::from_str(value).unwrap_or_default()
}

fn parse_reasoning_effort(value: &str) -> ChatReasoningEffort {
    match value {
        "none" => ChatReasoningEffort::None,
        "minimal" => ChatReasoningEffort::Minimal,
        "low" => ChatReasoningEffort::Low,
        "high" => ChatReasoningEffort::High,
        "xhigh" => ChatReasoningEffort::Xhigh,
        _ => ChatReasoningEffort::Medium,
    }
}

fn parse_permission_mode(value: &str) -> Option<ChatPermissionMode> {
    match value {
        "full_access" => Some(ChatPermissionMode::FullAccess),
        _ => None,
    }
}

fn parse_turn_status(value: &str) -> ChatRunStatus {
    match value {
        "interrupted" => ChatRunStatus::Interrupted,
        "failed" | "error" => ChatRunStatus::Failed,
        _ => ChatRunStatus::Completed,
    }
}

fn derive_chat_title(text: &str) -> String {
    const MAX_LEN: usize = 48;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return DEFAULT_CHAT_TITLE.to_string();
    }
    let collapsed = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut title = collapsed.chars().take(MAX_LEN).collect::<String>();
    if collapsed.chars().count() > MAX_LEN {
        title.push('…');
    }
    title
}

fn extract_thread_id(value: &Value) -> Option<String> {
    value
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| value.get("id").and_then(Value::as_str).map(str::to_string))
}

fn extract_turn_id(value: &Value) -> Option<String> {
    value
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| value.get("id").and_then(Value::as_str).map(str::to_string))
}

fn extract_model(value: &Value) -> Option<String> {
    value
        .get("model")
        .and_then(Value::as_str)
        .and_then(|model| normalize_model_ref(Some(model)).map(str::to_string))
}

fn normalize_model_override(value: Option<String>) -> Option<String> {
    value.and_then(|model| {
        let trimmed = model.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_model_ref(value: Option<&str>) -> Option<&str> {
    value.and_then(|model| {
        let trimmed = model.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(model)
        }
    })
}

fn extract_reasoning_effort(value: &Value) -> Option<ChatReasoningEffort> {
    value
        .get("reasoningEffort")
        .and_then(Value::as_str)
        .map(parse_reasoning_effort)
}

fn apply_thread_permission_mode(
    params: &mut serde_json::Map<String, Value>,
    permission_mode: Option<ChatPermissionMode>,
) {
    if matches!(permission_mode, Some(ChatPermissionMode::FullAccess)) {
        params.insert(
            "approvalPolicy".to_string(),
            Value::String("never".to_string()),
        );
        params.insert(
            "sandbox".to_string(),
            Value::String("danger-full-access".to_string()),
        );
    }
}

fn apply_turn_permission_mode(
    params: &mut serde_json::Map<String, Value>,
    permission_mode: Option<ChatPermissionMode>,
) {
    if matches!(permission_mode, Some(ChatPermissionMode::FullAccess)) {
        params.insert(
            "approvalPolicy".to_string(),
            Value::String("never".to_string()),
        );
        params.insert(
            "sandboxPolicy".to_string(),
            json!({
                "type": "dangerFullAccess",
            }),
        );
    }
}

async fn start_provider_thread(
    app_server: &Arc<CodexAppServerManager>,
    worktree_path: &str,
    selected_model: Option<&str>,
    permission_mode: Option<ChatPermissionMode>,
) -> Result<(String, Value), ChatServiceError> {
    let params = build_thread_start_params(worktree_path, selected_model, permission_mode);
    let result = app_server
        .request("thread/start", Value::Object(params))
        .await?;
    let thread_id = extract_thread_id(&result).ok_or_else(|| {
        ChatServiceError::new(
            StatusCode::BAD_GATEWAY,
            "codex app-server did not return a thread id",
        )
    })?;
    Ok((thread_id, result))
}

fn build_thread_start_params(
    worktree_path: &str,
    selected_model: Option<&str>,
    permission_mode: Option<ChatPermissionMode>,
) -> serde_json::Map<String, Value> {
    let mut params = serde_json::Map::new();
    params.insert("cwd".to_string(), Value::String(worktree_path.to_string()));
    if let Some(model) = normalize_model_ref(selected_model) {
        params.insert("model".to_string(), Value::String(model.to_string()));
    }
    apply_thread_permission_mode(&mut params, permission_mode);
    params
}

fn build_turn_start_params(
    thread_id: &str,
    worktree_path: &str,
    text: &str,
    conversation: &ChatConversationSummary,
) -> serde_json::Map<String, Value> {
    let mut params = serde_json::Map::new();
    params.insert("cwd".to_string(), Value::String(worktree_path.to_string()));
    params.insert("threadId".to_string(), Value::String(thread_id.to_string()));
    params.insert(
        "input".to_string(),
        json!([
            {
                "type": "text",
                "text": text,
            }
        ]),
    );
    if let Some(model) = normalize_model_ref(conversation.selected_model.as_deref()) {
        params.insert("model".to_string(), Value::String(model.to_string()));
    }
    if let Some(effort) = conversation.selected_effort {
        params.insert(
            "effort".to_string(),
            Value::String(effort.as_str().to_string()),
        );
    }
    apply_turn_permission_mode(&mut params, conversation.selected_permission_mode);
    params
}

fn has_blank_model_field(value: &Value) -> bool {
    value
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|model| model.trim().is_empty())
}

fn item_kind_from_params(value: &Value) -> ChatItemKind {
    let item_type = value
        .get("item")
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
        .or_else(|| value.get("type").and_then(Value::as_str));
    match item_type {
        Some("agentMessage") => ChatItemKind::AgentMessage,
        Some("reasoning") | Some("reasoningSummary") => ChatItemKind::Reasoning,
        Some("commandExecution") | Some("command_execution") | Some("exec") => {
            ChatItemKind::CommandExecution
        }
        Some("fileChange") | Some("file_change") => ChatItemKind::FileChange,
        Some("mcpToolCall") | Some("mcp_tool_call") => ChatItemKind::McpToolCall,
        Some("dynamicToolCall") | Some("dynamic_tool_call") => ChatItemKind::DynamicToolCall,
        Some("webSearch") | Some("web_search") => ChatItemKind::WebSearch,
        Some("imageView") | Some("image_view") => ChatItemKind::ImageView,
        Some("hook") => ChatItemKind::Hook,
        Some("autoApprovalReview") | Some("auto_approval_review") => {
            ChatItemKind::AutoApprovalReview
        }
        Some("modelReroute") | Some("model_reroute") => ChatItemKind::ModelReroute,
        _ if is_commentary_phase(value) => ChatItemKind::Reasoning,
        _ => ChatItemKind::Unknown,
    }
}

fn agent_message_projection_from_value(value: &Value) -> Option<AgentMessageProjection> {
    let item_type = value
        .get("item")
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
        .or_else(|| value.get("type").and_then(Value::as_str));
    if item_type != Some("agentMessage") {
        return None;
    }

    if is_commentary_phase(value) {
        Some(AgentMessageProjection::Reasoning)
    } else {
        Some(AgentMessageProjection::Response)
    }
}

fn is_plan_payload(value: &Value) -> bool {
    let item_type = value
        .get("item")
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
        .or_else(|| value.get("type").and_then(Value::as_str));
    matches!(item_type, Some("plan" | "proposedPlan" | "proposed_plan"))
}

fn normalize_plan_steps_json(value: &Value) -> String {
    let steps = value
        .get("steps")
        .or_else(|| value.get("plan").and_then(|plan| plan.get("steps")))
        .or_else(|| {
            value
                .get("turn")
                .and_then(|turn| turn.get("plan"))
                .and_then(|plan| plan.get("steps"))
        })
        .cloned()
        .unwrap_or_else(|| json!([]));
    serde_json::to_string(&steps).unwrap_or_else(|_| "[]".to_string())
}

fn extract_plan_text(value: &Value) -> String {
    value
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("plan")
                .and_then(|plan| plan.get("text"))
                .and_then(Value::as_str)
        })
        .or_else(|| value.get("summary").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

fn extract_u32_field(value: &Value, names: &[&str]) -> Option<u32> {
    for name in names {
        if let Some(number) = value.get(*name).and_then(Value::as_u64) {
            return Some(number.min(u32::MAX as u64) as u32);
        }
        if let Some(number) = value
            .get("usage")
            .and_then(|usage| usage.get(*name))
            .and_then(Value::as_u64)
        {
            return Some(number.min(u32::MAX as u64) as u32);
        }
        if let Some(number) = value
            .get("diff")
            .and_then(|diff| diff.get(*name))
            .and_then(Value::as_u64)
        {
            return Some(number.min(u32::MAX as u64) as u32);
        }
    }
    None
}

fn extract_f64_field(value: &Value, names: &[&str]) -> Option<f64> {
    for name in names {
        if let Some(number) = value.get(*name).and_then(Value::as_f64) {
            return Some(number);
        }
        if let Some(number) = value
            .get("usage")
            .and_then(|usage| usage.get(*name))
            .and_then(Value::as_f64)
        {
            return Some(number);
        }
    }
    None
}

fn extract_diff_files(value: &Value) -> Vec<ChatDiffFileSummary> {
    let files = value
        .get("files")
        .or_else(|| value.get("changedFiles"))
        .or_else(|| value.get("diff").and_then(|diff| diff.get("files")))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    files
        .into_iter()
        .filter_map(|file| {
            if let Some(path) = file.as_str() {
                return Some(ChatDiffFileSummary {
                    path: path.to_string(),
                    original_path: None,
                    change_type: None,
                    additions: None,
                    deletions: None,
                });
            }
            let path = file
                .get("path")
                .and_then(Value::as_str)
                .or_else(|| file.get("newPath").and_then(Value::as_str))
                .or_else(|| file.get("displayPath").and_then(Value::as_str))?;
            Some(ChatDiffFileSummary {
                path: path.to_string(),
                original_path: file
                    .get("originalPath")
                    .and_then(Value::as_str)
                    .or_else(|| file.get("oldPath").and_then(Value::as_str))
                    .map(ToOwned::to_owned),
                change_type: file
                    .get("changeType")
                    .and_then(Value::as_str)
                    .or_else(|| file.get("status").and_then(Value::as_str))
                    .map(ToOwned::to_owned),
                additions: file
                    .get("additions")
                    .and_then(Value::as_u64)
                    .map(|value| value.min(u32::MAX as u64) as u32),
                deletions: file
                    .get("deletions")
                    .and_then(Value::as_u64)
                    .map(|value| value.min(u32::MAX as u64) as u32),
            })
        })
        .take(20)
        .collect()
}

fn item_role_for_kind(kind: ChatItemKind) -> Option<ChatMessageRole> {
    match kind {
        ChatItemKind::AgentMessage | ChatItemKind::Reasoning => Some(ChatMessageRole::Assistant),
        ChatItemKind::CommandExecution
        | ChatItemKind::FileChange
        | ChatItemKind::McpToolCall
        | ChatItemKind::DynamicToolCall
        | ChatItemKind::WebSearch
        | ChatItemKind::ImageView
        | ChatItemKind::Hook
        | ChatItemKind::AutoApprovalReview
        | ChatItemKind::ModelReroute
        | ChatItemKind::Unknown => None,
    }
}

fn is_global_provider_notification(method: &str) -> bool {
    matches!(
        method,
        "remoteControl/status/changed" | "mcpServer/startupStatus/updated"
    )
}

fn item_metadata_json(value: &Value) -> String {
    let item = value.get("item").unwrap_or(value);
    let metadata = json!({
        "type": item.get("type").and_then(Value::as_str),
        "phase": item.get("phase").and_then(Value::as_str)
            .or_else(|| value.get("phase").and_then(Value::as_str)),
        "summaryIndex": value.get("summaryIndex").and_then(Value::as_u64),
        "command": item.get("command").and_then(Value::as_str)
            .or_else(|| value.get("command").and_then(Value::as_str)),
        "cwd": item.get("cwd").and_then(Value::as_str)
            .or_else(|| value.get("cwd").and_then(Value::as_str)),
        "exitCode": item.get("exitCode").and_then(Value::as_i64)
            .or_else(|| value.get("exitCode").and_then(Value::as_i64)),
        "path": item.get("path").and_then(Value::as_str)
            .or_else(|| value.get("path").and_then(Value::as_str)),
        "toolName": item.get("toolName").and_then(Value::as_str)
            .or_else(|| value.get("toolName").and_then(Value::as_str))
            .or_else(|| item.get("name").and_then(Value::as_str)),
        "serverName": item.get("serverName").and_then(Value::as_str)
            .or_else(|| value.get("serverName").and_then(Value::as_str)),
        "fromModel": value.get("fromModel").and_then(Value::as_str)
            .or_else(|| item.get("fromModel").and_then(Value::as_str)),
        "toModel": value.get("toModel").and_then(Value::as_str)
            .or_else(|| item.get("toModel").and_then(Value::as_str)),
    });
    serde_json::to_string(&metadata).unwrap_or_else(|_| "{}".to_string())
}

fn item_title_summary(kind: ChatItemKind, value: &Value) -> (Option<String>, Option<String>) {
    let item = value.get("item").unwrap_or(value);
    let title = item
        .get("title")
        .and_then(Value::as_str)
        .or_else(|| value.get("title").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .or_else(|| match kind {
            ChatItemKind::CommandExecution => extract_command(item)
                .or_else(|| extract_command(value))
                .map(|command| format!("Run `{}`", summarize_inline(command, 72))),
            ChatItemKind::FileChange => extract_path(item)
                .or_else(|| extract_path(value))
                .map(|path| format!("Edit {path}"))
                .or_else(|| Some("File change".to_string())),
            ChatItemKind::McpToolCall => extract_tool_name(item)
                .or_else(|| extract_tool_name(value))
                .map(|name| format!("Use {name}"))
                .or_else(|| Some("Tool call".to_string())),
            ChatItemKind::DynamicToolCall => Some("Tool call".to_string()),
            ChatItemKind::WebSearch => Some("Web search".to_string()),
            ChatItemKind::ImageView => Some("View image".to_string()),
            ChatItemKind::Hook => Some("Run hook".to_string()),
            ChatItemKind::AutoApprovalReview => Some("Review permissions".to_string()),
            ChatItemKind::ModelReroute => Some("Model rerouted".to_string()),
            ChatItemKind::AgentMessage | ChatItemKind::Reasoning | ChatItemKind::Unknown => None,
        });
    let summary = item
        .get("summary")
        .and_then(Value::as_str)
        .or_else(|| value.get("summary").and_then(Value::as_str))
        .or_else(|| value.get("message").and_then(Value::as_str))
        .map(summarize_activity_text);
    (title, summary)
}

fn extract_activity_delta(value: &Value) -> Option<String> {
    value
        .get("delta")
        .and_then(Value::as_str)
        .or_else(|| value.get("output").and_then(Value::as_str))
        .or_else(|| value.get("text").and_then(Value::as_str))
        .or_else(|| value.get("chunk").and_then(Value::as_str))
        .or_else(|| value.pointer("/item/delta").and_then(Value::as_str))
        .or_else(|| value.pointer("/item/output").and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

fn extract_stream_kind(value: &Value) -> Option<&str> {
    value
        .get("stream")
        .and_then(Value::as_str)
        .or_else(|| value.get("streamKind").and_then(Value::as_str))
        .or_else(|| value.get("fd").and_then(Value::as_str))
}

fn extract_command(value: &Value) -> Option<&str> {
    value
        .get("command")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/exec/command").and_then(Value::as_str))
}

fn extract_path(value: &Value) -> Option<&str> {
    value
        .get("path")
        .and_then(Value::as_str)
        .or_else(|| value.get("file").and_then(Value::as_str))
        .or_else(|| value.pointer("/file/path").and_then(Value::as_str))
}

fn extract_tool_name(value: &Value) -> Option<&str> {
    value
        .get("toolName")
        .and_then(Value::as_str)
        .or_else(|| value.get("name").and_then(Value::as_str))
        .or_else(|| value.pointer("/tool/name").and_then(Value::as_str))
}

fn summarize_inline(value: &str, limit: usize) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut summary = collapsed.chars().take(limit).collect::<String>();
    if collapsed.chars().count() > limit {
        summary.push('…');
    }
    summary
}

fn summarize_activity_text(value: &str) -> String {
    summarize_inline(value, 240)
}

fn codex_text_trace_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var(CODEX_TEXT_TRACE_ENV)
            .map(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
            .unwrap_or(false)
    })
}

fn trace_string_field(value: &Value, path: &str) -> Option<String> {
    let field = if let Some(pointer) = path.strip_prefix('/') {
        value.pointer(&format!("/{pointer}"))
    } else {
        value.get(path)
    };
    field
        .and_then(Value::as_str)
        .map(|text| summarize_inline(text, 160))
}

fn trace_codex_text_event(method: &str, conversation_id: &str, params: &Value) {
    if !codex_text_trace_enabled() {
        return;
    }

    let route_hints = RouteHints::from_value(params);
    let item = params.get("item").unwrap_or(&Value::Null);
    let delta_preview = trace_string_field(params, "delta")
        .or_else(|| trace_string_field(params, "text"))
        .or_else(|| trace_string_field(params, "/item/delta"));
    let completed_text_preview = trace_string_field(item, "text")
        .or_else(|| trace_string_field(params, "/item/text"))
        .or_else(|| trace_string_field(params, "/turn/items/0/text"));
    let phase = params
        .get("phase")
        .and_then(|value| value.as_str())
        .or_else(|| item.get("phase").and_then(|value| value.as_str()));
    let item_type = item
        .get("type")
        .and_then(|value| value.as_str())
        .or_else(|| params.get("type").and_then(|value| value.as_str()));
    let item_status = item
        .get("status")
        .and_then(|value| value.as_str())
        .or_else(|| params.get("status").and_then(|value| value.as_str()));
    tracing::info!(
        target: "hubris_server::chat::codex_text_trace",
        method,
        conversation_id,
        thread_id = route_hints.thread_id.as_deref(),
        turn_id = route_hints.turn_id.as_deref(),
        item_id = route_hints.item_id.as_deref(),
        request_id = route_hints.request_id.as_deref(),
        phase,
        item_type,
        item_status,
        delta_preview = delta_preview.as_deref(),
        completed_text_preview = completed_text_preview.as_deref(),
        "codex app-server text event"
    );
}

fn is_commentary_phase(value: &Value) -> bool {
    value.get("phase").and_then(Value::as_str) == Some("commentary")
        || value.pointer("/item/phase").and_then(Value::as_str) == Some("commentary")
}

fn extract_error_message(value: &Value) -> Option<String> {
    if let Some(message) = value.as_str() {
        let message = message.trim();
        if !message.is_empty() {
            return Some(message.to_string());
        }
    }

    let message = value
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty())?;
    let details = value
        .get("additionalDetails")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|details| !details.is_empty());

    Some(match details {
        Some(details) => format!("{message}: {details}"),
        None => message.to_string(),
    })
}

fn extract_turn_text(turn: &Value) -> Option<String> {
    turn.pointer("/items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().rev().find_map(|item| {
                (item.get("type").and_then(Value::as_str) == Some("agentMessage"))
                    .then(|| item.get("text").and_then(Value::as_str))
                    .flatten()
                    .map(str::to_string)
            })
        })
}

fn thread_read_turns(value: &Value) -> Vec<Value> {
    value
        .pointer("/thread/turns")
        .or_else(|| value.get("turns"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn provider_turn_items(turn: &Value) -> Vec<Value> {
    turn.pointer("/items")
        .or_else(|| turn.get("items"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn replay_item_params(item: &Value, provider_turn_id: Option<&str>) -> Value {
    let mut params = serde_json::Map::new();
    params.insert("item".to_string(), item.clone());
    if let Some(provider_turn_id) = provider_turn_id {
        params.insert(
            "turnId".to_string(),
            Value::String(provider_turn_id.to_string()),
        );
    }
    Value::Object(params)
}

fn replay_item_status(item: &Value) -> ChatItemStatus {
    match item.get("status").and_then(Value::as_str) {
        Some("failed" | "error") => ChatItemStatus::Failed,
        Some("started") => ChatItemStatus::Started,
        Some("streaming" | "in_progress") => ChatItemStatus::Streaming,
        _ => ChatItemStatus::Completed,
    }
}

fn replay_reasoning_text(item: &Value) -> Option<String> {
    item.get("text")
        .and_then(Value::as_str)
        .or_else(|| item.get("summary").and_then(Value::as_str))
        .or_else(|| item.get("summaryText").and_then(Value::as_str))
        .map(str::to_string)
}

fn extract_thread_read_text(value: &Value) -> Option<String> {
    value
        .pointer("/thread/turns")
        .and_then(Value::as_array)
        .and_then(|turns| turns.iter().rev().find_map(extract_turn_text))
}

fn model_option_from_value(value: &Value) -> Option<ChatModelOption> {
    let supported_reasoning_efforts = value
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .filter_map(|option| {
                    Some(ChatModelReasoningEffortOption {
                        reasoning_effort: parse_reasoning_effort(
                            option.get("reasoningEffort")?.as_str()?,
                        ),
                        description: option.get("description")?.as_str()?.to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Some(ChatModelOption {
        id: value.get("id")?.as_str()?.to_string(),
        model: value.get("model")?.as_str()?.to_string(),
        display_name: value.get("displayName")?.as_str()?.to_string(),
        description: value.get("description")?.as_str()?.to_string(),
        is_default: value.get("isDefault")?.as_bool()?,
        hidden: value.get("hidden")?.as_bool()?,
        default_reasoning_effort: parse_reasoning_effort(
            value.get("defaultReasoningEffort")?.as_str()?,
        ),
        supported_reasoning_efforts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::migrate::Migrator;

    static TEST_MIGRATOR: Migrator = sqlx::migrate!("./chat-migrations");

    fn test_conversation() -> ChatConversationSummary {
        ChatConversationSummary {
            id: "chat-1".to_string(),
            session_id: "default".to_string(),
            project_id: "project-1".to_string(),
            worktree_id: "worktree-1".to_string(),
            branch_name: Some("main".to_string()),
            provider: ChatProvider::Codex,
            provider_thread_id: Some("thread-1".to_string()),
            title: DEFAULT_CHAT_TITLE.to_string(),
            created_at: 0,
            updated_at: 0,
            last_activity_at: 0,
            last_message_at: None,
            open_tab_id: None,
            archived_at: None,
            selected_model: None,
            selected_effort: None,
            selected_permission_mode: None,
            last_run_state: ChatRunStatus::Completed,
            last_error: None,
            last_reconciliation_state: ChatReconciliationStatus::NotNeeded,
            last_reconciliation_error: None,
            context_used_tokens: None,
            context_max_tokens: None,
            context_percent_used: None,
            context_updated_at: None,
            pending_request_count: 0,
            latest_pending_request_id: None,
            latest_pending_request_kind: None,
            latest_pending_request_status: None,
            has_pending_request_attention: false,
            revision: 0,
        }
    }

    async fn test_service() -> Arc<ChatService> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        TEST_MIGRATOR.run(&pool).await.unwrap();
        let tmp = tempfile::TempDir::new().unwrap();
        let settings = SettingsManager::new(tmp.path().join("settings.toml"))
            .await
            .unwrap();
        Arc::new(ChatService {
            pool,
            events: Arc::new(crate::events::EventBus::new()),
            settings: Arc::new(settings),
            app_server: Arc::new(CodexAppServerManager::new_for_tests(Arc::new(|| {
                Box::pin(async {
                    Err(ChatServiceError::new(
                        StatusCode::BAD_GATEWAY,
                        "test app-server factory should not be used",
                    ))
                })
            }))),
            runtimes: DashMap::new(),
            thread_to_conversation: DashMap::new(),
            turn_to_conversation: DashMap::new(),
            item_to_conversation: DashMap::new(),
            server_request_to_conversation: DashMap::new(),
            pending_server_responders: DashMap::new(),
            op_locks: DashMap::new(),
            stream_owner_generation: AtomicU64::new(1),
            app_event_loop_started: AtomicBool::new(false),
        })
    }

    fn route_hints(
        thread_id: Option<&str>,
        turn_id: Option<&str>,
        item_id: Option<&str>,
        request_id: Option<&str>,
    ) -> RouteHints {
        RouteHints {
            thread_id: thread_id.map(str::to_string),
            turn_id: turn_id.map(str::to_string),
            item_id: item_id.map(str::to_string),
            request_id: request_id.map(str::to_string),
        }
    }

    async fn insert_test_runtime(
        service: &Arc<ChatService>,
        conversation_id: &str,
        provider_thread_id: &str,
        active: bool,
        owner_generation: u64,
    ) -> RuntimeEntry {
        let mut conversation = test_conversation();
        conversation.id = conversation_id.to_string();
        conversation.provider_thread_id = Some(provider_thread_id.to_string());
        let runtime = RuntimeEntry {
            state: Arc::new(Mutex::new(RuntimeState::new(
                &conversation,
                "/tmp/worktree",
            ))),
        };
        {
            let mut state = runtime.state.lock().await;
            state.owner_generation = owner_generation;
            state.provider_thread_id = Some(provider_thread_id.to_string());
            state.stream_lifecycle.mark_resumed();
            state.lifecycle = if active {
                state.active_run_id = Some(format!("run-{conversation_id}"));
                ChatRuntimeLifecycle::Running
            } else {
                ChatRuntimeLifecycle::Ready
            };
        }
        service
            .runtimes
            .insert(conversation_id.to_string(), runtime.clone());
        service
            .register_provider_thread_route(conversation_id, &runtime, provider_thread_id)
            .await;
        runtime
    }

    async fn create_persisted_conversation(service: &Arc<ChatService>) -> ChatConversationSummary {
        service
            .create_conversation(ChatCreateOptions {
                session_id: "default".to_string(),
                project_id: "project-1".to_string(),
                worktree_id: "worktree-1".to_string(),
                branch_name: "main".to_string(),
            })
            .await
            .unwrap()
    }

    async fn start_test_run(
        service: &Arc<ChatService>,
        conversation: &ChatConversationSummary,
        runtime: &RuntimeEntry,
    ) -> (String, String, String, String) {
        let user_message_id = uuid::Uuid::new_v4().to_string();
        let assistant_message_id = uuid::Uuid::new_v4().to_string();
        let run_id = uuid::Uuid::new_v4().to_string();
        let turn_id = uuid::Uuid::new_v4().to_string();
        service
            .persist_run_start(
                conversation,
                &user_message_id,
                &assistant_message_id,
                &run_id,
                &turn_id,
                "hello",
            )
            .await
            .unwrap();
        {
            let mut state = runtime.state.lock().await;
            state.active_run_id = Some(run_id.clone());
            state.active_turn_id = Some(turn_id.clone());
            state.active_message_id = Some(assistant_message_id.clone());
            state.lifecycle = ChatRuntimeLifecycle::Running;
        }
        (user_message_id, assistant_message_id, run_id, turn_id)
    }

    #[test]
    fn extract_model_ignores_blank_values() {
        assert_eq!(extract_model(&json!({ "model": "" })), None);
        assert_eq!(extract_model(&json!({ "model": "   " })), None);
        assert_eq!(
            extract_model(&json!({ "model": "gpt-5.5" })),
            Some("gpt-5.5".to_string()),
        );
    }

    #[test]
    fn normalize_model_override_trims_and_drops_empty_values() {
        assert_eq!(normalize_model_override(None), None);
        assert_eq!(normalize_model_override(Some(String::new())), None);
        assert_eq!(normalize_model_override(Some("  ".to_string())), None);
        assert_eq!(
            normalize_model_override(Some("  gpt-5.5  ".to_string())),
            Some("gpt-5.5".to_string()),
        );
    }

    #[test]
    fn has_blank_model_field_detects_broken_thread_resume() {
        assert!(has_blank_model_field(&json!({ "model": "" })));
        assert!(has_blank_model_field(&json!({ "model": "  " })));
        assert!(!has_blank_model_field(&json!({ "model": "gpt-5.5" })));
        assert!(!has_blank_model_field(&json!({})));
    }

    #[tokio::test]
    async fn conversation_branch_scope_archive_and_delete_round_trip() {
        let service = test_service().await;
        let conversation = create_persisted_conversation(&service).await;
        assert_eq!(conversation.branch_name.as_deref(), Some("main"));
        assert_eq!(conversation.archived_at, None);

        let branch_chats = service
            .list_conversations(
                "project-1",
                "worktree-1",
                "main",
                "default",
                ChatConversationListScope::Branch,
                false,
            )
            .await
            .unwrap();
        assert_eq!(branch_chats.len(), 1);

        let other_branch_chats = service
            .list_conversations(
                "project-1",
                "worktree-2",
                "feature",
                "default",
                ChatConversationListScope::Branch,
                false,
            )
            .await
            .unwrap();
        assert!(other_branch_chats.is_empty());

        let archived = service
            .set_conversation_archived(&conversation.id, true)
            .await
            .unwrap();
        assert!(archived.archived_at.is_some());
        let hidden = service
            .list_conversations(
                "project-1",
                "worktree-1",
                "main",
                "default",
                ChatConversationListScope::Branch,
                false,
            )
            .await
            .unwrap();
        assert!(hidden.is_empty());
        let visible_with_archive = service
            .list_conversations(
                "project-1",
                "worktree-1",
                "main",
                "default",
                ChatConversationListScope::Branch,
                true,
            )
            .await
            .unwrap();
        assert_eq!(visible_with_archive.len(), 1);

        let unarchived = service
            .set_conversation_archived(&conversation.id, false)
            .await
            .unwrap();
        assert_eq!(unarchived.archived_at, None);

        service.delete_conversation(&conversation.id).await.unwrap();
        assert!(
            service
                .get_conversation_summary(&conversation.id)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn legacy_conversation_branch_backfills_on_open() {
        let service = test_service().await;
        let conversation = create_persisted_conversation(&service).await;
        sqlx::query("UPDATE chat_conversations SET branch_name = NULL WHERE id = ?")
            .bind(&conversation.id)
            .execute(&service.pool)
            .await
            .unwrap();

        let backfilled = service
            .backfill_conversation_branch(&conversation.id, "feature/demo")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(backfilled.branch_name.as_deref(), Some("feature/demo"));
    }

    #[tokio::test]
    async fn persist_run_start_creates_turn_and_links_messages_and_run() {
        let service = test_service().await;
        let conversation = create_persisted_conversation(&service).await;
        let user_message_id = "user-1";
        let assistant_message_id = "assistant-1";
        let run_id = "run-1";
        let turn_id = "turn-local-1";

        service
            .persist_run_start(
                &conversation,
                user_message_id,
                assistant_message_id,
                run_id,
                turn_id,
                "What changed?",
            )
            .await
            .unwrap();

        let detail = service
            .get_conversation_detail(&conversation.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(detail.turns.len(), 1);
        assert_eq!(detail.turns[0].run_id, run_id);
        assert_eq!(detail.turns[0].user_message_id, user_message_id);
        assert_eq!(detail.turns[0].assistant_message_id, assistant_message_id);
        assert_eq!(detail.messages.len(), 2);
        assert!(
            detail
                .messages
                .iter()
                .all(|message| { message.turn_id.as_deref() == Some(turn_id) })
        );
        assert_eq!(detail.latest_run.unwrap().turn_id.as_deref(), Some(turn_id));
    }

    #[tokio::test]
    async fn attach_turn_to_run_sets_provider_turn_on_turn_run_and_messages() {
        let service = test_service().await;
        let conversation = create_persisted_conversation(&service).await;
        let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
        let (_, assistant_message_id, run_id, turn_id) =
            start_test_run(&service, &conversation, &runtime).await;

        service
            .attach_turn_to_run(
                &conversation.id,
                &run_id,
                &turn_id,
                &assistant_message_id,
                Some("provider-turn-1"),
            )
            .await
            .unwrap();

        let detail = service
            .get_conversation_detail(&conversation.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            detail.turns[0].provider_turn_id.as_deref(),
            Some("provider-turn-1")
        );
        assert_eq!(
            detail.latest_run.unwrap().provider_turn_id.as_deref(),
            Some("provider-turn-1")
        );
        assert!(
            detail
                .messages
                .iter()
                .all(|message| { message.provider_turn_id.as_deref() == Some("provider-turn-1") })
        );
    }

    #[tokio::test]
    async fn agent_message_delta_creates_item_and_preserves_transcript_projection() {
        let service = test_service().await;
        let conversation = create_persisted_conversation(&service).await;
        let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
        let (_, assistant_message_id, _, turn_id) =
            start_test_run(&service, &conversation, &runtime).await;

        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "item/agentMessage/delta",
                json!({
                    "threadId": "thread-1",
                    "turnId": "provider-turn-1",
                    "itemId": "item-1",
                    "delta": "Hello"
                }),
            )
            .await
            .unwrap();

        let detail = service
            .get_conversation_detail(&conversation.id)
            .await
            .unwrap()
            .unwrap();
        let message = detail
            .messages
            .iter()
            .find(|message| message.id == assistant_message_id)
            .unwrap();
        assert_eq!(message.content_text, "Hello");
        assert_eq!(message.reasoning_text, "");
        assert_eq!(message.provider_item_id.as_deref(), Some("item-1"));
        assert_eq!(detail.items.len(), 1);
        assert_eq!(detail.items[0].kind, ChatItemKind::AgentMessage);
        assert_eq!(detail.items[0].status, ChatItemStatus::Streaming);
        assert_eq!(detail.items[0].turn_id.as_deref(), Some(turn_id.as_str()));
    }

    #[tokio::test]
    async fn commentary_agent_message_delta_inherits_item_started_phase() {
        let service = test_service().await;
        let conversation = create_persisted_conversation(&service).await;
        let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
        let (_, assistant_message_id, _, _) =
            start_test_run(&service, &conversation, &runtime).await;

        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "item/started",
                json!({
                    "threadId": "thread-1",
                    "turnId": "provider-turn-1",
                    "item": {
                        "id": "commentary-1",
                        "type": "agentMessage",
                        "phase": "commentary"
                    }
                }),
            )
            .await
            .unwrap();
        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "item/agentMessage/delta",
                json!({
                    "threadId": "thread-1",
                    "turnId": "provider-turn-1",
                    "itemId": "commentary-1",
                    "delta": "Inspecting first."
                }),
            )
            .await
            .unwrap();

        let detail = service
            .get_conversation_detail(&conversation.id)
            .await
            .unwrap()
            .unwrap();
        let message = detail
            .messages
            .iter()
            .find(|message| message.id == assistant_message_id)
            .unwrap();
        assert_eq!(message.content_text, "");
        assert_eq!(message.reasoning_text, "Inspecting first.");
        assert_eq!(detail.items.len(), 1);
        assert_eq!(detail.items[0].kind, ChatItemKind::Reasoning);
        assert_eq!(
            detail.items[0].summary.as_deref(),
            Some("Inspecting first.")
        );
        let activity = service
            .get_activity_detail(&conversation.id, &detail.items[0].id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(activity.outputs.len(), 1);
        assert_eq!(activity.outputs[0].content_text, "Inspecting first.");
    }

    #[tokio::test]
    async fn multiple_commentary_agent_messages_accumulate_reasoning() {
        let service = test_service().await;
        let conversation = create_persisted_conversation(&service).await;
        let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
        let (_, assistant_message_id, _, _) =
            start_test_run(&service, &conversation, &runtime).await;

        for (item_id, text) in [
            ("commentary-1", "Inspecting first."),
            ("commentary-2", "Checking config next."),
        ] {
            service
                .handle_provider_notification(
                    &conversation.id,
                    &runtime,
                    "item/started",
                    json!({
                        "threadId": "thread-1",
                        "turnId": "provider-turn-1",
                        "item": {
                            "id": item_id,
                            "type": "agentMessage",
                            "phase": "commentary"
                        }
                    }),
                )
                .await
                .unwrap();
            service
                .handle_provider_notification(
                    &conversation.id,
                    &runtime,
                    "item/agentMessage/delta",
                    json!({
                        "threadId": "thread-1",
                        "turnId": "provider-turn-1",
                        "itemId": item_id,
                        "delta": text
                    }),
                )
                .await
                .unwrap();
            service
                .handle_provider_notification(
                    &conversation.id,
                    &runtime,
                    "item/completed",
                    json!({
                        "threadId": "thread-1",
                        "turnId": "provider-turn-1",
                        "item": {
                            "id": item_id,
                            "type": "agentMessage",
                            "phase": "commentary",
                            "text": text
                        }
                    }),
                )
                .await
                .unwrap();
        }
        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "item/started",
                json!({
                    "threadId": "thread-1",
                    "turnId": "provider-turn-1",
                    "item": {
                        "id": "final-1",
                        "type": "agentMessage",
                        "phase": "final_answer"
                    }
                }),
            )
            .await
            .unwrap();
        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "item/agentMessage/delta",
                json!({
                    "threadId": "thread-1",
                    "turnId": "provider-turn-1",
                    "itemId": "final-1",
                    "delta": "Final answer."
                }),
            )
            .await
            .unwrap();

        let detail = service
            .get_conversation_detail(&conversation.id)
            .await
            .unwrap()
            .unwrap();
        let message = detail
            .messages
            .iter()
            .find(|message| message.id == assistant_message_id)
            .unwrap();
        assert_eq!(message.content_text, "Final answer.");
        assert_eq!(
            message.reasoning_text,
            "Inspecting first.\n\nChecking config next."
        );
        assert_eq!(
            detail
                .items
                .iter()
                .filter(|item| item.kind == ChatItemKind::Reasoning)
                .count(),
            2
        );
        let reasoning_summaries = detail
            .items
            .iter()
            .filter(|item| item.kind == ChatItemKind::Reasoning)
            .map(|item| item.summary.as_deref())
            .collect::<Vec<_>>();
        assert_eq!(
            reasoning_summaries,
            vec![Some("Inspecting first."), Some("Checking config next.")]
        );
    }

    #[tokio::test]
    async fn reasoning_delta_creates_reasoning_item_without_response_text() {
        let service = test_service().await;
        let conversation = create_persisted_conversation(&service).await;
        let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
        let (_, assistant_message_id, _, _) =
            start_test_run(&service, &conversation, &runtime).await;

        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "item/reasoning/summaryTextDelta",
                json!({
                    "threadId": "thread-1",
                    "turnId": "provider-turn-1",
                    "itemId": "reasoning-1",
                    "delta": "Thinking"
                }),
            )
            .await
            .unwrap();

        let detail = service
            .get_conversation_detail(&conversation.id)
            .await
            .unwrap()
            .unwrap();
        let message = detail
            .messages
            .iter()
            .find(|message| message.id == assistant_message_id)
            .unwrap();
        assert_eq!(message.content_text, "");
        assert_eq!(message.reasoning_text, "Thinking");
        assert_eq!(message.provider_item_id, None);
        assert_eq!(detail.items[0].kind, ChatItemKind::Reasoning);
        assert_eq!(detail.items[0].summary.as_deref(), Some("Thinking"));
    }

    #[tokio::test]
    async fn command_output_delta_creates_activity_item_and_output() {
        let service = test_service().await;
        let conversation = create_persisted_conversation(&service).await;
        let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
        let (_, assistant_message_id, _, _) =
            start_test_run(&service, &conversation, &runtime).await;

        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "item/commandExecution/outputDelta",
                json!({
                    "threadId": "thread-1",
                    "turnId": "provider-turn-1",
                    "itemId": "command-1",
                    "item": {
                        "id": "command-1",
                        "type": "commandExecution",
                        "command": "cargo test"
                    },
                    "stream": "stdout",
                    "delta": "running 1 test\n"
                }),
            )
            .await
            .unwrap();

        let detail = service
            .get_conversation_detail(&conversation.id)
            .await
            .unwrap()
            .unwrap();
        let message = detail
            .messages
            .iter()
            .find(|message| message.id == assistant_message_id)
            .unwrap();
        assert_eq!(message.content_text, "");
        assert_eq!(detail.items.len(), 1);
        assert_eq!(detail.items[0].kind, ChatItemKind::CommandExecution);
        assert_eq!(detail.items[0].title.as_deref(), Some("Run `cargo test`"));
        assert_eq!(
            detail.items[0].provider_item_id.as_deref(),
            Some("command-1")
        );

        let activity = service
            .get_activity_detail(&conversation.id, &detail.items[0].id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(activity.outputs.len(), 1);
        assert_eq!(activity.outputs[0].stream_kind, "stdout");
        assert_eq!(activity.outputs[0].content_text, "running 1 test\n");
    }

    #[tokio::test]
    async fn file_change_completion_synthesizes_activity_item() {
        let service = test_service().await;
        let conversation = create_persisted_conversation(&service).await;
        let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
        start_test_run(&service, &conversation, &runtime).await;

        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "item/completed",
                json!({
                    "threadId": "thread-1",
                    "turnId": "provider-turn-1",
                    "item": {
                        "id": "file-1",
                        "type": "fileChange",
                        "path": "src/lib.rs"
                    }
                }),
            )
            .await
            .unwrap();

        let detail = service
            .get_conversation_detail(&conversation.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(detail.items.len(), 1);
        assert_eq!(detail.items[0].kind, ChatItemKind::FileChange);
        assert_eq!(detail.items[0].status, ChatItemStatus::Completed);
        assert_eq!(detail.items[0].title.as_deref(), Some("Edit src/lib.rs"));
    }

    #[tokio::test]
    async fn item_completed_before_started_is_idempotent() {
        let service = test_service().await;
        let conversation = create_persisted_conversation(&service).await;
        let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
        start_test_run(&service, &conversation, &runtime).await;
        let params = json!({
            "threadId": "thread-1",
            "turnId": "provider-turn-1",
            "item": {
                "id": "item-1",
                "type": "agentMessage",
                "text": "Final"
            }
        });

        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "item/completed",
                params.clone(),
            )
            .await
            .unwrap();
        service
            .handle_provider_notification(&conversation.id, &runtime, "item/completed", params)
            .await
            .unwrap();

        let detail = service
            .get_conversation_detail(&conversation.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(detail.items.len(), 1);
        assert_eq!(detail.items[0].status, ChatItemStatus::Completed);
        assert_eq!(detail.messages[1].content_text, "Final");
    }

    #[tokio::test]
    async fn turn_completed_finalizes_turn_run_and_message() {
        let service = test_service().await;
        let conversation = create_persisted_conversation(&service).await;
        let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
        start_test_run(&service, &conversation, &runtime).await;

        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "turn/completed",
                json!({
                    "threadId": "thread-1",
                    "turn": {
                        "id": "provider-turn-1",
                        "status": "completed",
                        "items": [
                            {
                                "id": "item-1",
                                "type": "agentMessage",
                                "text": "Done"
                            }
                        ]
                    }
                }),
            )
            .await
            .unwrap();

        let detail = service
            .get_conversation_detail(&conversation.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(detail.turns[0].status, ChatTurnStatus::Completed);
        assert_eq!(detail.latest_run.unwrap().status, ChatRunStatus::Completed);
        assert_eq!(detail.messages[1].status, ChatMessageStatus::Completed);
        assert_eq!(detail.messages[1].content_text, "Done");
    }

    #[tokio::test]
    async fn plan_notifications_create_active_and_proposed_plans() {
        let service = test_service().await;
        let conversation = create_persisted_conversation(&service).await;
        let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
        start_test_run(&service, &conversation, &runtime).await;

        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "turn/plan/updated",
                json!({
                    "threadId": "thread-1",
                    "turnId": "provider-turn-1",
                    "steps": [
                        { "text": "Inspect state", "status": "completed" },
                        { "text": "Patch code", "status": "in_progress" }
                    ]
                }),
            )
            .await
            .unwrap();
        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "item/plan/delta",
                json!({
                    "threadId": "thread-1",
                    "turnId": "provider-turn-1",
                    "itemId": "plan-item-1",
                    "delta": "1. Inspect\n"
                }),
            )
            .await
            .unwrap();
        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "item/plan/delta",
                json!({
                    "threadId": "thread-1",
                    "turnId": "provider-turn-1",
                    "itemId": "plan-item-1",
                    "delta": "2. Patch\n"
                }),
            )
            .await
            .unwrap();
        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "item/completed",
                json!({
                    "threadId": "thread-1",
                    "turnId": "provider-turn-1",
                    "item": {
                        "id": "plan-item-1",
                        "type": "plan",
                        "text": "Final plan"
                    }
                }),
            )
            .await
            .unwrap();
        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "turn/completed",
                json!({
                    "threadId": "thread-1",
                    "turn": {
                        "id": "provider-turn-1",
                        "status": "completed",
                        "items": []
                    }
                }),
            )
            .await
            .unwrap();

        let detail = service
            .get_conversation_detail(&conversation.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(detail.plans.len(), 2);
        let active_plan = detail
            .plans
            .iter()
            .find(|plan| plan.kind == ChatPlanKind::ActiveTask)
            .unwrap();
        assert_eq!(active_plan.status, ChatPlanStatus::Completed);
        assert!(active_plan.steps_json.contains("Inspect state"));
        let proposed_plan = detail
            .plans
            .iter()
            .find(|plan| plan.kind == ChatPlanKind::ProposedPlan)
            .unwrap();
        assert_eq!(proposed_plan.status, ChatPlanStatus::Completed);
        assert_eq!(proposed_plan.content_text, "Final plan");
    }

    #[tokio::test]
    async fn diff_and_context_notifications_do_not_mutate_transcript() {
        let service = test_service().await;
        let conversation = create_persisted_conversation(&service).await;
        let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
        start_test_run(&service, &conversation, &runtime).await;

        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "turn/diff/updated",
                json!({
                    "threadId": "thread-1",
                    "turnId": "provider-turn-1",
                    "changedFileCount": 1,
                    "additions": 8,
                    "deletions": 2,
                    "files": [
                        {
                            "path": "src/lib.rs",
                            "changeType": "modified",
                            "additions": 8,
                            "deletions": 2
                        }
                    ]
                }),
            )
            .await
            .unwrap();
        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "thread/tokenUsage/updated",
                json!({
                    "threadId": "thread-1",
                    "usedTokens": 1200,
                    "maxTokens": 12000,
                    "totalProcessedTokens": 3000
                }),
            )
            .await
            .unwrap();

        let detail = service
            .get_conversation_detail(&conversation.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(detail.diff_summaries.len(), 1);
        assert_eq!(detail.diff_summaries[0].changed_file_count, 1);
        assert_eq!(detail.diff_summaries[0].files[0].path, "src/lib.rs");
        assert_eq!(
            detail.context_usage.as_ref().unwrap().percent_used,
            Some(10.0)
        );
        assert_eq!(detail.messages[1].content_text, "");
    }

    #[tokio::test]
    async fn process_loss_preserves_partial_turn_and_marks_reconciliation_pending() {
        let service = test_service().await;
        let conversation = create_persisted_conversation(&service).await;
        let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
        let (_, assistant_message_id, _, _) =
            start_test_run(&service, &conversation, &runtime).await;
        service
            .append_message_delta(&conversation.id, &assistant_message_id, "partial")
            .await
            .unwrap();

        service
            .handle_provider_closed("transport closed".to_string())
            .await
            .unwrap();

        let detail = service
            .get_conversation_detail(&conversation.id)
            .await
            .unwrap()
            .unwrap();
        let message = detail
            .messages
            .iter()
            .find(|message| message.id == assistant_message_id)
            .unwrap();
        assert_eq!(message.status, ChatMessageStatus::Streaming);
        assert_eq!(message.content_text, "partial");
        assert_eq!(detail.latest_run.unwrap().status, ChatRunStatus::Starting);
        assert_eq!(
            detail.latest_reconciliation.unwrap().status,
            ChatReconciliationStatus::Pending
        );
    }

    #[tokio::test]
    async fn thread_read_replay_finalizes_transcript_idempotently() {
        let service = test_service().await;
        let conversation = create_persisted_conversation(&service).await;
        let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
        let (_, assistant_message_id, _, _) =
            start_test_run(&service, &conversation, &runtime).await;

        let replay = json!({
            "thread": {
                "turns": [
                    {
                        "id": "provider-turn-1",
                        "status": "completed",
                        "items": [
                            {
                                "id": "provider-item-1",
                                "type": "agentMessage",
                                "status": "completed",
                                "text": "Final answer"
                            }
                        ]
                    }
                ]
            }
        });
        service
            .apply_thread_read_replay(&conversation.id, &runtime, &replay)
            .await
            .unwrap();
        service
            .apply_thread_read_replay(&conversation.id, &runtime, &replay)
            .await
            .unwrap();

        let detail = service
            .get_conversation_detail(&conversation.id)
            .await
            .unwrap()
            .unwrap();
        let message = detail
            .messages
            .iter()
            .find(|message| message.id == assistant_message_id)
            .unwrap();
        assert_eq!(message.status, ChatMessageStatus::Completed);
        assert_eq!(message.content_text, "Final answer");
        assert_eq!(detail.latest_run.unwrap().status, ChatRunStatus::Completed);
        assert_eq!(
            detail.turns[0].provider_turn_id.as_deref(),
            Some("provider-turn-1")
        );
        assert_eq!(detail.items.len(), 1);
        assert_eq!(
            detail.items[0].provider_item_id.as_deref(),
            Some("provider-item-1")
        );
    }

    #[test]
    fn extract_error_message_formats_app_server_errors() {
        assert_eq!(
            extract_error_message(&json!({
                "message": "request failed",
                "additionalDetails": "bad model"
            })),
            Some("request failed: bad model".to_string()),
        );
        assert_eq!(
            extract_error_message(&json!("plain failure")),
            Some("plain failure".to_string()),
        );
    }

    #[test]
    fn thread_start_params_include_absolute_worktree_cwd() {
        let params = build_thread_start_params(
            "/Users/me/project-worktree",
            Some("gpt-5.5"),
            Some(ChatPermissionMode::FullAccess),
        );

        assert_eq!(
            params.get("cwd").and_then(Value::as_str),
            Some("/Users/me/project-worktree"),
        );
        assert_eq!(params.get("model").and_then(Value::as_str), Some("gpt-5.5"));
        assert_eq!(
            params.get("sandbox").and_then(Value::as_str),
            Some("danger-full-access"),
        );
    }

    #[test]
    fn turn_start_params_include_absolute_worktree_cwd() {
        let mut conversation = test_conversation();
        conversation.selected_model = Some("gpt-5.5".to_string());
        conversation.selected_effort = Some(ChatReasoningEffort::High);
        let params = build_turn_start_params(
            "thread-1",
            "/Users/me/other-worktree",
            "Run tests",
            &conversation,
        );

        assert_eq!(
            params.get("cwd").and_then(Value::as_str),
            Some("/Users/me/other-worktree"),
        );
        assert_eq!(
            params.get("threadId").and_then(Value::as_str),
            Some("thread-1"),
        );
        assert_eq!(params.get("model").and_then(Value::as_str), Some("gpt-5.5"));
        assert_eq!(params.get("effort").and_then(Value::as_str), Some("high"));
    }

    #[tokio::test]
    async fn routes_notification_by_turn_id_with_multiple_active_streams() {
        let service = test_service().await;
        let runtime_a = insert_test_runtime(&service, "chat-a", "thread-a", true, 1).await;
        let runtime_b = insert_test_runtime(&service, "chat-b", "thread-b", true, 1).await;
        service
            .register_turn_route("chat-a", &runtime_a, "turn-a")
            .await;
        service
            .register_turn_route("chat-b", &runtime_b, "turn-b")
            .await;

        let (conversation_id, _) = service
            .runtime_for_provider_event(&route_hints(None, Some("turn-b"), None, None))
            .await
            .expect("turn route should resolve");

        assert_eq!(conversation_id, "chat-b");
    }

    #[tokio::test]
    async fn routes_server_request_by_item_id_and_records_pending_request() {
        let service = test_service().await;
        let runtime_a = insert_test_runtime(&service, "chat-a", "thread-a", true, 1).await;
        let _runtime_b = insert_test_runtime(&service, "chat-b", "thread-b", true, 1).await;
        service
            .register_item_route("chat-a", &runtime_a, "item-a")
            .await;

        let hints = route_hints(None, None, Some("item-a"), Some("request-a"));
        let (conversation_id, runtime) = service
            .runtime_for_provider_event(&hints)
            .await
            .expect("item route should resolve");
        service
            .register_pending_server_request(
                &conversation_id,
                &runtime,
                "item/commandExecution/requestApproval",
                &hints,
            )
            .await;

        let (conversation_id, _) = service
            .runtime_for_provider_event(&route_hints(None, None, None, Some("request-a")))
            .await
            .expect("pending request route should resolve");

        assert_eq!(conversation_id, "chat-a");
        let pending = service
            .server_request_to_conversation
            .get("request-a")
            .expect("request route should be recorded");
        assert_eq!(pending.method, "item/commandExecution/requestApproval");
        assert_eq!(pending.item_id.as_deref(), Some("item-a"));
    }

    #[tokio::test]
    async fn server_request_resolved_clears_pending_request_route() {
        let service = test_service().await;
        let runtime = insert_test_runtime(&service, "chat-a", "thread-a", true, 1).await;
        let hints = route_hints(None, Some("turn-a"), None, Some("request-a"));
        service
            .register_pending_server_request(
                "chat-a",
                &runtime,
                "item/tool/requestUserInput",
                &hints,
            )
            .await;

        service
            .handle_provider_notification(
                "chat-a",
                &runtime,
                "serverRequest/resolved",
                json!({ "requestId": "request-a" }),
            )
            .await
            .unwrap();

        assert!(
            !service
                .server_request_to_conversation
                .contains_key("request-a")
        );
    }

    #[tokio::test]
    async fn unroutable_multi_stream_event_has_no_fallback() {
        let service = test_service().await;
        insert_test_runtime(&service, "chat-a", "thread-a", true, 1).await;
        insert_test_runtime(&service, "chat-b", "thread-b", true, 1).await;

        assert!(
            service
                .runtime_for_provider_event(&RouteHints::default())
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn stale_owner_route_entries_are_ignored() {
        let service = test_service().await;
        insert_test_runtime(&service, "chat-a", "thread-a", true, 2).await;
        service.turn_to_conversation.insert(
            "turn-a".to_string(),
            RouteEntry {
                conversation_id: "chat-a".to_string(),
                owner_generation: 1,
            },
        );

        assert!(
            service
                .runtime_for_provider_event(&route_hints(None, Some("turn-a"), None, None))
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn thread_id_route_takes_precedence_over_turn_id_route() {
        let service = test_service().await;
        let runtime_a = insert_test_runtime(&service, "chat-a", "thread-a", true, 1).await;
        let runtime_b = insert_test_runtime(&service, "chat-b", "thread-b", true, 1).await;
        service
            .register_turn_route("chat-b", &runtime_b, "turn-shared")
            .await;
        service
            .register_provider_thread_route("chat-a", &runtime_a, "thread-a")
            .await;

        let (conversation_id, _) = service
            .runtime_for_provider_event(&route_hints(
                Some("thread-a"),
                Some("turn-shared"),
                None,
                None,
            ))
            .await
            .expect("thread route should win");

        assert_eq!(conversation_id, "chat-a");
    }

    #[tokio::test]
    async fn single_active_stream_fallback_still_routes_legacy_events() {
        let service = test_service().await;
        insert_test_runtime(&service, "chat-a", "thread-a", true, 1).await;
        insert_test_runtime(&service, "chat-b", "thread-b", false, 1).await;

        let (conversation_id, _) = service
            .runtime_for_provider_event(&RouteHints::default())
            .await
            .expect("single active stream should be fallback");

        assert_eq!(conversation_id, "chat-a");
    }

    struct FakeCodexConnection {
        requests: Arc<Mutex<Vec<(String, Value)>>>,
        stream_events: broadcast::Sender<CodexStreamEvent>,
    }

    impl FakeCodexConnection {
        fn new(requests: Arc<Mutex<Vec<(String, Value)>>>) -> Self {
            let (stream_events, _) = broadcast::channel(16);
            Self {
                requests,
                stream_events,
            }
        }
    }

    impl CodexAppServerConnection for FakeCodexConnection {
        fn request<'a>(
            &'a self,
            method: &'a str,
            params: Value,
        ) -> CodexAppServerFuture<'a, Result<Value, ChatServiceError>> {
            Box::pin(async move {
                self.requests
                    .lock()
                    .await
                    .push((method.to_string(), params));
                Ok(json!({}))
            })
        }

        fn respond_result<'a>(
            &'a self,
            _id: Value,
            _result: Value,
        ) -> CodexAppServerFuture<'a, Result<(), ChatServiceError>> {
            Box::pin(async { Ok(()) })
        }

        fn subscribe(&self) -> broadcast::Receiver<CodexStreamEvent> {
            self.stream_events.subscribe()
        }

        fn lifecycle_state<'a>(&'a self) -> CodexAppServerFuture<'a, AppServerProcessState> {
            Box::pin(async { AppServerProcessState::Ready })
        }
    }

    #[tokio::test]
    async fn app_server_manager_serializes_injected_startup() {
        let created = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let factory: CodexAppServerFactory = Arc::new({
            let created = created.clone();
            let requests = requests.clone();
            move || {
                let created = created.clone();
                let requests = requests.clone();
                Box::pin(async move {
                    created.fetch_add(1, Ordering::SeqCst);
                    Ok(Arc::new(FakeCodexConnection::new(requests)) as CodexAppServerConnectionRef)
                })
            }
        });
        let manager = Arc::new(CodexAppServerManager::new_for_tests(factory));

        let (models, thread) = tokio::join!(
            manager.request("model/list", json!({ "includeHidden": false })),
            manager.request("thread/start", json!({ "cwd": "/tmp/worktree" })),
        );

        assert!(models.is_ok());
        assert!(thread.is_ok());
        assert_eq!(created.load(Ordering::SeqCst), 1);

        let requests = requests.lock().await;
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().any(|(method, _)| method == "model/list"));
        assert!(requests.iter().any(|(method, params)| {
            method == "thread/start"
                && params.get("cwd").and_then(Value::as_str) == Some("/tmp/worktree")
        }));
    }
}
