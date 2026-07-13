use super::*;

#[derive(Debug, FromRow)]
pub(super) struct ConversationRow {
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
pub(super) struct MessageRow {
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
pub(super) struct RunRow {
    pub(super) id: String,
    conversation_id: String,
    turn_id: Option<String>,
    provider_turn_id: Option<String>,
    pub(super) status: String,
    started_at_ms: i64,
    finished_at_ms: Option<i64>,
    error_message: Option<String>,
}

#[derive(Debug, FromRow)]
pub(super) struct TurnRow {
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
pub(super) struct ItemRow {
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
pub(super) struct ItemOutputRow {
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
pub(super) struct PlanRow {
    pub(super) id: String,
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
pub(super) struct DiffSummaryRow {
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
pub(super) struct ContextUsageRow {
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
pub(super) struct PendingRequestRow {
    pub(super) id: String,
    conversation_id: String,
    turn_id: Option<String>,
    item_id: Option<String>,
    provider_request_id: String,
    provider_turn_id: Option<String>,
    provider_item_id: Option<String>,
    method: String,
    kind: String,
    pub(super) status: String,
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
pub(super) struct PendingRequestSummaryRow {
    id: String,
    conversation_id: String,
    method: String,
    kind: String,
    status: String,
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Debug, FromRow)]
pub(super) struct ReconciliationRow {
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

pub(super) async fn migrate_legacy_chat_history(
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

pub(super) fn normalize_branch_name(value: impl AsRef<str>) -> Option<String> {
    let trimmed = value.as_ref().trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(super) async fn delete_chat_conversation_rows_in_tx(
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

pub(super) async fn delete_project_chat_rows_in_tx(
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

pub(super) fn conversation_from_row(row: ConversationRow) -> ChatConversationSummary {
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

pub(super) fn parse_provider(provider: &str) -> ChatProvider {
    match provider {
        "codex" => ChatProvider::Codex,
        _ => ChatProvider::Codex,
    }
}

pub(super) fn provider_request_id_from_jsonrpc_id(id: &Value) -> String {
    id.as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| id.to_string())
}

pub(in crate::chat) fn pending_request_kind_for_method(method: &str) -> ChatPendingRequestKind {
    match method {
        "item/commandExecution/requestApproval" => ChatPendingRequestKind::CommandApproval,
        "item/fileChange/requestApproval" => ChatPendingRequestKind::FileApproval,
        "item/permissions/requestApproval" => ChatPendingRequestKind::PermissionApproval,
        "item/tool/requestUserInput" => ChatPendingRequestKind::StructuredInput,
        "mcpServer/elicitation/request" => ChatPendingRequestKind::McpElicitation,
        _ => ChatPendingRequestKind::Unsupported,
    }
}

pub(super) fn pending_request_decision_as_str(
    decision: &ChatPendingRequestDecision,
) -> &'static str {
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

pub(super) fn compact_payload_json(value: &Value) -> String {
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

pub(super) fn pending_request_payload(request: &ChatPendingRequest) -> Value {
    serde_json::from_str(&request.payload_json).unwrap_or(Value::Null)
}

pub(in crate::chat) fn provider_response_for_pending_request(
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

pub(in crate::chat) async fn request_session_id(
    service: &ChatService,
    conversation_id: &str,
) -> Result<String, ChatServiceError> {
    service
        .get_conversation_summary(conversation_id)
        .await?
        .map(|summary| summary.session_id)
        .ok_or_else(|| ChatServiceError::new(ChatErrorKind::NotFound, "chat not found"))
}

pub(super) fn parse_pending_request_kind(kind: &str) -> ChatPendingRequestKind {
    match kind {
        "command_approval" => ChatPendingRequestKind::CommandApproval,
        "file_approval" => ChatPendingRequestKind::FileApproval,
        "permission_approval" => ChatPendingRequestKind::PermissionApproval,
        "structured_input" => ChatPendingRequestKind::StructuredInput,
        "mcp_elicitation" => ChatPendingRequestKind::McpElicitation,
        _ => ChatPendingRequestKind::Unsupported,
    }
}

pub(super) fn parse_pending_request_status(status: &str) -> ChatPendingRequestStatus {
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

pub(super) fn parse_pending_request_decision(
    decision: Option<String>,
) -> Option<ChatPendingRequestDecision> {
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

pub(super) fn message_from_row(row: MessageRow) -> ChatMessage {
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

pub(super) fn run_from_row(row: RunRow) -> ChatRun {
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

pub(super) fn turn_from_row(row: TurnRow) -> ChatTurn {
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

pub(super) fn item_from_row(row: ItemRow) -> ChatItem {
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

pub(super) fn item_output_from_row(row: ItemOutputRow) -> ChatItemOutput {
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

pub(super) fn plan_from_row(row: PlanRow) -> ChatPlan {
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

pub(super) fn diff_summary_from_row(row: DiffSummaryRow) -> ChatDiffSummary {
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

pub(super) fn context_usage_from_row(row: ContextUsageRow) -> ChatContextUsage {
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

pub(super) fn pending_request_from_row(row: PendingRequestRow) -> ChatPendingRequest {
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

pub(super) fn pending_request_summary_from_row(
    row: PendingRequestSummaryRow,
) -> ChatPendingRequestSummary {
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

pub(super) fn reconciliation_from_row(row: ReconciliationRow) -> ChatReconciliation {
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

pub(super) fn parse_message_role(value: &str) -> ChatMessageRole {
    if value == "assistant" {
        ChatMessageRole::Assistant
    } else {
        ChatMessageRole::User
    }
}

pub(super) fn parse_message_status(value: &str) -> ChatMessageStatus {
    match value {
        "pending" => ChatMessageStatus::Pending,
        "streaming" => ChatMessageStatus::Streaming,
        "interrupted" => ChatMessageStatus::Interrupted,
        "failed" => ChatMessageStatus::Failed,
        _ => ChatMessageStatus::Completed,
    }
}

pub(super) fn parse_run_status(value: &str) -> ChatRunStatus {
    match value {
        "starting" => ChatRunStatus::Starting,
        "running" => ChatRunStatus::Running,
        "interrupted" => ChatRunStatus::Interrupted,
        "failed" => ChatRunStatus::Failed,
        _ => ChatRunStatus::Completed,
    }
}

pub(super) fn parse_turn_row_status(value: &str) -> ChatTurnStatus {
    match value {
        "starting" => ChatTurnStatus::Starting,
        "running" => ChatTurnStatus::Running,
        "interrupted" => ChatTurnStatus::Interrupted,
        "failed" => ChatTurnStatus::Failed,
        _ => ChatTurnStatus::Completed,
    }
}

pub(in crate::chat) fn chat_turn_status_from_run_status(status: ChatRunStatus) -> ChatTurnStatus {
    match status {
        ChatRunStatus::Starting => ChatTurnStatus::Starting,
        ChatRunStatus::Running => ChatTurnStatus::Running,
        ChatRunStatus::Completed => ChatTurnStatus::Completed,
        ChatRunStatus::Interrupted => ChatTurnStatus::Interrupted,
        ChatRunStatus::Failed => ChatTurnStatus::Failed,
    }
}

pub(super) fn parse_item_kind(value: &str) -> ChatItemKind {
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

pub(super) fn parse_item_status(value: &str) -> ChatItemStatus {
    match value {
        "started" => ChatItemStatus::Started,
        "completed" => ChatItemStatus::Completed,
        "failed" => ChatItemStatus::Failed,
        _ => ChatItemStatus::Streaming,
    }
}

pub(super) fn parse_reconciliation_status(value: &str) -> ChatReconciliationStatus {
    match value {
        "pending" => ChatReconciliationStatus::Pending,
        "running" => ChatReconciliationStatus::Running,
        "completed" => ChatReconciliationStatus::Completed,
        "failed" => ChatReconciliationStatus::Failed,
        _ => ChatReconciliationStatus::NotNeeded,
    }
}

pub(super) fn parse_plan_kind(value: &str) -> ChatPlanKind {
    match value {
        "proposed_plan" => ChatPlanKind::ProposedPlan,
        _ => ChatPlanKind::ActiveTask,
    }
}

pub(super) fn parse_plan_status(value: &str) -> ChatPlanStatus {
    match value {
        "completed" => ChatPlanStatus::Completed,
        "failed" => ChatPlanStatus::Failed,
        _ => ChatPlanStatus::Streaming,
    }
}

pub(super) fn parse_diff_files_json(value: &str) -> Vec<ChatDiffFileSummary> {
    serde_json::from_str(value).unwrap_or_default()
}

pub(in crate::chat) fn parse_reasoning_effort(value: &str) -> ChatReasoningEffort {
    match value {
        "none" => ChatReasoningEffort::None,
        "minimal" => ChatReasoningEffort::Minimal,
        "low" => ChatReasoningEffort::Low,
        "high" => ChatReasoningEffort::High,
        "xhigh" => ChatReasoningEffort::Xhigh,
        _ => ChatReasoningEffort::Medium,
    }
}

pub(super) fn parse_permission_mode(value: &str) -> Option<ChatPermissionMode> {
    match value {
        "full_access" => Some(ChatPermissionMode::FullAccess),
        _ => None,
    }
}

pub(in crate::chat) fn parse_turn_status(value: &str) -> ChatRunStatus {
    match value {
        "interrupted" => ChatRunStatus::Interrupted,
        "failed" | "error" => ChatRunStatus::Failed,
        _ => ChatRunStatus::Completed,
    }
}
