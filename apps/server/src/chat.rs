use std::collections::HashMap;
use std::fmt;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
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

pub const DEFAULT_CHAT_TITLE: &str = "New Chat";
const DEFAULT_IDLE_TIMEOUT_MINUTES: u32 = 5;
const CHAT_DB_MAX_CONNECTIONS: u32 = 1;

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
    client: Arc<CodexAppServerClient>,
    state: Arc<Mutex<RuntimeState>>,
}

#[derive(Debug, Clone)]
struct RuntimeState {
    session_id: String,
    project_id: String,
    worktree_id: String,
    provider_thread_id: Option<String>,
    active_run_id: Option<String>,
    active_message_id: Option<String>,
    lifecycle: ChatRuntimeLifecycle,
    idle_generation: u64,
    shutting_down: bool,
}

impl RuntimeState {
    fn new(conversation: &ChatConversationSummary) -> Self {
        Self {
            session_id: conversation.session_id.clone(),
            project_id: conversation.project_id.clone(),
            worktree_id: conversation.worktree_id.clone(),
            provider_thread_id: conversation.provider_thread_id.clone(),
            active_run_id: None,
            active_message_id: None,
            lifecycle: ChatRuntimeLifecycle::Starting,
            idle_generation: 0,
            shutting_down: false,
        }
    }
}

#[derive(Debug, Clone)]
enum CodexStreamEvent {
    Notification { method: String, params: Value },
    Closed { reason: String },
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
}

