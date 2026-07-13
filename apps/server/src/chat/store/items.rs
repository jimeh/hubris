use super::*;

impl ChatService {
    pub(in crate::chat) async fn upsert_chat_item(
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

    pub(in crate::chat) async fn append_activity_output(
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

    pub(in crate::chat) async fn append_reasoning_item_delta(
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

    pub(super) async fn get_plan_by_id(
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

    pub(super) async fn get_diff_summary_by_id(
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

    pub(super) async fn get_context_usage_by_conversation(
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

    pub(super) async fn next_plan_sequence(
        &self,
        conversation_id: &str,
    ) -> Result<i64, ChatServiceError> {
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
}
