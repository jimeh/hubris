use super::*;

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
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

        let copy_result = async {
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

        match copy_result {
            Ok(()) => {
                sqlx::query("COMMIT").execute(&mut *conn).await?;
                Ok(())
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                Err(error)
            }
        }
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
        cancellation_token: CancellationToken,
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
            .acquire_timeout(CHAT_DB_ACQUIRE_TIMEOUT)
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
            app_event_loop: Mutex::new(None),
            cancellation_token,
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
                ChatErrorKind::Internal,
                "created conversation missing from database",
            )
        })?;
        self.events.emit(EventKind::ChatConversationCreated {
            session_id: conversation.session_id.clone(),
            conversation,
        });
        self.get_conversation_summary(&id).await?.ok_or_else(|| {
            ChatServiceError::new(
                ChatErrorKind::Internal,
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
            .ok_or_else(|| ChatServiceError::new(ChatErrorKind::NotFound, "chat not found"))?;
        if archived && self.conversation_has_active_work(conversation_id).await? {
            return Err(ChatServiceError::new(
                ChatErrorKind::Conflict,
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
            .ok_or_else(|| ChatServiceError::new(ChatErrorKind::NotFound, "chat not found"))
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
            .ok_or_else(|| ChatServiceError::new(ChatErrorKind::NotFound, "chat not found"))?;
        if self.conversation_has_active_work(conversation_id).await? {
            return Err(ChatServiceError::new(
                ChatErrorKind::Conflict,
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
            .ok_or_else(|| ChatServiceError::new(ChatErrorKind::NotFound, "chat not found"))?;
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
            .ok_or_else(|| ChatServiceError::new(ChatErrorKind::NotFound, "chat not found"))
    }

    pub(super) async fn persist_provider_request(
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
                    ChatErrorKind::Internal,
                    "pending request missing after insert",
                )
            })
    }

    pub(super) async fn get_pending_request_by_id(
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

    pub(super) async fn update_pending_request_terminal(
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

    pub(super) async fn mark_pending_requests_stale_for_conversation(
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

    pub(super) async fn reconcile_provider_request_resolved(
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

    pub(super) async fn reconcile_inflight_run_if_needed(
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

    pub(super) async fn mark_reconciliation_pending(
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
                    ChatErrorKind::Internal,
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
        let reconciliation = self
            .latest_reconciliation(conversation_id)
            .await?
            .ok_or_else(|| {
                ChatServiceError::new(
                    ChatErrorKind::Internal,
                    "reconciliation row missing after marking it running",
                )
            })?;
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

    pub(super) async fn persist_provider_thread_id(
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

    pub(super) async fn persist_thread_preferences(
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

    pub(super) async fn persist_run_start(
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

    pub(super) async fn attach_turn_to_run(
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

    pub(super) async fn append_message_delta(
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

    pub(super) async fn append_message_reasoning_delta(
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

    pub(super) async fn replace_message_content(
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
                    ChatErrorKind::Internal,
                    "chat message missing after reasoning update",
                )
            })
    }

    pub(super) async fn finalize_assistant_message(
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

    pub(super) async fn finalize_run(
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
                ChatErrorKind::Internal,
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

    pub(super) async fn upsert_chat_item(
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
            self.emit_item_snapshot_if_due(conversation_id, runtime, session_id, item)
                .await;
        }
        Ok(item)
    }

    async fn emit_item_snapshot_if_due(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        session_id: String,
        item: ChatItem,
    ) {
        if !runtime.state.lock().await.should_emit_item_snapshot(&item) {
            return;
        }
        if item.kind.is_activity() {
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

    pub(super) async fn append_activity_output(
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
        self.emit_item_snapshot_if_due(conversation_id, runtime, session_id, updated_item)
            .await;
        Ok(())
    }

    pub(super) async fn append_reasoning_item_delta(
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
        self.emit_item_snapshot_if_due(conversation_id, runtime, session_id, updated_item.clone())
            .await;
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

    pub(super) async fn upsert_active_plan(
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

    pub(super) async fn append_proposed_plan_delta(
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

    pub(super) async fn finalize_proposed_plan_for_item(
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

    pub(super) async fn finalize_streaming_plans_for_turn(
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

    pub(super) async fn upsert_diff_summary(
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

    pub(super) async fn upsert_context_usage(
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

    pub(super) async fn finalize_turn(
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
                    ChatErrorKind::Internal,
                    "chat turn missing after finalization",
                )
            })
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

pub(super) fn pending_request_kind_for_method(method: &str) -> ChatPendingRequestKind {
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

pub(super) fn provider_response_for_pending_request(
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
                            ChatErrorKind::BadRequest,
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
                            ChatErrorKind::BadRequest,
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
                    ChatErrorKind::BadRequest,
                    "submit is only valid for structured input requests",
                ));
            }
        }),
    }
}

pub(super) async fn request_session_id(
    service: &ChatService,
    conversation_id: &str,
) -> Result<String, ChatServiceError> {
    service
        .get_conversation_summary(conversation_id)
        .await?
        .map(|summary| summary.session_id)
        .ok_or_else(|| ChatServiceError::new(ChatErrorKind::NotFound, "chat not found"))
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

pub(super) fn chat_turn_status_from_run_status(status: ChatRunStatus) -> ChatTurnStatus {
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

pub(super) fn parse_reasoning_effort(value: &str) -> ChatReasoningEffort {
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

pub(super) fn parse_turn_status(value: &str) -> ChatRunStatus {
    match value {
        "interrupted" => ChatRunStatus::Interrupted,
        "failed" | "error" => ChatRunStatus::Failed,
        _ => ChatRunStatus::Completed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::test_support::*;

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
    async fn streaming_snapshot_throttle_allows_message_deltas_to_merge() {
        let service = test_service().await;
        let conversation = create_persisted_conversation(&service).await;
        let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
        let (_, assistant_message_id, _, _) =
            start_test_run(&service, &conversation, &runtime).await;
        let mut events = service.events.subscribe();
        service.events.emit(EventKind::ProjectRemoved {
            project_id: "test-barrier".to_string(),
        });
        loop {
            let event = tokio::time::timeout(Duration::from_secs(1), events.recv())
                .await
                .unwrap()
                .unwrap();
            if matches!(
                &event.kind,
                EventKind::ProjectRemoved { project_id } if project_id == "test-barrier"
            ) {
                break;
            }
        }

        for delta in ["one ", "two ", "three"] {
            service
                .handle_provider_notification(
                    &conversation.id,
                    &runtime,
                    "item/agentMessage/delta",
                    json!({
                        "threadId": "thread-1",
                        "turnId": "provider-turn-1",
                        "itemId": "item-1",
                        "delta": delta
                    }),
                )
                .await
                .unwrap();
        }

        let snapshot = tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(snapshot.kind, EventKind::ChatItemUpdated { .. }));

        let merged_delta = tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            &merged_delta.kind,
            EventKind::ChatMessageDelta {
                message_id,
                delta,
                ..
            } if message_id == &assistant_message_id && delta == "one two three"
        ));
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
}
