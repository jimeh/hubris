use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use agui_rs_core::{Event as AgUiEvent, RunAgentInput};
use agui_rs_encoder::EventEncoder;
use axum::Json;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use bytes::Bytes;
use codex_ag_ui::{
    CodexAgUiActivity, CodexAgUiActivityStatus, CodexAgUiMessage, CodexAgUiMessageRole,
    CodexAgUiMessageStatus, CodexAgUiRunStatus, CodexAgUiSnapshot, CodexAgUiTranslator,
    CodexAgUiUpdate, input_last_user_text,
};
use serde_json::{Map, Value, json};
use tokio::sync::broadcast;

use crate::api::chats::SendChatMessageRequest;
use crate::api::files::ApiErrorResponse;
use crate::api::worktrees::resolve_worktree;
use crate::chat::{
    ChatConversationDetail, ChatItemStatus, ChatMessageRole, ChatMessageStatus,
    ChatPendingRequestKind, ChatPendingRequestStatus, ChatRunStatus,
};
use crate::error::ApiError;
use crate::events::{Event, EventKind};
use crate::state::AppState;

/// Runs a Codex chat turn through the AG-UI HTTP event protocol.
#[utoipa::path(
    post,
    path = "/api/chats/{conversation_id}/ag-ui",
    tag = "crate::api::ag_ui",
    request_body(
        content = serde_json::Value,
        description = "AG-UI `RunAgentInput` run payload",
    ),
    params(
        ("conversation_id" = String, Path, description = "Conversation ID"),
    ),
    responses(
        (status = 200, description = "AG-UI server-sent event stream"),
        (status = 403, description = "Chat is disabled in Experimental settings", body = ApiErrorResponse),
        (status = 404, description = "Conversation or worktree not found", body = ApiErrorResponse),
        (status = 409, description = "Chat is archived", body = ApiErrorResponse),
        (status = 500, description = "Chat storage or Codex runtime failure", body = ApiErrorResponse),
        (status = 502, description = "Codex app-server communication failure", body = ApiErrorResponse),
    ),
)]
pub async fn run_codex_ag_ui_chat(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<RunAgentInput>,
) -> Result<Response, ApiError> {
    let encoder = EventEncoder::with_accept(
        headers
            .get(header::ACCEPT)
            .and_then(|value| value.to_str().ok()),
    );
    let (detail, rx) = prepare_run(&state, &conversation_id, &input).await?;
    let initial = detail_to_snapshot(&detail, &input);
    let stream = ag_ui_body_stream(initial, rx, conversation_id, encoder);
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static(agui_rs_encoder::AGUI_MEDIA_TYPE_SSE),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-cache"),
    );
    response.headers_mut().insert(
        header::CONNECTION,
        header::HeaderValue::from_static("keep-alive"),
    );
    Ok(response)
}

async fn prepare_run(
    state: &AppState,
    conversation_id: &str,
    input: &RunAgentInput,
) -> Result<(ChatConversationDetail, broadcast::Receiver<Arc<Event>>), ApiError> {
    if !state
        .settings
        .get()
        .await
        .settings
        .experimental
        .chat_enabled
    {
        return Err(ApiError::forbidden(
            "chat is disabled in Experimental settings",
        ));
    }

    let before = state
        .chats
        .get_conversation_detail(conversation_id)
        .await
        .map_err(ApiError::from)?
        .ok_or_else(chat_not_found)?;

    if before.conversation.archived_at.is_some() {
        return Err(ApiError::conflict("chat is archived"));
    }

    let incoming_user = input_last_user_text(input);
    let should_send = incoming_user.is_some_and(|(message_id, text)| {
        !text.trim().is_empty()
            && !before
                .messages
                .iter()
                .any(|message| message.id == message_id)
    });
    let rx = state.events.subscribe();

    if should_send {
        let text = incoming_user
            .map(|(_, text)| text.to_string())
            .unwrap_or_default();
        send_chat_message_for_ag_ui(state, &before, text).await?;
    }

    let detail = state
        .chats
        .get_conversation_detail(conversation_id)
        .await
        .map_err(ApiError::from)?
        .ok_or_else(chat_not_found)?;
    Ok((detail, rx))
}

