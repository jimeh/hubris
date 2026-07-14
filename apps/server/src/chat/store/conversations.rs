use super::*;
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
            conversation: conversation.clone(),
        });
        Ok(conversation)
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

    /// Fetch persisted output for activity items in a conversation.
    pub async fn list_activity_outputs(
        &self,
        conversation_id: &str,
        item_ids: &[String],
    ) -> Result<Vec<ChatItemOutput>, ChatServiceError> {
        if item_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut query = sqlx::QueryBuilder::<Sqlite>::new(
            "
            SELECT
                id, conversation_id, item_id, stream_kind, sequence,
                content_text, byte_count, created_at_ms, updated_at_ms
            FROM chat_item_outputs
            WHERE conversation_id = ",
        );
        query.push_bind(conversation_id).push(" AND item_id IN (");
        let mut separated = query.separated(", ");
        for item_id in item_ids {
            separated.push_bind(item_id);
        }
        separated
            .push_unseparated(") ORDER BY item_id ASC, sequence ASC, created_at_ms ASC, id ASC");
        let rows = query
            .build_query_as::<ItemOutputRow>()
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(item_output_from_row).collect())
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
        let result = sqlx::query(
            "
            UPDATE chat_conversations
            SET
                selected_model = ?,
                selected_effort = ?,
                selected_permission_mode = ?,
                updated_at_ms = ?,
                last_activity_at_ms = ?,
                revision = revision + 1
            WHERE id = ? AND archived_at_ms IS NULL
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

        if result.rows_affected() == 0 {
            let conversation = self
                .get_conversation_summary(conversation_id)
                .await?
                .ok_or_else(|| ChatServiceError::new(ChatErrorKind::NotFound, "chat not found"))?;
            if conversation.archived_at.is_some() {
                return Err(ChatServiceError::new(
                    ChatErrorKind::Conflict,
                    "chat is archived",
                ));
            }
            return Err(ChatServiceError::new(
                ChatErrorKind::Internal,
                "chat settings update did not modify the conversation",
            ));
        }

        self.emit_conversation_updated(conversation_id)
            .await?
            .ok_or_else(|| ChatServiceError::new(ChatErrorKind::NotFound, "chat not found"))
    }
}
