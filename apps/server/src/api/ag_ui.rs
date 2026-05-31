use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use agui_rs_core::{Event as AgUiEvent, RunAgentInput};
use agui_rs_encoder::EventEncoder;
use axum::Json;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
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
    ChatConversationDetail, ChatItemKind, ChatItemStatus, ChatMessageRole, ChatMessageStatus,
    ChatPendingRequestKind, ChatPendingRequestStatus, ChatRunStatus,
};
use crate::events::{Event, EventKind};
use crate::state::AppState;

/// Runs a Codex chat turn through the AG-UI HTTP event protocol.
pub async fn run_codex_ag_ui_chat(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<RunAgentInput>,
) -> Response {
    let encoder = EventEncoder::with_accept(
        headers
            .get(header::ACCEPT)
            .and_then(|value| value.to_str().ok()),
    );
    let result = prepare_run(&state, &conversation_id, &input).await;
    let (detail, rx) = match result {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
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
    response
}

async fn prepare_run(
    state: &AppState,
    conversation_id: &str,
    input: &RunAgentInput,
) -> Result<
    (ChatConversationDetail, broadcast::Receiver<Arc<Event>>),
    (StatusCode, Json<ApiErrorResponse>),
> {
    let before = state
        .chats
        .get_conversation_detail(conversation_id)
        .await
        .map_err(map_chat_error)?
        .ok_or_else(chat_not_found)?;

    if before.conversation.archived_at.is_some() {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiErrorResponse {
                message: "chat is archived".to_string(),
            }),
        ));
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
        .map_err(map_chat_error)?
        .ok_or_else(chat_not_found)?;
    Ok((detail, rx))
}

async fn send_chat_message_for_ag_ui(
    state: &AppState,
    detail: &ChatConversationDetail,
    text: String,
) -> Result<(), (StatusCode, Json<ApiErrorResponse>)> {
    let request = SendChatMessageRequest {
        text,
        worktree_id: Some(detail.conversation.worktree_id.clone()),
    };
    let resolved = resolve_worktree(state, &detail.conversation.worktree_id)
        .await
        .map_err(|status| {
            (
                status,
                Json(ApiErrorResponse {
                    message: "worktree not found".to_string(),
                }),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiErrorResponse {
                    message: "worktree not found".to_string(),
                }),
            )
        })?;
    state
        .chats
        .send_message(
            &detail.conversation.id,
            &resolved.worktree.path,
            request.text,
        )
        .await
        .map_err(map_chat_error)?;
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
        }
        | EventKind::ChatItemUpdated {
            conversation_id: event_conversation_id,
            item,
            ..
        } if event_conversation_id == conversation_id && is_activity_item_kind(item.kind) => Some(
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
    let activities = detail
        .items
        .iter()
        .filter(|item| is_activity_item_kind(item.kind))
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
        activity_type: format!("codex.{}", item_kind_name(item.kind)),
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

fn item_kind_name(kind: ChatItemKind) -> &'static str {
    match kind {
        ChatItemKind::AgentMessage => "agent_message",
        ChatItemKind::Reasoning => "reasoning",
        ChatItemKind::CommandExecution => "command_execution",
        ChatItemKind::FileChange => "file_change",
        ChatItemKind::McpToolCall => "mcp_tool_call",
        ChatItemKind::DynamicToolCall => "dynamic_tool_call",
        ChatItemKind::WebSearch => "web_search",
        ChatItemKind::ImageView => "image_view",
        ChatItemKind::Hook => "hook",
        ChatItemKind::AutoApprovalReview => "auto_approval_review",
        ChatItemKind::ModelReroute => "model_reroute",
        ChatItemKind::Unknown => "unknown",
    }
}

fn is_activity_item_kind(kind: ChatItemKind) -> bool {
    matches!(
        kind,
        ChatItemKind::CommandExecution
            | ChatItemKind::FileChange
            | ChatItemKind::McpToolCall
            | ChatItemKind::DynamicToolCall
            | ChatItemKind::WebSearch
            | ChatItemKind::ImageView
            | ChatItemKind::Hook
            | ChatItemKind::AutoApprovalReview
            | ChatItemKind::ModelReroute
            | ChatItemKind::Unknown
    )
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

fn chat_not_found() -> (StatusCode, Json<ApiErrorResponse>) {
    (
        StatusCode::NOT_FOUND,
        Json(ApiErrorResponse {
            message: "chat not found".to_string(),
        }),
    )
}

fn map_chat_error(error: crate::chat::ChatServiceError) -> (StatusCode, Json<ApiErrorResponse>) {
    (
        error.status,
        Json(ApiErrorResponse {
            message: error.message,
        }),
    )
}