async fn send_chat_message_for_ag_ui(
    state: &AppState,
    detail: &ChatConversationDetail,
    text: String,
) -> Result<(), ApiError> {
    let request = SendChatMessageRequest {
        text,
        worktree_id: Some(detail.conversation.worktree_id.clone()),
    };
    let resolved = resolve_worktree(state, &detail.conversation.worktree_id)
        .await
        .map_err(|error| {
            tracing::debug!(error = %error, "failed to resolve worktree for AG-UI chat");
            if error.status() == StatusCode::NOT_FOUND {
                ApiError::not_found("worktree not found")
            } else {
                // Non-404 resolve failures keep their own message; a
                // "not found" body with a 500/403 status would mislead.
                error
            }
        })?
        .ok_or_else(|| ApiError::not_found("worktree not found"))?;
    state
        .chats
        .send_message(
            &detail.conversation.id,
            &resolved.worktree.path,
            request.text,
        )
        .await
        .map_err(ApiError::from)?;
    Ok(())
}

fn ag_ui_body_stream(
    initial: CodexAgUiSnapshot,
    mut rx: broadcast::Receiver<Arc<Event>>,
    conversation_id: String,
    encoder: EventEncoder,
) -> impl futures_util::Stream<Item = Result<Bytes, Infallible>> {
    async_stream::stream! {
        let mut translator = CodexAgUiTranslator::new();
        for event in translator.snapshot_events(&initial) {
            if let Some(frame) = encode_event(&encoder, event) {
                yield Ok(frame);
            }
        }

        let keepalive = tokio::time::sleep(Duration::from_secs(120));
        tokio::pin!(keepalive);

        loop {
            tokio::select! {
                _ = &mut keepalive => {
                    break;
                }
                next = rx.recv() => {
                    let event = match next {
                        Ok(event) => event,
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    };
                    let Some(update) = event_to_ag_ui_update(&event, &conversation_id) else {
                        continue;
                    };
                    let terminal = update_is_terminal(&update);
                    keepalive
                        .as_mut()
                        .reset(tokio::time::Instant::now() + Duration::from_secs(120));
                    for event in translator.update_events(&initial.thread_id, &initial.run_id, update) {
                        if let Some(frame) = encode_event(&encoder, event) {
                            yield Ok(frame);
                        }
                    }
                    if terminal {
                        break;
                    }
                }
            }
        }
    }
}

fn encode_event(encoder: &EventEncoder, event: AgUiEvent) -> Option<Bytes> {
    match encoder.encode_sse(&event) {
        Ok(frame) => Some(Bytes::from(frame)),
        Err(error) => {
            tracing::warn!(error = %error, "failed to encode AG-UI event");
            None
        }
    }
}

fn event_to_ag_ui_update(event: &Event, conversation_id: &str) -> Option<CodexAgUiUpdate> {
    match &event.kind {
        EventKind::ChatMessageDelta {
            conversation_id: event_conversation_id,
            message_id,
            delta,
            ..
        } if event_conversation_id == conversation_id => Some(CodexAgUiUpdate::MessageDelta {
            message_id: message_id.clone(),
            delta: delta.clone(),
        }),
        EventKind::ChatMessageUpdated {
            conversation_id: event_conversation_id,
            message,
            ..
        } if event_conversation_id == conversation_id => Some(CodexAgUiUpdate::MessageUpdated(
            chat_message_to_ag_ui(message),
        )),
        EventKind::ChatActivityUpdated {
            conversation_id: event_conversation_id,
            item,
            ..
        } if event_conversation_id == conversation_id && item.kind.is_activity() => Some(
            CodexAgUiUpdate::ActivityUpdated(chat_item_to_activity(item)),
        ),
        EventKind::ChatPendingRequestCreated { request, .. }
        | EventKind::ChatPendingRequestUpdated { request, .. }
        | EventKind::ChatPendingRequestResolved { request, .. }
            if request.conversation_id == conversation_id =>
        {
            Some(CodexAgUiUpdate::ActivityUpdated(
                pending_request_to_activity(request),
            ))
        }
        EventKind::ChatRunUpdated {
            conversation_id: event_conversation_id,
            run,
            ..
        } if event_conversation_id == conversation_id => Some(CodexAgUiUpdate::RunUpdated(
            run_to_status(run.status, run.error_message.clone()),
        )),
        EventKind::ChatPlanUpdated {
            conversation_id: event_conversation_id,
            plan,
            ..
        } if event_conversation_id == conversation_id => {
            Some(CodexAgUiUpdate::ActivityUpdated(plan_to_activity(plan)))
        }
        EventKind::ChatDiffUpdated {
            conversation_id: event_conversation_id,
            diff,
            ..
        } if event_conversation_id == conversation_id => Some(CodexAgUiUpdate::ActivityUpdated(
            diff_summary_to_activity(diff),
        )),
        _ => None,
    }
}

