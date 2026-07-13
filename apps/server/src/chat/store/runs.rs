use super::*;

impl ChatService {
    pub(in crate::chat) async fn persist_run_start(
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

    pub(in crate::chat) async fn attach_turn_to_run(
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

    pub(in crate::chat) async fn append_message_delta(
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

    pub(in crate::chat) async fn append_message_reasoning_delta(
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

    pub(in crate::chat) async fn replace_message_content(
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

    pub(super) async fn replace_message_reasoning(
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

    pub(in crate::chat) async fn finalize_assistant_message(
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

    pub(in crate::chat) async fn finalize_run(
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

    pub(super) async fn latest_assistant_message_id(
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

    pub(super) async fn get_turn_by_id(
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

    pub(super) async fn get_item_by_id(
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

    pub(super) async fn get_item_output_by_id(
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

    pub(super) async fn latest_item_id_for_turn_kind(
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
}
