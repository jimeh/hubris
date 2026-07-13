use super::*;

impl ChatService {
    pub(in crate::chat) async fn upsert_active_plan(
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

    pub(in crate::chat) async fn append_proposed_plan_delta(
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

    pub(in crate::chat) async fn finalize_proposed_plan_for_item(
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

    pub(in crate::chat) async fn finalize_streaming_plans_for_turn(
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

    pub(in crate::chat) async fn upsert_diff_summary(
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

    pub(in crate::chat) async fn upsert_context_usage(
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

    pub(in crate::chat) async fn finalize_turn(
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

    pub(super) async fn conversation_has_active_work(
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

    pub(super) async fn delete_conversation_rows(
        &self,
        conversation_id: &str,
    ) -> Result<(), ChatServiceError> {
        let mut tx = self.pool.begin().await?;
        delete_chat_conversation_rows_in_tx(&mut tx, conversation_id).await?;
        tx.commit().await?;
        Ok(())
    }

    pub(super) async fn delete_project_conversation_rows(
        &self,
        project_id: &str,
    ) -> Result<(), ChatServiceError> {
        let mut tx = self.pool.begin().await?;
        delete_project_chat_rows_in_tx(&mut tx, project_id).await?;
        tx.commit().await?;
        Ok(())
    }
}