impl CodexAppServerClient {
    async fn spawn() -> Result<Arc<Self>, ChatServiceError> {
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
        });

        Self::spawn_stdout_reader(client.clone(), stdout);
        Self::spawn_stderr_reader(stderr);
        client.initialize().await?;
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

                        let value: Value = match serde_json::from_str(&line) {
                            Ok(value) => value,
                            Err(error) => {
                                tracing::warn!("invalid codex app-server json: {error}");
                                continue;
                            }
                        };

                        if let Some(id) = value.get("id").and_then(Value::as_u64) {
                            let mut pending = client.pending.lock().await;
                            if let Some(reply) = pending.remove(&id) {
                                let result = if let Some(error) = value.get("error") {
                                    Err(ChatServiceError::new(
                                        StatusCode::BAD_GATEWAY,
                                        error
                                            .get("message")
                                            .and_then(Value::as_str)
                                            .unwrap_or("codex app-server request failed"),
                                    ))
                                } else {
                                    Ok(value.get("result").cloned().unwrap_or(Value::Null))
                                };
                                let _ = reply.send(result);
                            }
                            continue;
                        }

                        let Some(method) = value.get("method").and_then(Value::as_str) else {
                            continue;
                        };
                        let params = value.get("params").cloned().unwrap_or(Value::Null);
                        let _ = client.stream_events.send(CodexStreamEvent::Notification {
                            method: method.to_string(),
                            params,
                        });
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
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
        let _ = child.wait().await;
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
    runtimes: DashMap<String, RuntimeEntry>,
    op_locks: DashMap<String, Arc<Mutex<()>>>,
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
            runtimes: DashMap::new(),
            op_locks: DashMap::new(),
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
                content_text, sequence, created_at_ms, updated_at_ms
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
        }
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
                last_error: None,
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
            state.shutting_down = false;
            state.idle_generation = state.idle_generation.saturating_add(1);
        }
        self.emit_runtime_status(conversation_id, &runtime.state, None)
            .await;

        let turn_response = runtime
            .client
            .request(
                "turn/start",
                json!({
                    "threadId": runtime
                        .state
                        .lock()
                        .await
                        .provider_thread_id
                        .clone()
                        .ok_or_else(|| ChatServiceError::new(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "chat runtime missing thread id",
                        ))?,
                    "input": [
                        {
                            "type": "text",
                            "text": text,
                        }
                    ]
                }),
            )
            .await?;
        let provider_turn_id = extract_turn_id(&turn_response);
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
        runtime
            .client
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
        if let Some(existing) = self.runtimes.get(conversation_id) {
            let runtime = existing.clone();
            {
                let mut state = runtime.state.lock().await;
                state.idle_generation = state.idle_generation.saturating_add(1);
                state.shutting_down = false;
            }
            return Ok(runtime);
        }

        let client = CodexAppServerClient::spawn().await?;
        let runtime_state = Arc::new(Mutex::new(RuntimeState::new(conversation)));
        let runtime = RuntimeEntry {
            client: client.clone(),
            state: runtime_state.clone(),
        };
        self.runtimes
            .insert(conversation_id.to_string(), runtime.clone());
        self.spawn_provider_event_loop(conversation_id.to_string(), runtime.clone());

        let provider_thread_id = if let Some(provider_thread_id) = &conversation.provider_thread_id
        {
            let result = client
                .request(
                    "thread/resume",
                    json!({
                        "threadId": provider_thread_id,
                    }),
                )
                .await?;
            extract_thread_id(&result).unwrap_or_else(|| provider_thread_id.clone())
        } else {
            let result = client
                .request(
                    "thread/start",
                    json!({
                        "cwd": worktree_path,
                    }),
                )
                .await?;
            extract_thread_id(&result).ok_or_else(|| {
                ChatServiceError::new(
                    StatusCode::BAD_GATEWAY,
                    "codex app-server did not return a thread id",
                )
            })?
        };

        {
            let mut state = runtime.state.lock().await;
            state.provider_thread_id = Some(provider_thread_id.clone());
            state.lifecycle = ChatRuntimeLifecycle::Ready;
            state.shutting_down = false;
            state.idle_generation = state.idle_generation.saturating_add(1);
        }

        self.persist_provider_thread_id(conversation_id, &provider_thread_id)
            .await?;
        self.emit_runtime_status(conversation_id, &runtime.state, None)
            .await;
        self.reconcile_inflight_run_if_needed(conversation_id, &runtime, worktree_path)
            .await?;
        Ok(runtime)
    }

    fn spawn_provider_event_loop(self: &Arc<Self>, conversation_id: String, runtime: RuntimeEntry) {
        let service = self.clone();
        tokio::spawn(async move {
            let mut rx = runtime.client.subscribe();
            loop {
                match rx.recv().await {
                    Ok(CodexStreamEvent::Notification { method, params }) => {
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
                        let _ = service
                            .handle_provider_closed(&conversation_id, &runtime, reason)
                            .await;
                        break;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    async fn handle_provider_notification(
        self: &Arc<Self>,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        method: &str,
        params: Value,
    ) -> Result<(), ChatServiceError> {
        match method {
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
            "turn/completed" => {
                let status = params
                    .get("turn")
                    .and_then(|turn| turn.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                let (run_id, message_id, session_id, generation) = {
                    let mut state = runtime.state.lock().await;
                    state.lifecycle = ChatRuntimeLifecycle::Ready;
                    state.idle_generation = state.idle_generation.saturating_add(1);
                    let generation = state.idle_generation;
                    (
                        state.active_run_id.take(),
                        state.active_message_id.take(),
                        state.session_id.clone(),
                        generation,
                    )
                };
                let run_status = parse_turn_status(status);
                if let Some(run_id) = run_id {
                    let final_text = params
                        .get("turn")
                        .and_then(extract_turn_text)
                        .unwrap_or_default();
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
                        .finalize_run(conversation_id, &run_id, run_status, None)
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
                self.emit_runtime_status(conversation_id, &runtime.state, None)
                    .await;
                self.schedule_idle_shutdown(conversation_id.to_string(), generation);
            }
            _ => {}
        }
        Ok(())
    }

    async fn handle_provider_closed(
        self: &Arc<Self>,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        reason: String,
    ) -> Result<(), ChatServiceError> {
        let (run_id, message_id, session_id, was_shutting_down) = {
            let mut state = runtime.state.lock().await;
            let session_id = state.session_id.clone();
            let was_shutting_down = state.shutting_down;
            state.lifecycle = if was_shutting_down {
                ChatRuntimeLifecycle::Stopped
            } else {
                ChatRuntimeLifecycle::Failed
            };
            (
                state.active_run_id.take(),
                state.active_message_id.take(),
                session_id,
                was_shutting_down,
            )
        };
        if !was_shutting_down {
            if let Some(message_id) = message_id {
                self.finalize_assistant_message(
                    conversation_id,
                    &message_id,
                    "",
                    ChatMessageStatus::Failed,
                )
                .await?;
            }
            if let Some(run_id) = run_id {
                let run = self
                    .finalize_run(
                        conversation_id,
                        &run_id,
                        ChatRunStatus::Failed,
                        Some(reason.clone()),
                    )
                    .await?;
                self.events.emit(EventKind::ChatRunUpdated {
                    session_id: session_id.clone(),
                    conversation_id: conversation_id.to_string(),
                    run,
                });
                let _ = self.emit_conversation_updated(conversation_id).await?;
            }
        }
        self.runtimes.remove(conversation_id);
        self.events.emit(EventKind::ChatRuntimeUpdated {
            session_id,
            runtime: ChatRuntimeStatus {
                conversation_id: conversation_id.to_string(),
                session_id: runtime.state.lock().await.session_id.clone(),
                project_id: runtime.state.lock().await.project_id.clone(),
                worktree_id: runtime.state.lock().await.worktree_id.clone(),
                lifecycle: if was_shutting_down {
                    ChatRuntimeLifecycle::Stopped
                } else {
                    ChatRuntimeLifecycle::Failed
                },
                active_run_id: None,
                active_message_id: None,
                provider_thread_id: runtime.state.lock().await.provider_thread_id.clone(),
                last_error: (!was_shutting_down).then_some(reason),
                updated_at: now_ms(),
            },
        });
        Ok(())
    }

    fn schedule_idle_shutdown(self: &Arc<Self>, conversation_id: String, generation: u64) {
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
            tokio::time::sleep(timeout).await;
            let should_stop = if let Some(runtime) = service.runtimes.get(&conversation_id) {
                let state = runtime.state.lock().await;
                state.active_run_id.is_none()
                    && !state.shutting_down
                    && state.idle_generation == generation
            } else {
                false
            };
            if should_stop {
                let _ = service.stop_runtime(&conversation_id).await;
            }
        });
    }

    async fn stop_runtime(&self, conversation_id: &str) -> Result<(), ChatServiceError> {
        let Some(runtime) = self
            .runtimes
            .get(conversation_id)
            .map(|entry| entry.clone())
        else {
            return Ok(());
        };
        {
            let mut state = runtime.state.lock().await;
            state.lifecycle = ChatRuntimeLifecycle::Stopping;
            state.shutting_down = true;
        }
        self.emit_runtime_status(conversation_id, &runtime.state, None)
            .await;
        runtime.client.shutdown().await;
        Ok(())
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
        let result = runtime
            .client
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
                sequence, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ",
        )
        .bind(user_message_id)
        .bind(&conversation.id)
        .bind(ChatMessageRole::User.as_str())
        .bind(ChatMessageStatus::Completed.as_str())
        .bind(text)
        .bind(i64::from(next_sequence))
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "
            INSERT INTO chat_messages (
                id, conversation_id, role, status, content_text,
                sequence, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ",
        )
        .bind(assistant_message_id)
        .bind(&conversation.id)
        .bind(ChatMessageRole::Assistant.as_str())
        .bind(ChatMessageStatus::Streaming.as_str())
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
                content_text, sequence, created_at_ms, updated_at_ms
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

    async fn emit_runtime_status(
        &self,
        conversation_id: &str,
        runtime_state: &Arc<Mutex<RuntimeState>>,
        last_error: Option<String>,
    ) {
        let state = runtime_state.lock().await.clone();
        self.events.emit(EventKind::ChatRuntimeUpdated {
            session_id: state.session_id.clone(),
            runtime: ChatRuntimeStatus {
                conversation_id: conversation_id.to_string(),
                session_id: state.session_id,
                project_id: state.project_id,
                worktree_id: state.worktree_id,
                lifecycle: state.lifecycle,
                active_run_id: state.active_run_id,
                active_message_id: state.active_message_id,
                provider_thread_id: state.provider_thread_id,
                last_error,
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
        last_run_state: parse_run_status(&row.last_run_state),
        last_error: row.last_error,
        revision: row.revision.max(0) as u64,
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