fn update_is_terminal(update: &CodexAgUiUpdate) -> bool {
    matches!(
        update,
        CodexAgUiUpdate::RunUpdated(CodexAgUiRunStatus { terminal: true, .. })
            | CodexAgUiUpdate::Error { .. }
    )
}

fn detail_to_snapshot(detail: &ChatConversationDetail, input: &RunAgentInput) -> CodexAgUiSnapshot {
    let mut activities: Vec<_> = detail
        .items
        .iter()
        .filter(|item| item.kind.is_activity())
        .map(chat_item_to_activity)
        .chain(
            detail
                .pending_requests
                .iter()
                .map(pending_request_to_activity),
        )
        .chain(detail.plans.iter().map(plan_to_activity))
        .chain(detail.diff_summaries.iter().map(diff_summary_to_activity))
        .collect();
    activities.sort_by_key(|activity| activity.sequence);
    CodexAgUiSnapshot {
        thread_id: input.thread_id.clone(),
        run_id: input.run_id.clone(),
        messages: detail.messages.iter().map(chat_message_to_ag_ui).collect(),
        activities,
        run_status: detail
            .latest_run
            .as_ref()
            .map(|run| run_to_status(run.status, run.error_message.clone())),
        state: json!({
            "conversationId": detail.conversation.id,
            "title": detail.conversation.title,
            "providerThreadId": detail.conversation.provider_thread_id,
            "contextUsage": detail.context_usage,
            "reconciliation": detail.latest_reconciliation,
        }),
    }
}

fn chat_message_to_ag_ui(message: &crate::chat::ChatMessage) -> CodexAgUiMessage {
    CodexAgUiMessage {
        id: message.id.clone(),
        role: match message.role {
            ChatMessageRole::User => CodexAgUiMessageRole::User,
            ChatMessageRole::Assistant => CodexAgUiMessageRole::Assistant,
        },
        status: match message.status {
            ChatMessageStatus::Pending => CodexAgUiMessageStatus::Pending,
            ChatMessageStatus::Streaming => CodexAgUiMessageStatus::Streaming,
            ChatMessageStatus::Completed => CodexAgUiMessageStatus::Completed,
            ChatMessageStatus::Interrupted => CodexAgUiMessageStatus::Interrupted,
            ChatMessageStatus::Failed => CodexAgUiMessageStatus::Failed,
        },
        content: message.content_text.clone(),
        reasoning: message.reasoning_text.clone(),
        sequence: message.sequence,
    }
}

fn chat_item_to_activity(item: &crate::chat::ChatItem) -> CodexAgUiActivity {
    let mut content = Map::new();
    content.insert("kind".to_string(), json!(item.kind));
    content.insert(
        "metadata".to_string(),
        parse_json_object(&item.metadata_json),
    );
    CodexAgUiActivity {
        id: item.id.clone(),
        activity_type: format!("codex.{}", item.kind.as_str()),
        status: match item.status {
            ChatItemStatus::Started => CodexAgUiActivityStatus::Started,
            ChatItemStatus::Streaming => CodexAgUiActivityStatus::Streaming,
            ChatItemStatus::Completed => CodexAgUiActivityStatus::Completed,
            ChatItemStatus::Failed => CodexAgUiActivityStatus::Failed,
        },
        title: item.title.clone(),
        summary: item.summary.clone(),
        content,
        sequence: item.sequence,
    }
}

