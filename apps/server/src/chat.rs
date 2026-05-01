use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::http::StatusCode;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{FromRow, Row, SqlitePool};
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
const DEFAULT_IDLE_TIMEOUT_MINUTES: u32 = 5;
const CHAT_DB_MAX_CONNECTIONS: u32 = 1;
const MAX_INACTIVE_THREAD_STREAMS: usize = 4;
const UNSUBSCRIBE_RETRY_DELAY: Duration = Duration::from_secs(15);

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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatModelReasoningEffortOption {
    pub reasoning_effort: ChatReasoningEffort,
    pub description: String,
}

/// One selectable Codex model exposed by app-server.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatConversationSummary {
    pub id: String,
    pub session_id: String,
    pub project_id: String,
    pub worktree_id: String,
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
    pub selected_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_effort: Option<ChatReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_permission_mode: Option<ChatPermissionMode>,
    pub last_run_state: ChatRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[ts(type = "number")]
    pub revision: u64,
}

/// Persisted transcript message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub conversation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_turn_id: Option<String>,
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatRun {
    pub id: String,
    pub conversation_id: String,
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

/// Full chat detail payload used to hydrate an open chat tab.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatConversationDetail {
    pub conversation: ChatConversationSummary,
    pub messages: Vec<ChatMessage>,
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
}

/// Chat settings owned by the backend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatSettings {
    pub idle_timeout_minutes: u32,
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
    active_message_id: Option<String>,
    active_error: Option<String>,
    lifecycle: ChatRuntimeLifecycle,
    active_reasoning_summary_index: Option<u64>,
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
            active_message_id: None,
            active_error: None,
            lifecycle: ChatRuntimeLifecycle::Starting,
            active_reasoning_summary_index: None,
            stream_lifecycle,
            owner_generation: 0,
            idle_generation: 0,
            inactive_deadline_at: None,
            last_error: None,
        }
    }
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
    provider: String,
    provider_thread_id: Option<String>,
    title: String,
    created_at_ms: i64,
    updated_at_ms: i64,
    last_activity_at_ms: i64,
    last_message_at_ms: Option<i64>,
    open_tab_id: Option<String>,
    selected_model: Option<String>,
    selected_effort: Option<String>,
    selected_permission_mode: Option<String>,
    last_run_state: String,
    last_error: Option<String>,
    revision: i64,
}

#[derive(Debug, FromRow)]
struct MessageRow {
    id: String,
    conversation_id: String,
    provider_turn_id: Option<String>,
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
    provider_turn_id: Option<String>,
    status: String,
    started_at_ms: i64,
    finished_at_ms: Option<i64>,
    error_message: Option<String>,
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
    op_locks: DashMap<String, Arc<Mutex<()>>>,
    stream_owner_generation: AtomicU64,
    app_event_loop_started: AtomicBool,
}

