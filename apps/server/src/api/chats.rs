use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use utoipa::{IntoParams, ToSchema};

use crate::api::files::ApiErrorResponse;
use crate::api::worktrees::resolve_worktree;
use crate::chat::{
    ChatActivityDetail, ChatConversationDetail, ChatConversationSettingsPatch,
    ChatConversationSummary, ChatModelOption, ChatPendingRequest, ChatServiceError,
    ResolveChatPendingRequestRequest,
};
use crate::state::AppState;

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListChatsParams {
    pub session_id: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SendChatMessageRequest {
    pub text: String,
}

impl From<ChatServiceError> for (StatusCode, Json<ApiErrorResponse>) {
    fn from(value: ChatServiceError) -> Self {
        (
            value.status,
            Json(ApiErrorResponse {
                message: value.message,
            }),
        )
    }
}

fn map_chat_error(error: ChatServiceError) -> (StatusCode, Json<ApiErrorResponse>) {
    error.into()
}

#[utoipa::path(
    get,
    path = "/api/projects/{project_id}/worktrees/{worktree_id}/chats",
    params(
        ("project_id" = String, Path, description = "Project ID"),
        ("worktree_id" = String, Path, description = "Worktree ID"),
        ListChatsParams,
    ),
    responses(
        (status = 200, description = "Conversation summaries", body = [ChatConversationSummary]),
    ),
)]
pub async fn list_project_worktree_chats(
    State(state): State<AppState>,
    Path((project_id, worktree_id)): Path<(String, String)>,
    Query(params): Query<ListChatsParams>,
) -> Result<Json<Vec<ChatConversationSummary>>, (StatusCode, Json<ApiErrorResponse>)> {
    let conversations = state
        .chats
        .list_conversations(&project_id, &worktree_id, &params.session_id)
        .await
        .map_err(map_chat_error)?;
    Ok(Json(conversations))
}

#[utoipa::path(
    get,
    path = "/api/chats/models",
    responses(
        (status = 200, description = "Available Codex models", body = [ChatModelOption]),
        (status = 502, description = "Failed to query Codex models", body = ApiErrorResponse),
    ),
)]
pub async fn list_chat_models(
    State(state): State<AppState>,
) -> Result<Json<Vec<ChatModelOption>>, (StatusCode, Json<ApiErrorResponse>)> {
    let models = state.chats.list_models().await.map_err(map_chat_error)?;
    Ok(Json(models))
}

#[utoipa::path(
    get,
    path = "/api/chats/{conversation_id}",
    params(
        ("conversation_id" = String, Path, description = "Conversation ID"),
    ),
    responses(
        (status = 200, description = "Conversation detail", body = ChatConversationDetail),
        (status = 404, description = "Conversation not found", body = ApiErrorResponse),
    ),
)]
pub async fn get_chat(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
) -> Result<Json<ChatConversationDetail>, (StatusCode, Json<ApiErrorResponse>)> {
    let detail = state
        .chats
        .get_conversation_detail(&conversation_id)
        .await
        .map_err(map_chat_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiErrorResponse {
                    message: "chat not found".to_string(),
                }),
            )
        })?;
    Ok(Json(detail))
}

#[utoipa::path(
    get,
    path = "/api/chats/{conversation_id}/activity/{item_id}",
    params(
        ("conversation_id" = String, Path, description = "Conversation ID"),
        ("item_id" = String, Path, description = "Activity item ID"),
    ),
    responses(
        (status = 200, description = "Activity detail", body = ChatActivityDetail),
        (status = 404, description = "Activity item not found", body = ApiErrorResponse),
    ),
)]
pub async fn get_chat_activity(
    State(state): State<AppState>,
    Path((conversation_id, item_id)): Path<(String, String)>,
) -> Result<Json<ChatActivityDetail>, (StatusCode, Json<ApiErrorResponse>)> {
    let detail = state
        .chats
        .get_activity_detail(&conversation_id, &item_id)
        .await
        .map_err(map_chat_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiErrorResponse {
                    message: "chat activity not found".to_string(),
                }),
            )
        })?;
    Ok(Json(detail))
}

