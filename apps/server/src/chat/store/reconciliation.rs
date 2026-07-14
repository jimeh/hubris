use super::*;

impl ChatService {
    pub(in crate::chat) async fn reconcile_inflight_run_if_needed(
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
                if let Err(error) = self
                    .apply_thread_read_replay(conversation_id, runtime, &result)
                    .await
                {
                    if let Err(finish_error) = self
                        .finish_reconciliation(
                            conversation_id,
                            &reconciliation.id,
                            reconciliation.owner_generation,
                            ChatReconciliationStatus::Failed,
                            Some(error.message.clone()),
                        )
                        .await
                    {
                        tracing::error!(
                            conversation_id,
                            reconciliation_id = %reconciliation.id,
                            %finish_error,
                            "failed to persist replay reconciliation failure"
                        );
                    }
                    return Err(error);
                }
                self.finish_reconciliation(
                    conversation_id,
                    &reconciliation.id,
                    reconciliation.owner_generation,
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
                    reconciliation.owner_generation,
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

    pub(in crate::chat) async fn mark_reconciliation_pending(
        &self,
        conversation_id: &str,
        provider_thread_id: Option<String>,
        reason: &str,
        owner_generation: u64,
    ) -> Result<ChatReconciliation, ChatServiceError> {
        let now = now_ms() as i64;
        let mut tx = self.pool.begin().await?;
        let existing = sqlx::query_as::<_, ReconciliationRow>(
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
        .fetch_optional(&mut *tx)
        .await?
        .map(reconciliation_from_row);
        if existing
            .as_ref()
            .is_some_and(|reconciliation| reconciliation.owner_generation > owner_generation)
        {
            tx.rollback().await?;
            return Err(ChatServiceError::new(
                ChatErrorKind::Conflict,
                "chat reconciliation is owned by a newer runtime",
            ));
        }
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
            .execute(&mut *tx)
            .await?;
            id
        };
        let result = sqlx::query(
            "
            UPDATE chat_reconciliations
            SET provider_thread_id = COALESCE(?, provider_thread_id),
                status = ?, reason = ?, error_message = NULL,
                owner_generation = ?, updated_at_ms = ?
            WHERE id = ? AND conversation_id = ? AND owner_generation <= ?
            ",
        )
        .bind(&provider_thread_id)
        .bind(ChatReconciliationStatus::Pending.as_str())
        .bind(reason)
        .bind(owner_generation as i64)
        .bind(now)
        .bind(&reconciliation_id)
        .bind(conversation_id)
        .bind(owner_generation as i64)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return Err(ChatServiceError::new(
                ChatErrorKind::Conflict,
                "chat reconciliation is owned by a newer runtime",
            ));
        }
        sqlx::query(
            "
            UPDATE chat_conversations
            SET last_reconciliation_state = ?,
                last_reconciliation_error = NULL, updated_at_ms = ?,
                last_activity_at_ms = ?, revision = revision + 1
            WHERE id = ?
            ",
        )
        .bind(ChatReconciliationStatus::Pending.as_str())
        .bind(now)
        .bind(now)
        .bind(conversation_id)
        .execute(&mut *tx)
        .await?;
        let reconciliation = sqlx::query_as::<_, ReconciliationRow>(
            "
            SELECT
                id, conversation_id, provider_thread_id, status, reason,
                started_at_ms, finished_at_ms, error_message,
                owner_generation, created_at_ms, updated_at_ms
            FROM chat_reconciliations
            WHERE id = ? AND conversation_id = ? AND owner_generation = ?
            ",
        )
        .bind(&reconciliation_id)
        .bind(conversation_id)
        .bind(owner_generation as i64)
        .fetch_optional(&mut *tx)
        .await?
        .map(reconciliation_from_row)
        .ok_or_else(|| {
            ChatServiceError::new(
                ChatErrorKind::Internal,
                "chat reconciliation missing after pending update",
            )
        })?;
        tx.commit().await?;
        Ok(reconciliation)
    }

    pub(super) async fn start_reconciliation(
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
        self.start_reconciliation_for_owner(conversation_id, &pending.id, owner_generation)
            .await
    }

    pub(super) async fn start_reconciliation_for_owner(
        &self,
        conversation_id: &str,
        reconciliation_id: &str,
        owner_generation: u64,
    ) -> Result<ChatReconciliation, ChatServiceError> {
        let now = now_ms() as i64;
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            "
            UPDATE chat_reconciliations
            SET status = ?, started_at_ms = ?, finished_at_ms = NULL,
                error_message = NULL, updated_at_ms = ?
            WHERE id = ? AND conversation_id = ? AND owner_generation = ?
                AND status = 'pending'
            ",
        )
        .bind(ChatReconciliationStatus::Running.as_str())
        .bind(now)
        .bind(now)
        .bind(reconciliation_id)
        .bind(conversation_id)
        .bind(owner_generation as i64)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return Err(ChatServiceError::new(
                ChatErrorKind::Conflict,
                "chat reconciliation ownership changed before start",
            ));
        }
        sqlx::query(
            "
            UPDATE chat_turns
            SET reconciliation_status = ?, reconciliation_error = NULL,
                updated_at_ms = ?
            WHERE conversation_id = ?
                AND status IN ('starting', 'running')
            ",
        )
        .bind(ChatReconciliationStatus::Running.as_str())
        .bind(now)
        .bind(conversation_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "
            UPDATE chat_conversations
            SET last_reconciliation_state = ?,
                last_reconciliation_error = NULL, updated_at_ms = ?,
                last_activity_at_ms = ?, revision = revision + 1
            WHERE id = ?
            ",
        )
        .bind(ChatReconciliationStatus::Running.as_str())
        .bind(now)
        .bind(now)
        .bind(conversation_id)
        .execute(&mut *tx)
        .await?;
        let reconciliation = sqlx::query_as::<_, ReconciliationRow>(
            "
            SELECT
                id, conversation_id, provider_thread_id, status, reason,
                started_at_ms, finished_at_ms, error_message,
                owner_generation, created_at_ms, updated_at_ms
            FROM chat_reconciliations
            WHERE id = ? AND conversation_id = ? AND owner_generation = ?
            ",
        )
        .bind(reconciliation_id)
        .bind(conversation_id)
        .bind(owner_generation as i64)
        .fetch_optional(&mut *tx)
        .await?
        .map(reconciliation_from_row)
        .ok_or_else(|| {
            ChatServiceError::new(
                ChatErrorKind::Internal,
                "reconciliation row missing after marking it running",
            )
        })?;
        tx.commit().await?;
        if let Some(summary) = self.get_conversation_summary(conversation_id).await? {
            self.events.emit(EventKind::ChatReconciliationStarted {
                session_id: summary.session_id,
                reconciliation: reconciliation.clone(),
            });
        }
        Ok(reconciliation)
    }

    pub(super) async fn finish_reconciliation(
        &self,
        conversation_id: &str,
        reconciliation_id: &str,
        owner_generation: u64,
        status: ChatReconciliationStatus,
        error_message: Option<String>,
    ) -> Result<bool, ChatServiceError> {
        let now = now_ms() as i64;
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            "
            UPDATE chat_reconciliations
            SET status = ?, finished_at_ms = ?, error_message = ?,
                updated_at_ms = ?
            WHERE id = ? AND conversation_id = ? AND owner_generation = ?
                AND status IN ('pending', 'running')
            ",
        )
        .bind(status.as_str())
        .bind(now)
        .bind(&error_message)
        .bind(now)
        .bind(reconciliation_id)
        .bind(conversation_id)
        .bind(owner_generation as i64)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(false);
        }
        sqlx::query(
            "
            UPDATE chat_turns
            SET reconciliation_status = ?,
                reconciled_at_ms = CASE WHEN ? THEN ? ELSE reconciled_at_ms END,
                reconciliation_error = ?, updated_at_ms = ?
            WHERE conversation_id = ?
                AND reconciliation_status = 'running'
            ",
        )
        .bind(status.as_str())
        .bind(matches!(
            status,
            ChatReconciliationStatus::Completed | ChatReconciliationStatus::Failed
        ))
        .bind(now)
        .bind(&error_message)
        .bind(now)
        .bind(conversation_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "
            UPDATE chat_conversations
            SET last_reconciliation_state = ?,
                last_reconciliation_error = ?, updated_at_ms = ?,
                last_activity_at_ms = ?, revision = revision + 1
            WHERE id = ?
            ",
        )
        .bind(status.as_str())
        .bind(&error_message)
        .bind(now)
        .bind(now)
        .bind(conversation_id)
        .execute(&mut *tx)
        .await?;
        let reconciliation = sqlx::query_as::<_, ReconciliationRow>(
            "
            SELECT
                id, conversation_id, provider_thread_id, status, reason,
                started_at_ms, finished_at_ms, error_message,
                owner_generation, created_at_ms, updated_at_ms
            FROM chat_reconciliations
            WHERE id = ? AND conversation_id = ?
            ",
        )
        .bind(reconciliation_id)
        .bind(conversation_id)
        .fetch_one(&mut *tx)
        .await
        .map(reconciliation_from_row)?;
        tx.commit().await?;
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
        Ok(true)
    }

    async fn interrupt_uncertain_run(
        &self,
        conversation_id: &str,
        run: &RunRow,
        reason: &str,
    ) -> Result<(), ChatServiceError> {
        let message_id = self.latest_assistant_message_id(conversation_id).await?;
        self.finalize_run(
            conversation_id,
            &run.id,
            ChatRunStatus::Interrupted,
            Some(reason.to_string()),
            message_id
                .as_deref()
                .map(|message_id| (message_id, "", ChatMessageStatus::Interrupted)),
        )
        .await?;
        let _ = self.emit_conversation_updated(conversation_id).await?;
        Ok(())
    }

    pub(super) async fn apply_thread_read_replay(
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

            let replay_result: Result<(), ChatServiceError> = async {
                let mut reasoning_texts = Vec::new();
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
                                    reasoning_texts.push(text.to_string());
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
                                reasoning_texts.push(text);
                            }
                        }
                        _ => {}
                    }
                }

                if !reasoning_texts.is_empty() {
                    let message = self
                        .replace_message_reasoning(
                            conversation_id,
                            &turn.assistant_message_id,
                            &reasoning_texts.join("\n\n"),
                            ChatMessageStatus::Streaming,
                        )
                        .await?;
                    if let Some(summary) = self.get_conversation_summary(conversation_id).await? {
                        self.events.emit(EventKind::ChatMessageUpdated {
                            session_id: summary.session_id,
                            conversation_id: conversation_id.to_string(),
                            message,
                        });
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
                    ChatRunStatus::Starting | ChatRunStatus::Running => {
                        ChatMessageStatus::Streaming
                    }
                };
                let final_text = extract_turn_text(&provider_turn).unwrap_or_default();
                let message = if !self.run_is_terminal(conversation_id, &turn.run_id).await? {
                    let (run, message) = self
                        .finalize_run(
                            conversation_id,
                            &turn.run_id,
                            run_status,
                            None,
                            Some((&turn.assistant_message_id, &final_text, message_status)),
                        )
                        .await?;
                    if let Some(summary) = self.get_conversation_summary(conversation_id).await? {
                        self.events.emit(EventKind::ChatRunUpdated {
                            session_id: summary.session_id,
                            conversation_id: conversation_id.to_string(),
                            run,
                        });
                    }
                    message
                } else {
                    self.finalize_assistant_message(
                        conversation_id,
                        &turn.assistant_message_id,
                        &final_text,
                        message_status,
                    )
                    .await?
                };
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
                Ok(())
            }
            .await;

            {
                let mut state = runtime.state.lock().await;
                state.active_turn_id = previous.0;
                state.active_message_id = previous.1;
                state.active_run_id = previous.2;
            }
            replay_result?;
        }

        if !replayed_turn && let Some(text) = extract_thread_read_text(result) {
            if let Some(turn) = self
                .latest_inflight_turn_for_replay(conversation_id)
                .await?
            {
                let (run, message) = self
                    .finalize_run(
                        conversation_id,
                        &turn.run_id,
                        ChatRunStatus::Completed,
                        None,
                        Some((
                            &turn.assistant_message_id,
                            &text,
                            ChatMessageStatus::Completed,
                        )),
                    )
                    .await?;
                if let Some(summary) = self.get_conversation_summary(conversation_id).await? {
                    self.events.emit(EventKind::ChatRunUpdated {
                        session_id: summary.session_id.clone(),
                        conversation_id: conversation_id.to_string(),
                        run,
                    });
                    if let Some(message) = message {
                        self.events.emit(EventKind::ChatMessageUpdated {
                            session_id: summary.session_id.clone(),
                            conversation_id: conversation_id.to_string(),
                            message,
                        });
                    }
                    if let Some(turn) = self.get_turn_by_id(conversation_id, &turn.id).await? {
                        self.events.emit(EventKind::ChatTurnUpdated {
                            session_id: summary.session_id,
                            conversation_id: conversation_id.to_string(),
                            turn,
                        });
                    }
                }
            } else if let Some(message_id) =
                self.latest_assistant_message_id(conversation_id).await?
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

    async fn latest_inflight_turn_for_replay(
        &self,
        conversation_id: &str,
    ) -> Result<Option<ChatTurn>, ChatServiceError> {
        Ok(sqlx::query_as::<_, TurnRow>(
            "
            SELECT
                turn.id, turn.conversation_id, turn.run_id,
                turn.user_message_id, turn.assistant_message_id,
                turn.provider_turn_id, turn.status, turn.started_at_ms,
                turn.completed_at_ms, turn.error_message,
                turn.reconciliation_status, turn.reconciled_at_ms,
                turn.reconciliation_error, turn.created_at_ms,
                turn.updated_at_ms
            FROM chat_turns AS turn
            INNER JOIN chat_runs AS run ON run.id = turn.run_id
            WHERE turn.conversation_id = ?
                AND run.status IN ('starting', 'running')
            ORDER BY run.started_at_ms DESC, run.id DESC
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

    pub(in crate::chat) async fn persist_provider_thread_id(
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

    pub(in crate::chat) async fn persist_thread_preferences(
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
}