fn pending_request_to_activity(request: &crate::chat::ChatPendingRequest) -> CodexAgUiActivity {
    let mut content = Map::new();
    content.insert("kind".to_string(), json!(request.kind));
    content.insert("method".to_string(), Value::String(request.method.clone()));
    content.insert("status".to_string(), json!(request.status));
    content.insert(
        "payload".to_string(),
        parse_json_object(&request.payload_json),
    );
    if let Some(error) = &request.error_message {
        content.insert("error".to_string(), Value::String(error.clone()));
    }
    CodexAgUiActivity {
        id: request.id.clone(),
        activity_type: format!(
            "codex.pending_request.{}",
            pending_request_kind_name(request.kind)
        ),
        status: match request.status {
            ChatPendingRequestStatus::Pending | ChatPendingRequestStatus::Resolving => {
                CodexAgUiActivityStatus::Streaming
            }
            ChatPendingRequestStatus::Failed => CodexAgUiActivityStatus::Failed,
            _ => CodexAgUiActivityStatus::Completed,
        },
        title: Some("Codex request".to_string()),
        summary: Some(request.method.clone()),
        content,
        sequence: request.sequence,
    }
}

fn plan_to_activity(plan: &crate::chat::ChatPlan) -> CodexAgUiActivity {
    let mut content = Map::new();
    content.insert("kind".to_string(), json!(plan.kind));
    content.insert(
        "content".to_string(),
        Value::String(plan.content_text.clone()),
    );
    content.insert("steps".to_string(), parse_json_object(&plan.steps_json));
    content.insert(
        "metadata".to_string(),
        parse_json_object(&plan.metadata_json),
    );
    CodexAgUiActivity {
        id: plan.id.clone(),
        activity_type: "codex.plan".to_string(),
        status: match plan.status {
            crate::chat::ChatPlanStatus::Streaming => CodexAgUiActivityStatus::Streaming,
            crate::chat::ChatPlanStatus::Failed => CodexAgUiActivityStatus::Failed,
            crate::chat::ChatPlanStatus::Completed => CodexAgUiActivityStatus::Completed,
        },
        title: Some("Plan".to_string()),
        summary: None,
        content,
        sequence: plan.sequence,
    }
}

fn diff_summary_to_activity(diff: &crate::chat::ChatDiffSummary) -> CodexAgUiActivity {
    let mut content = Map::new();
    content.insert(
        "changedFileCount".to_string(),
        json!(diff.changed_file_count),
    );
    content.insert("files".to_string(), json!(diff.files));
    content.insert(
        "metadata".to_string(),
        parse_json_object(&diff.metadata_json),
    );
    CodexAgUiActivity {
        id: diff.id.clone(),
        activity_type: "codex.diff".to_string(),
        status: CodexAgUiActivityStatus::Completed,
        title: Some("Changes".to_string()),
        summary: None,
        content,
        sequence: diff.sequence,
    }
}

fn run_to_status(status: ChatRunStatus, error: Option<String>) -> CodexAgUiRunStatus {
    CodexAgUiRunStatus {
        failed: matches!(status, ChatRunStatus::Failed),
        interrupted: matches!(status, ChatRunStatus::Interrupted),
        terminal: matches!(
            status,
            ChatRunStatus::Completed | ChatRunStatus::Interrupted | ChatRunStatus::Failed
        ),
        error,
    }
}

fn parse_json_object(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or(Value::Null)
}

fn pending_request_kind_name(kind: ChatPendingRequestKind) -> &'static str {
    match kind {
        ChatPendingRequestKind::CommandApproval => "command_approval",
        ChatPendingRequestKind::FileApproval => "file_approval",
        ChatPendingRequestKind::PermissionApproval => "permission_approval",
        ChatPendingRequestKind::StructuredInput => "structured_input",
        ChatPendingRequestKind::McpElicitation => "mcp_elicitation",
        ChatPendingRequestKind::Unsupported => "unsupported",
    }
}