impl ChatService {
    /// Open the shared state database and prepare chat services.
    pub async fn new(
        db_path: &Path,
        events: Arc<crate::events::EventBus>,
        settings: Arc<SettingsManager>,
    ) -> std::io::Result<Self> {
        let options = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(CHAT_DB_MAX_CONNECTIONS)
            .connect_with(options)
            .await
            .map_err(std::io::Error::other)?;
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
                id, session_id, project_id, worktree_id, provider,
                title, created_at_ms, updated_at_ms, last_activity_at_ms,
                last_run_state, revision
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ",
        )
        .bind(&id)
        .bind(&options.session_id)
        .bind(&options.project_id)
        .bind(&options.worktree_id)
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
                id, session_id, project_id, worktree_id, provider,
                provider_thread_id, title, created_at_ms, updated_at_ms,
                last_activity_at_ms, last_message_at_ms, open_tab_id,
                selected_model, selected_effort, selected_permission_mode,
                last_run_state, last_error, revision
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
        session_id: &str,
    ) -> Result<Vec<ChatConversationSummary>, ChatServiceError> {
        let rows = sqlx::query_as::<_, ConversationRow>(
            "
            SELECT
                id, session_id, project_id, worktree_id, provider,
                provider_thread_id, title, created_at_ms, updated_at_ms,
                last_activity_at_ms, last_message_at_ms, open_tab_id,
                selected_model, selected_effort, selected_permission_mode,
                last_run_state, last_error, revision
            FROM chat_conversations
            WHERE project_id = ? AND worktree_id = ? AND session_id = ?
            ORDER BY updated_at_ms DESC, created_at_ms DESC, id DESC
            ",
        )
        .bind(project_id)
        .bind(worktree_id)
        .bind(session_id)
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
                id, session_id, project_id, worktree_id, provider,
                provider_thread_id, title, created_at_ms, updated_at_ms,
                last_activity_at_ms, last_message_at_ms, open_tab_id,
                selected_model, selected_effort, selected_permission_mode,
                last_run_state, last_error, revision
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
                id, conversation_id, provider_turn_id, role, status,
                content_text, reasoning_text, sequence, created_at_ms,
                updated_at_ms
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
                id, conversation_id, provider_turn_id, status,
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

        Ok(Some(ChatConversationDetail {
            conversation,
            messages: message_rows.into_iter().map(message_from_row).collect(),
            latest_run: latest_run.map(run_from_row),
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
        let user_message_id = uuid::Uuid::new_v4().to_string();
        let assistant_message_id = uuid::Uuid::new_v4().to_string();
        let run_id = uuid::Uuid::new_v4().to_string();

        let (next_sequence, now) = self
            .persist_run_start(
                &conversation,
                &user_message_id,
                &assistant_message_id,
                &run_id,
                &text,
            )
            .await?;

        let runtime = self
            .ensure_runtime(conversation_id, &conversation, worktree_path)
            .await?;
        {
            let mut state = runtime.state.lock().await;
            state.active_run_id = Some(run_id.clone());
            state.active_message_id = Some(assistant_message_id.clone());
            state.lifecycle = ChatRuntimeLifecycle::Running;
            state.active_reasoning_summary_index = None;
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
            &assistant_message_id,
            provider_turn_id.as_deref(),
            next_sequence,
            now,
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
                                    &conversation_id,
                                    &runtime,
                                    &method,
                                    params,
                                )
                                .await
                            {
                                Ok(result) => service.app_server.respond_result(id, result).await,
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
                            tracing::warn!(method, "unroutable codex app-server notification");
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
    }

    fn clear_pending_server_requests_for_conversation(&self, conversation_id: &str) {
        let request_ids = self
            .server_request_to_conversation
            .iter()
            .filter_map(|entry| {
                (entry.value().route.conversation_id == conversation_id)
                    .then(|| entry.key().clone())
            })
            .collect::<Vec<_>>();
        for request_id in request_ids {
            self.server_request_to_conversation.remove(&request_id);
        }
    }

    fn clear_route_indexes(&self) {
        self.thread_to_conversation.clear();
        self.turn_to_conversation.clear();
        self.item_to_conversation.clear();
        self.server_request_to_conversation.clear();
    }

    async fn handle_provider_request(
        self: &Arc<Self>,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        method: &str,
        _params: Value,
    ) -> Result<Value, ChatServiceError> {
        let error_message = match method {
            "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/tool/requestUserInput" => {
                format!("{method} is not supported in Hubris chat yet")
            }
            _ => format!("unsupported codex app-server request: {method}"),
        };

        {
            let mut state = runtime.state.lock().await;
            state.active_error = Some(error_message.clone());
            state.last_error = Some(error_message.clone());
        }
        self.emit_thread_stream_status(
            conversation_id,
            &runtime.state,
            Some(error_message.clone()),
        )
        .await;
        tracing::warn!(conversation_id, method, "{error_message}");

        Ok(json!({ "decision": "decline" }))
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
                    self.clear_pending_server_request(request_id);
                }
            }
            "item/reasoning/summaryTextDelta" => {
                let delta = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if delta.is_empty() {
                    return Ok(());
                }
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
                let delta = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if delta.is_empty() {
                    return Ok(());
                }
                let (message_id, session_id) = {
                    let state = runtime.state.lock().await;
                    (state.active_message_id.clone(), state.session_id.clone())
                };
                let Some(message_id) = message_id else {
                    return Ok(());
                };
                if is_commentary_phase(&params) {
                    let Some(message) = self
                        .append_message_reasoning_delta(conversation_id, &message_id, &delta)
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
            "item/completed"
                if params
                    .get("item")
                    .and_then(|item| item.get("type"))
                    .and_then(Value::as_str)
                    == Some("agentMessage") =>
            {
                let item = params.get("item").cloned().unwrap_or(Value::Null);
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    let message_id = { runtime.state.lock().await.active_message_id.clone() };
                    if let Some(message_id) = message_id {
                        if is_commentary_phase(&item) {
                            let message = self
                                .replace_message_reasoning(
                                    conversation_id,
                                    &message_id,
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
                let status = params
                    .get("turn")
                    .and_then(|turn| turn.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                let (run_id, message_id, session_id, generation, active_error) = {
                    let mut state = runtime.state.lock().await;
                    state.lifecycle = ChatRuntimeLifecycle::Ready;
                    state.active_reasoning_summary_index = None;
                    state.idle_generation = state.idle_generation.saturating_add(1);
                    let generation = state.idle_generation;
                    let active_error = state.active_error.take();
                    (
                        state.active_run_id.take(),
                        state.active_message_id.take(),
                        state.session_id.clone(),
                        generation,
                        active_error,
                    )
                };
                let mut run_status = parse_turn_status(status);
                if let Some(run_id) = run_id {
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
                self.clear_pending_server_requests_for_conversation(conversation_id);
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
            let (run_id, message_id, session_id) = {
                let mut state = runtime.state.lock().await;
                state.lifecycle = ChatRuntimeLifecycle::Failed;
                state.stream_lifecycle.mark_process_lost();
                state.active_reasoning_summary_index = None;
                state.inactive_deadline_at = None;
                state.last_error = Some(reason.clone());
                (
                    state.active_run_id.take(),
                    state.active_message_id.take(),
                    state.session_id.clone(),
                )
            };
            if let Some(message_id) = message_id {
                self.finalize_assistant_message(
                    &conversation_id,
                    &message_id,
                    "",
                    ChatMessageStatus::Failed,
                )
                .await?;
            }
            if let Some(run_id) = run_id {
                let run = self
                    .finalize_run(
                        &conversation_id,
                        &run_id,
                        ChatRunStatus::Failed,
                        Some(reason.clone()),
                    )
                    .await?;
                self.events.emit(EventKind::ChatRunUpdated {
                    session_id: session_id.clone(),
                    conversation_id: conversation_id.clone(),
                    run,
                });
                let _ = self.emit_conversation_updated(&conversation_id).await?;
            }
            self.emit_thread_stream_status(&conversation_id, &runtime.state, Some(reason.clone()))
                .await;
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
                id, conversation_id, provider_turn_id, status,
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
        let Some(run) = latest else {
            return Ok(());
        };
        let status = parse_run_status(&run.status);
        if matches!(
            status,
            ChatRunStatus::Completed | ChatRunStatus::Interrupted | ChatRunStatus::Failed
        ) {
            return Ok(());
        }
        let provider_thread_id = runtime.state.lock().await.provider_thread_id.clone();
        let Some(provider_thread_id) = provider_thread_id else {
            self.finalize_run(
                conversation_id,
                &run.id,
                ChatRunStatus::Interrupted,
                Some("chat runtime restarted before turn completed".to_string()),
            )
            .await?;
            return Ok(());
        };
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
        if let Ok(result) = result
            && let Some(text) = extract_thread_read_text(&result)
        {
            if let Some(message_id) = self.latest_assistant_message_id(conversation_id).await? {
                self.finalize_assistant_message(
                    conversation_id,
                    &message_id,
                    &text,
                    ChatMessageStatus::Completed,
                )
                .await?;
            }
            self.finalize_run(conversation_id, &run.id, ChatRunStatus::Completed, None)
                .await?;
            let _ = self.emit_conversation_updated(conversation_id).await?;
            return Ok(());
        }
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
            Some("chat runtime restarted before turn completed".to_string()),
        )
        .await?;
        let _ = self.emit_conversation_updated(conversation_id).await?;
        Ok(())
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
                id, conversation_id, role, status, content_text,
                reasoning_text, sequence, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
        )
        .bind(user_message_id)
        .bind(&conversation.id)
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
                id, conversation_id, role, status, content_text,
                reasoning_text, sequence, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
        )
        .bind(assistant_message_id)
        .bind(&conversation.id)
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
                id, conversation_id, status, started_at_ms
            ) VALUES (?, ?, ?, ?)
            ",
        )
        .bind(run_id)
        .bind(&conversation.id)
        .bind(ChatRunStatus::Starting.as_str())
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
                revision = revision + 1
            WHERE id = ?
            ",
        )
        .bind(&title)
        .bind(now)
        .bind(now)
        .bind(now)
        .bind(ChatRunStatus::Starting.as_str())
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
        }
        Ok((next_sequence + 1, now))
    }

    async fn attach_turn_to_run(
        &self,
        conversation_id: &str,
        run_id: &str,
        assistant_message_id: &str,
        provider_turn_id: Option<&str>,
        _sequence: u32,
        _started_at: i64,
    ) -> Result<(), ChatServiceError> {
        let now = now_ms() as i64;
        sqlx::query(
            "
            UPDATE chat_messages
            SET provider_turn_id = ?, updated_at_ms = ?
            WHERE id = ?
            ",
        )
        .bind(provider_turn_id)
        .bind(now)
        .bind(assistant_message_id)
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
        let _ = self.emit_conversation_updated(conversation_id).await?;
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
                id, conversation_id, provider_turn_id, status,
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
                id, conversation_id, provider_turn_id, role, status,
                content_text, reasoning_text, sequence, created_at_ms,
                updated_at_ms
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

    fn operation_lock(&self, conversation_id: &str) -> Arc<Mutex<()>> {
        self.op_locks
            .entry(conversation_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

fn conversation_from_row(row: ConversationRow) -> ChatConversationSummary {
    ChatConversationSummary {
        id: row.id,
        session_id: row.session_id,
        project_id: row.project_id,
        worktree_id: row.worktree_id,
        provider: parse_provider(&row.provider),
        provider_thread_id: row.provider_thread_id,
        title: row.title,
        created_at: row.created_at_ms.max(0) as u64,
        updated_at: row.updated_at_ms.max(0) as u64,
        last_activity_at: row.last_activity_at_ms.max(0) as u64,
        last_message_at: row.last_message_at_ms.map(|value| value.max(0) as u64),
        open_tab_id: row.open_tab_id,
        selected_model: normalize_model_override(row.selected_model),
        selected_effort: row.selected_effort.as_deref().map(parse_reasoning_effort),
        selected_permission_mode: row
            .selected_permission_mode
            .as_deref()
            .and_then(parse_permission_mode),
        last_run_state: parse_run_status(&row.last_run_state),
        last_error: row.last_error,
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

fn message_from_row(row: MessageRow) -> ChatMessage {
    ChatMessage {
        id: row.id,
        conversation_id: row.conversation_id,
        provider_turn_id: row.provider_turn_id,
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
        provider_turn_id: row.provider_turn_id,
        status: parse_run_status(&row.status),
        started_at: row.started_at_ms.max(0) as u64,
        finished_at: row.finished_at_ms.map(|value| value.max(0) as u64),
        error_message: row.error_message,
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

    fn test_conversation() -> ChatConversationSummary {
        ChatConversationSummary {
            id: "chat-1".to_string(),
            session_id: "default".to_string(),
            project_id: "project-1".to_string(),
            worktree_id: "worktree-1".to_string(),
            provider: ChatProvider::Codex,
            provider_thread_id: Some("thread-1".to_string()),
            title: DEFAULT_CHAT_TITLE.to_string(),
            created_at: 0,
            updated_at: 0,
            last_activity_at: 0,
            last_message_at: None,
            open_tab_id: None,
            selected_model: None,
            selected_effort: None,
            selected_permission_mode: None,
            last_run_state: ChatRunStatus::Completed,
            last_error: None,
            revision: 0,
        }
    }

    async fn test_service() -> Arc<ChatService> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
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