#[utoipa::path(
    patch,
    path = "/api/chats/{conversation_id}/settings",
    request_body = ChatConversationSettingsPatch,
    params(
        ("conversation_id" = String, Path, description = "Conversation ID"),
    ),
    responses(
        (status = 200, description = "Updated conversation summary", body = ChatConversationSummary),
        (status = 404, description = "Conversation not found", body = ApiErrorResponse),
    ),
)]
pub async fn patch_chat_settings(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Json(request): Json<ChatConversationSettingsPatch>,
) -> Result<Json<ChatConversationSummary>, (StatusCode, Json<ApiErrorResponse>)> {
    let summary = state
        .chats
        .update_conversation_settings(&conversation_id, request)
        .await
        .map_err(map_chat_error)?;
    Ok(Json(summary))
}

#[utoipa::path(
    post,
    path = "/api/chats/{conversation_id}/messages",
    request_body = SendChatMessageRequest,
    params(
        ("conversation_id" = String, Path, description = "Conversation ID"),
    ),
    responses(
        (status = 202, description = "Message accepted"),
        (status = 404, description = "Conversation not found", body = ApiErrorResponse),
        (status = 500, description = "Failed to start Codex runtime", body = ApiErrorResponse),
    ),
)]
pub async fn send_chat_message(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Json(request): Json<SendChatMessageRequest>,
) -> Result<StatusCode, (StatusCode, Json<ApiErrorResponse>)> {
    let conversation = state
        .chats
        .get_conversation_summary(&conversation_id)
        .await
        .map_err(map_chat_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiErrorResponse {
                    message: "chat not found".to_string(),
                }),
            )
        })?;
    let resolved = resolve_worktree(&state, &conversation.worktree_id)
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
        .send_message(&conversation_id, &resolved.worktree.path, request.text)
        .await
        .map_err(map_chat_error)?;
    Ok(StatusCode::ACCEPTED)
}

#[utoipa::path(
    post,
    path = "/api/chats/{conversation_id}/interrupt",
    params(
        ("conversation_id" = String, Path, description = "Conversation ID"),
    ),
    responses(
        (status = 202, description = "Interrupt requested"),
        (status = 404, description = "Conversation not found", body = ApiErrorResponse),
        (status = 409, description = "Conversation not running", body = ApiErrorResponse),
    ),
)]
pub async fn interrupt_chat(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ApiErrorResponse>)> {
    let exists = state
        .chats
        .get_conversation_summary(&conversation_id)
        .await
        .map_err(map_chat_error)?;
    if exists.is_none() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiErrorResponse {
                message: "chat not found".to_string(),
            }),
        ));
    }
    state
        .chats
        .interrupt(&conversation_id)
        .await
        .map_err(map_chat_error)?;
    Ok(StatusCode::ACCEPTED)
}

#[utoipa::path(
    post,
    path = "/api/chats/{conversation_id}/requests/{request_id}/resolve",
    request_body = ResolveChatPendingRequestRequest,
    params(
        ("conversation_id" = String, Path, description = "Conversation ID"),
        ("request_id" = String, Path, description = "Pending request ID"),
    ),
    responses(
        (status = 200, description = "Resolved pending request", body = ChatPendingRequest),
        (status = 404, description = "Pending request not found", body = ApiErrorResponse),
        (status = 409, description = "Pending request already resolved or stale", body = ApiErrorResponse),
    ),
)]
pub async fn resolve_chat_pending_request(
    State(state): State<AppState>,
    Path((conversation_id, request_id)): Path<(String, String)>,
    Json(request): Json<ResolveChatPendingRequestRequest>,
) -> Result<Json<ChatPendingRequest>, (StatusCode, Json<ApiErrorResponse>)> {
    let pending = state
        .chats
        .resolve_pending_request(&conversation_id, &request_id, request)
        .await
        .map_err(map_chat_error)?;
    Ok(Json(pending))
}