fn chat_not_found() -> ApiError {
    ApiError::not_found("chat not found")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::{
        ChatContextUsage, ChatConversationSummary, ChatDiffFileSummary, ChatDiffSummary, ChatItem,
        ChatItemKind, ChatItemOutput, ChatMessage, ChatPendingRequest, ChatPlan, ChatPlanKind,
        ChatPlanStatus, ChatProvider, ChatReconciliationStatus, ChatRun,
    };

    fn item(kind: ChatItemKind, status: ChatItemStatus, sequence: u32) -> ChatItem {
        ChatItem {
            id: format!("item-{sequence}"),
            conversation_id: "chat-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            provider_turn_id: Some("provider-turn-1".to_string()),
            provider_item_id: Some(format!("provider-item-{sequence}")),
            kind,
            status,
            role: None,
            sequence,
            title: Some("Activity".to_string()),
            summary: Some("Summary".to_string()),
            metadata_json: r#"{"source":"test"}"#.to_string(),
            created_at: 1,
            updated_at: 2,
            completed_at: None,
        }
    }

    fn message(status: ChatMessageStatus) -> ChatMessage {
        ChatMessage {
            id: "message-1".to_string(),
            conversation_id: "chat-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            item_id: Some("item-1".to_string()),
            provider_turn_id: Some("provider-turn-1".to_string()),
            provider_item_id: Some("provider-item-1".to_string()),
            role: ChatMessageRole::Assistant,
            status,
            content_text: "answer".to_string(),
            reasoning_text: "reasoning".to_string(),
            sequence: 1,
            created_at: 1,
            updated_at: 2,
        }
    }

    fn pending_request(status: ChatPendingRequestStatus, sequence: u32) -> ChatPendingRequest {
        ChatPendingRequest {
            id: format!("request-{sequence}"),
            conversation_id: "chat-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            item_id: Some("item-1".to_string()),
            provider_request_id: "provider-request-1".to_string(),
            provider_turn_id: Some("provider-turn-1".to_string()),
            provider_item_id: Some("provider-item-1".to_string()),
            method: "item/commandExecution/requestApproval".to_string(),
            kind: ChatPendingRequestKind::CommandApproval,
            status,
            decision: None,
            payload_json: r#"{"command":"cargo test"}"#.to_string(),
            response_json: None,
            error_message: None,
            owner_generation: 1,
            sequence,
            created_at: 1,
            updated_at: 2,
            resolved_at: None,
        }
    }

    fn plan(status: ChatPlanStatus, sequence: u32) -> ChatPlan {
        ChatPlan {
            id: format!("plan-{sequence}"),
            conversation_id: "chat-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            item_id: Some("item-1".to_string()),
            provider_turn_id: Some("provider-turn-1".to_string()),
            provider_item_id: Some("provider-item-1".to_string()),
            kind: ChatPlanKind::ActiveTask,
            status,
            content_text: "Ship it".to_string(),
            steps_json: r#"{"steps":["test"]}"#.to_string(),
            metadata_json: r#"{"source":"turn"}"#.to_string(),
            owner_generation: 1,
            sequence,
            created_at: 1,
            updated_at: 2,
            completed_at: None,
        }
    }

    fn diff(sequence: u32) -> ChatDiffSummary {
        ChatDiffSummary {
            id: format!("diff-{sequence}"),
            conversation_id: "chat-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            provider_turn_id: Some("provider-turn-1".to_string()),
            changed_file_count: 1,
            additions: Some(3),
            deletions: Some(2),
            files: vec![ChatDiffFileSummary {
                path: "src/main.rs".to_string(),
                original_path: None,
                change_type: Some("modified".to_string()),
                additions: Some(3),
                deletions: Some(2),
            }],
            metadata_json: r#"{"source":"diff"}"#.to_string(),
            owner_generation: 1,
            sequence,
            created_at: 1,
            updated_at: 2,
        }
    }

    fn conversation() -> ChatConversationSummary {
        ChatConversationSummary {
            id: "chat-1".to_string(),
            session_id: "default".to_string(),
            project_id: "project-1".to_string(),
            worktree_id: "worktree-1".to_string(),
            branch_name: Some("main".to_string()),
            provider: ChatProvider::Codex,
            provider_thread_id: Some("provider-thread-1".to_string()),
            title: "Chat".to_string(),
            created_at: 1,
            updated_at: 2,
            last_activity_at: 2,
            last_message_at: None,
            open_tab_id: None,
            archived_at: None,
            selected_model: None,
            selected_effort: None,
            selected_permission_mode: None,
            last_run_state: ChatRunStatus::Completed,
            last_error: None,
            last_reconciliation_state: ChatReconciliationStatus::NotNeeded,
            last_reconciliation_error: None,
            context_used_tokens: None,
            context_max_tokens: None,
            context_percent_used: None,
            context_updated_at: None,
            pending_request_count: 0,
            latest_pending_request_id: None,
            latest_pending_request_kind: None,
            latest_pending_request_status: None,
            has_pending_request_attention: false,
            revision: 1,
        }
    }

    #[test]
    fn item_kind_mapping_covers_every_variant() {
        let cases = [
            (ChatItemKind::AgentMessage, "agent_message", false),
            (ChatItemKind::Reasoning, "reasoning", false),
            (ChatItemKind::CommandExecution, "command_execution", true),
            (ChatItemKind::FileChange, "file_change", true),
            (ChatItemKind::McpToolCall, "mcp_tool_call", true),
            (ChatItemKind::DynamicToolCall, "dynamic_tool_call", true),
            (ChatItemKind::WebSearch, "web_search", true),
            (ChatItemKind::ImageView, "image_view", true),
            (ChatItemKind::Hook, "hook", true),
            (
                ChatItemKind::AutoApprovalReview,
                "auto_approval_review",
                true,
            ),
            (ChatItemKind::ModelReroute, "model_reroute", true),
            (ChatItemKind::Unknown, "unknown", true),
        ];

        for (kind, name, is_activity) in cases {
            assert_eq!(
                (
                    kind.as_str(),
                    kind.is_activity(),
                    chat_item_to_activity(&item(kind, ChatItemStatus::Started, 1)).activity_type,
                ),
                (name, is_activity, format!("codex.{name}")),
            );
        }
    }

    #[test]
    fn event_adapter_maps_every_message_status() {
        let cases = [
            (ChatMessageStatus::Pending, CodexAgUiMessageStatus::Pending),
            (
                ChatMessageStatus::Streaming,
                CodexAgUiMessageStatus::Streaming,
            ),
            (
                ChatMessageStatus::Completed,
                CodexAgUiMessageStatus::Completed,
            ),
            (
                ChatMessageStatus::Interrupted,
                CodexAgUiMessageStatus::Interrupted,
            ),
            (ChatMessageStatus::Failed, CodexAgUiMessageStatus::Failed),
        ];

        for (status, expected) in cases {
            let event = Event {
                kind: EventKind::ChatMessageUpdated {
                    session_id: "default".to_string(),
                    conversation_id: "chat-1".to_string(),
                    message: message(status),
                },
            };
            let Some(CodexAgUiUpdate::MessageUpdated(actual)) =
                event_to_ag_ui_update(&event, "chat-1")
            else {
                panic!("expected a message update");
            };
            assert_eq!(actual.status, expected);
        }
    }

    #[test]
    fn item_conversion_maps_every_status() {
        let cases = [
            (ChatItemStatus::Started, CodexAgUiActivityStatus::Started),
            (
                ChatItemStatus::Streaming,
                CodexAgUiActivityStatus::Streaming,
            ),
            (
                ChatItemStatus::Completed,
                CodexAgUiActivityStatus::Completed,
            ),
            (ChatItemStatus::Failed, CodexAgUiActivityStatus::Failed),
        ];

        for (status, expected) in cases {
            assert_eq!(
                chat_item_to_activity(&item(ChatItemKind::CommandExecution, status, 1)).status,
                expected,
            );
        }
    }

    #[test]
    fn pending_request_conversion_collapses_statuses() {
        let cases = [
            (
                ChatPendingRequestStatus::Pending,
                CodexAgUiActivityStatus::Streaming,
            ),
            (
                ChatPendingRequestStatus::Resolving,
                CodexAgUiActivityStatus::Streaming,
            ),
            (
                ChatPendingRequestStatus::Failed,
                CodexAgUiActivityStatus::Failed,
            ),
            (
                ChatPendingRequestStatus::Resolved,
                CodexAgUiActivityStatus::Completed,
            ),
            (
                ChatPendingRequestStatus::Declined,
                CodexAgUiActivityStatus::Completed,
            ),
            (
                ChatPendingRequestStatus::Cancelled,
                CodexAgUiActivityStatus::Completed,
            ),
            (
                ChatPendingRequestStatus::Stale,
                CodexAgUiActivityStatus::Completed,
            ),
        ];

        for (status, expected) in cases {
            assert_eq!(
                pending_request_to_activity(&pending_request(status, 1)).status,
                expected,
            );
        }
    }

    #[test]
    fn plan_conversion_preserves_content_and_maps_statuses() {
        let cases = [
            (
                ChatPlanStatus::Streaming,
                CodexAgUiActivityStatus::Streaming,
            ),
            (
                ChatPlanStatus::Completed,
                CodexAgUiActivityStatus::Completed,
            ),
            (ChatPlanStatus::Failed, CodexAgUiActivityStatus::Failed),
        ];

        for (status, expected) in cases {
            let activity = plan_to_activity(&plan(status, 1));
            assert_eq!(
                (activity.activity_type, activity.status, activity.content,),
                (
                    "codex.plan".to_string(),
                    expected,
                    json!({
                        "kind": "active_task",
                        "content": "Ship it",
                        "steps": {"steps": ["test"]},
                        "metadata": {"source": "turn"},
                    })
                    .as_object()
                    .unwrap()
                    .clone(),
                ),
            );
        }
    }

    #[test]
    fn diff_conversion_preserves_current_wire_projection() {
        let activity = diff_summary_to_activity(&diff(1));

        assert_eq!(
            activity,
            CodexAgUiActivity {
                id: "diff-1".to_string(),
                activity_type: "codex.diff".to_string(),
                status: CodexAgUiActivityStatus::Completed,
                title: Some("Changes".to_string()),
                summary: None,
                content: json!({
                    "changedFileCount": 1,
                    "files": [{
                        "path": "src/main.rs",
                        "changeType": "modified",
                        "additions": 3,
                        "deletions": 2,
                    }],
                    "metadata": {"source": "diff"},
                })
                .as_object()
                .unwrap()
                .clone(),
                sequence: 1,
            },
        );
    }

    #[test]
    fn event_adapter_maps_terminal_run_statuses() {
        let cases = [
            (
                ChatRunStatus::Completed,
                CodexAgUiRunStatus {
                    failed: false,
                    interrupted: false,
                    terminal: true,
                    error: None,
                },
            ),
            (
                ChatRunStatus::Interrupted,
                CodexAgUiRunStatus {
                    failed: false,
                    interrupted: true,
                    terminal: true,
                    error: None,
                },
            ),
            (
                ChatRunStatus::Failed,
                CodexAgUiRunStatus {
                    failed: true,
                    interrupted: false,
                    terminal: true,
                    error: Some("boom".to_string()),
                },
            ),
        ];

        for (status, expected) in cases {
            let error_message = matches!(status, ChatRunStatus::Failed).then(|| "boom".to_string());
            let event = Event {
                kind: EventKind::ChatRunUpdated {
                    session_id: "default".to_string(),
                    conversation_id: "chat-1".to_string(),
                    run: ChatRun {
                        id: "run-1".to_string(),
                        conversation_id: "chat-1".to_string(),
                        turn_id: Some("turn-1".to_string()),
                        provider_turn_id: Some("provider-turn-1".to_string()),
                        status,
                        started_at: 1,
                        finished_at: Some(2),
                        error_message,
                    },
                },
            };
            assert_eq!(
                event_to_ag_ui_update(&event, "chat-1"),
                Some(CodexAgUiUpdate::RunUpdated(expected)),
            );
        }
    }

    #[test]
    fn activity_mutation_emits_one_ag_ui_snapshot() {
        let activity = item(ChatItemKind::CommandExecution, ChatItemStatus::Streaming, 1);
        let events = [
            Event {
                kind: EventKind::ChatActivityUpdated {
                    session_id: "default".to_string(),
                    conversation_id: "chat-1".to_string(),
                    item: activity.clone(),
                },
            },
            Event {
                kind: EventKind::ChatItemUpdated {
                    session_id: "default".to_string(),
                    conversation_id: "chat-1".to_string(),
                    item: activity.clone(),
                },
            },
        ];
        let updates: Vec<_> = events
            .iter()
            .filter_map(|event| event_to_ag_ui_update(event, "chat-1"))
            .collect();

        assert_eq!(
            updates,
            vec![CodexAgUiUpdate::ActivityUpdated(chat_item_to_activity(
                &activity,
            ))],
        );
    }

    #[test]
    fn event_adapter_filters_reasoning_and_agent_message_items() {
        for kind in [ChatItemKind::AgentMessage, ChatItemKind::Reasoning] {
            let event = Event {
                kind: EventKind::ChatActivityUpdated {
                    session_id: "default".to_string(),
                    conversation_id: "chat-1".to_string(),
                    item: item(kind, ChatItemStatus::Streaming, 1),
                },
            };
            assert_eq!(event_to_ag_ui_update(&event, "chat-1"), None);
        }
    }

    #[test]
    fn snapshot_filters_message_items_and_orders_activities() {
        let detail = ChatConversationDetail {
            conversation: conversation(),
            messages: vec![message(ChatMessageStatus::Completed)],
            turns: Vec::new(),
            items: vec![
                item(ChatItemKind::AgentMessage, ChatItemStatus::Completed, 1),
                item(ChatItemKind::Reasoning, ChatItemStatus::Completed, 2),
                item(ChatItemKind::CommandExecution, ChatItemStatus::Completed, 4),
            ],
            plans: vec![plan(ChatPlanStatus::Completed, 2)],
            diff_summaries: vec![diff(1)],
            context_usage: None,
            pending_requests: vec![pending_request(ChatPendingRequestStatus::Pending, 3)],
            latest_reconciliation: None,
            latest_run: None,
        };

        let snapshot = detail_to_snapshot(&detail, &RunAgentInput::new("thread-1", "run-1"));
        let activity_ids: Vec<_> = snapshot
            .activities
            .iter()
            .map(|activity| activity.id.as_str())
            .collect();

        assert_eq!(activity_ids, ["diff-1", "plan-2", "request-3", "item-4"]);
    }

    #[test]
    fn activity_delta_is_a_documented_polish_phase_gap() {
        // Polish-phase gap: AG-UI does not yet emit live activity-output events.
        let event = Event {
            kind: EventKind::ChatActivityDelta {
                session_id: "default".to_string(),
                conversation_id: "chat-1".to_string(),
                item_id: "item-1".to_string(),
                output: ChatItemOutput {
                    id: "output-1".to_string(),
                    conversation_id: "chat-1".to_string(),
                    item_id: "item-1".to_string(),
                    stream_kind: "stdout".to_string(),
                    sequence: 1,
                    content_text: "output".to_string(),
                    byte_count: 6,
                    created_at: 1,
                    updated_at: 2,
                },
            },
        };

        assert_eq!(event_to_ag_ui_update(&event, "chat-1"), None);
    }

    #[test]
    fn context_usage_update_is_a_documented_polish_phase_gap() {
        // Polish-phase gap: AG-UI does not yet emit live token-usage events.
        let event = Event {
            kind: EventKind::ChatContextUsageUpdated {
                session_id: "default".to_string(),
                usage: ChatContextUsage {
                    id: "usage-1".to_string(),
                    conversation_id: "chat-1".to_string(),
                    provider_thread_id: Some("provider-thread-1".to_string()),
                    used_tokens: Some(10),
                    max_tokens: Some(100),
                    percent_used: Some(10.0),
                    total_processed_tokens: Some(20),
                    metadata_json: "{}".to_string(),
                    updated_at: 2,
                },
            },
        };

        assert_eq!(event_to_ag_ui_update(&event, "chat-1"), None);
    }
}
