use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{FromRow, Row, Sqlite, SqlitePool, Transaction};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, broadcast, oneshot};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;
use utoipa::ToSchema;

use crate::events::EventKind;
use crate::settings_manager::SettingsManager;
use crate::util::now_ms;

mod app_server;
mod lifecycle;
mod model;
mod normalize;
mod protocol;
mod runtime;
mod store;
#[cfg(test)]
mod test_support;

pub use model::*;

use app_server::*;
use normalize::*;
use runtime::*;
use store::*;

use lifecycle::{
    AppServerLifecycle, AppServerProcessState, ThreadStreamLifecycle, ThreadStreamResumeState,
};
use protocol::{ParsedLine, RouteHints};

pub const DEFAULT_CHAT_TITLE: &str = "New Chat";
const CHAT_DB_MAX_CONNECTIONS: u32 = 1;
// `connect_with` opens (and tests) the pool's first connection eagerly, bounded
// by the acquire timeout. sqlx defaults this to 30s, which parallel `cargo test`
// runs can blow through: dozens of test binaries each build a full `AppState`,
// starving the CPU while establishing this connection and surfacing a spurious
// "pool timed out" at construction. A larger ceiling has no effect on the happy
// path (connections open in milliseconds) but removes the flake.
const CHAT_DB_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(60);
static CHAT_DB_MIGRATOR: Migrator = sqlx::migrate!("./chat-migrations");
const MAX_INACTIVE_THREAD_STREAMS: usize = 4;
const UNSUBSCRIBE_RETRY_DELAY: Duration = Duration::from_secs(15);
const STREAMING_SNAPSHOT_INTERVAL: Duration = Duration::from_millis(250);
const CODEX_TEXT_TRACE_ENV: &str = "HUBRIS_CODEX_TEXT_TRACE";

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

pub fn clamp_chat_idle_timeout_minutes(value: u32) -> u32 {
    value.max(1)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChatErrorKind {
    BadRequest,
    NotFound,
    Conflict,
    Internal,
    Upstream,
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct ChatServiceError {
    pub(crate) kind: ChatErrorKind,
    pub message: String,
}

impl ChatServiceError {
    pub(crate) fn new(kind: ChatErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl From<sqlx::Error> for ChatServiceError {
    fn from(value: sqlx::Error) -> Self {
        Self::new(
            ChatErrorKind::Internal,
            format!("chat database error: {value}"),
        )
    }
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
    app_event_loop: Mutex<Option<JoinHandle<()>>>,
    cancellation_token: CancellationToken,
}
