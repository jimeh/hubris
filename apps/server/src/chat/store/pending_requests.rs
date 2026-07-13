use super::*;

impl ChatService {
    pub(in crate::chat) async fn persist_provider_request(
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

    pub(in crate::chat) async fn get_pending_request_by_id(
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

    pub(in crate::chat) async fn update_pending_request_terminal(
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

    pub(in crate::chat) async fn mark_pending_requests_stale_for_conversation(
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

    pub(in crate::chat) async fn reconcile_provider_request_resolved(
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
}
