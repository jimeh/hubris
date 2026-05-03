use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use utoipa::{IntoParams, ToSchema};

use crate::api::files::ApiErrorResponse;
use crate::api::worktrees::resolve_worktree;
use crate::chat::{
    ChatActivityDetail, ChatConversationDetail, ChatConversationListScope,
    ChatConversationSettingsPatch, ChatConversationSummary, ChatModelOption, ChatPendingRequest,
    ChatServiceError, ResolveChatPendingRequestRequest,
};
use crate::state::AppState;

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListChatsParams {
    pub session_id: String,
    #[serde(default)]
    pub scope: ChatListScopeParam,
    #[serde(default)]
    pub include_archived: bool,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ChatSessionParams {
    #[serde(default = "default_session_id")]
    pub session_id: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SendChatMessageRequest {
    pub text: String,
    #[serde(default, rename = "worktree_id", alias = "worktreeId")]
    pub worktree_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, ToSchema, Default)]
#[serde(rename_all = "snake_case")]
pub enum ChatListScopeParam {
    #[default]
    Branch,
    Project,
}

impl From<ChatListScopeParam> for ChatConversationListScope {
    fn from(value: ChatListScopeParam) -> Self {
        match value {
            ChatListScopeParam::Branch => Self::Branch,
            ChatListScopeParam::Project => Self::Project,
        }
    }
}

fn default_session_id() -> String {
    "default".to_string()
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

fn chat_not_found() -> (StatusCode, Json<ApiErrorResponse>) {
    (
        StatusCode::NOT_FOUND,
        Json(ApiErrorResponse {
            message: "chat not found".to_string(),
        }),
    )
}

async fn conversation_for_session(
    state: &AppState,
    conversation_id: &str,
    session_id: &str,
) -> Result<ChatConversationSummary, (StatusCode, Json<ApiErrorResponse>)> {
    let conversation = state
        .chats
        .get_conversation_summary(conversation_id)
        .await
        .map_err(map_chat_error)?
        .ok_or_else(chat_not_found)?;
    if conversation.session_id != session_id {
        return Err(chat_not_found());
    }
    Ok(conversation)
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
    let resolved = resolve_worktree(&state, &worktree_id)
        .await
        .map_err(|status| {
            (
                status,
                Json(ApiErrorResponse {
                    message: "worktree not found".to_string(),
                }),
            )
        })?
        .filter(|resolved| resolved.project_id == project_id)
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiErrorResponse {
                    message: "worktree not found".to_string(),
                }),
            )
        })?;
    let conversations = state
        .chats
        .list_conversations(
            &project_id,
            &worktree_id,
            &resolved.worktree.branch,
            &params.session_id,
            params.scope.into(),
            params.include_archived,
        )
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
        ChatSessionParams,
    ),
    responses(
        (status = 200, description = "Conversation detail", body = ChatConversationDetail),
        (status = 404, description = "Conversation not found", body = ApiErrorResponse),
    ),
)]
pub async fn get_chat(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Query(params): Query<ChatSessionParams>,
) -> Result<Json<ChatConversationDetail>, (StatusCode, Json<ApiErrorResponse>)> {
    conversation_for_session(&state, &conversation_id, &params.session_id).await?;
    let detail = state
        .chats
        .get_conversation_detail(&conversation_id)
        .await
        .map_err(map_chat_error)?
        .ok_or_else(chat_not_found)?;
    Ok(Json(detail))
}

#[utoipa::path(
    post,
    path = "/api/chats/{conversation_id}/archive",
    params(
        ("conversation_id" = String, Path, description = "Conversation ID"),
        ChatSessionParams,
    ),
    responses(
        (status = 200, description = "Archived conversation summary", body = ChatConversationSummary),
        (status = 404, description = "Conversation not found", body = ApiErrorResponse),
        (status = 409, description = "Conversation has active work", body = ApiErrorResponse),
    ),
)]
pub async fn archive_chat(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Query(params): Query<ChatSessionParams>,
) -> Result<Json<ChatConversationSummary>, (StatusCode, Json<ApiErrorResponse>)> {
    conversation_for_session(&state, &conversation_id, &params.session_id).await?;
    let summary = state
        .chats
        .set_conversation_archived(&conversation_id, true)
        .await
        .map_err(map_chat_error)?;
    Ok(Json(summary))
}

#[utoipa::path(
    post,
    path = "/api/chats/{conversation_id}/unarchive",
    params(
        ("conversation_id" = String, Path, description = "Conversation ID"),
        ChatSessionParams,
    ),
    responses(
        (status = 200, description = "Unarchived conversation summary", body = ChatConversationSummary),
        (status = 404, description = "Conversation not found", body = ApiErrorResponse),
    ),
)]
pub async fn unarchive_chat(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Query(params): Query<ChatSessionParams>,
) -> Result<Json<ChatConversationSummary>, (StatusCode, Json<ApiErrorResponse>)> {
    conversation_for_session(&state, &conversation_id, &params.session_id).await?;
    let summary = state
        .chats
        .set_conversation_archived(&conversation_id, false)
        .await
        .map_err(map_chat_error)?;
    Ok(Json(summary))
}

#[utoipa::path(
    delete,
    path = "/api/chats/{conversation_id}",
    params(
        ("conversation_id" = String, Path, description = "Conversation ID"),
        ChatSessionParams,
    ),
    responses(
        (status = 204, description = "Conversation deleted"),
        (status = 404, description = "Conversation not found", body = ApiErrorResponse),
        (status = 409, description = "Conversation has active work", body = ApiErrorResponse),
    ),
)]
pub async fn delete_chat(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Query(params): Query<ChatSessionParams>,
) -> Result<StatusCode, (StatusCode, Json<ApiErrorResponse>)> {
    let summary = conversation_for_session(&state, &conversation_id, &params.session_id).await?;
    state
        .chats
        .delete_conversation(&conversation_id)
        .await
        .map_err(map_chat_error)?;
    if let Some(tab_id) = summary.open_tab_id.as_deref() {
        crate::api::tabs::close_tab_by_id(&state, tab_id).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/api/chats/{conversation_id}/activity/{item_id}",
    params(
        ("conversation_id" = String, Path, description = "Conversation ID"),
        ("item_id" = String, Path, description = "Activity item ID"),
        ChatSessionParams,
    ),
    responses(
        (status = 200, description = "Activity detail", body = ChatActivityDetail),
        (status = 404, description = "Activity item not found", body = ApiErrorResponse),
    ),
)]
pub async fn get_chat_activity(
    State(state): State<AppState>,
    Path((conversation_id, item_id)): Path<(String, String)>,
    Query(params): Query<ChatSessionParams>,
) -> Result<Json<ChatActivityDetail>, (StatusCode, Json<ApiErrorResponse>)> {
    conversation_for_session(&state, &conversation_id, &params.session_id).await?;
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
        ChatSessionParams,
    ),
    responses(
        (status = 200, description = "Updated conversation summary", body = ChatConversationSummary),
        (status = 404, description = "Conversation not found", body = ApiErrorResponse),
    ),
)]
pub async fn patch_chat_settings(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Query(params): Query<ChatSessionParams>,
    Json(request): Json<ChatConversationSettingsPatch>,
) -> Result<Json<ChatConversationSummary>, (StatusCode, Json<ApiErrorResponse>)> {
    conversation_for_session(&state, &conversation_id, &params.session_id).await?;
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
        ChatSessionParams,
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
    Query(params): Query<ChatSessionParams>,
    Json(request): Json<SendChatMessageRequest>,
) -> Result<StatusCode, (StatusCode, Json<ApiErrorResponse>)> {
    let conversation =
        conversation_for_session(&state, &conversation_id, &params.session_id).await?;
    if conversation.archived_at.is_some() {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiErrorResponse {
                message: "chat is archived".to_string(),
            }),
        ));
    }
    let requested_worktree_id = request
        .worktree_id
        .as_deref()
        .unwrap_or(&conversation.worktree_id);
    let resolved = resolve_worktree(&state, requested_worktree_id)
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
    validate_conversation_worktree_branch(&state, &conversation, &resolved).await?;
    state
        .chats
        .send_message(&conversation_id, &resolved.worktree.path, request.text)
        .await
        .map_err(map_chat_error)?;
    Ok(StatusCode::ACCEPTED)
}

async fn validate_conversation_worktree_branch(
    state: &AppState,
    conversation: &ChatConversationSummary,
    resolved: &crate::api::worktrees::ResolvedWorktree,
) -> Result<(), (StatusCode, Json<ApiErrorResponse>)> {
    if resolved.project_id != conversation.project_id {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiErrorResponse {
                message: "chat conversation does not belong to this project".to_string(),
            }),
        ));
    }

    if conversation.branch_name.as_deref() == Some(resolved.worktree.branch.as_str()) {
        return Ok(());
    }
    if conversation.branch_name.is_none() && conversation.worktree_id == resolved.worktree.id {
        state
            .chats
            .backfill_conversation_branch(&conversation.id, &resolved.worktree.branch)
            .await
            .map_err(map_chat_error)?;
        return Ok(());
    }

    Err((
        StatusCode::BAD_REQUEST,
        Json(ApiErrorResponse {
            message: "chat conversation does not belong to this branch".to_string(),
        }),
    ))
}

#[utoipa::path(
    post,
    path = "/api/chats/{conversation_id}/interrupt",
    params(
        ("conversation_id" = String, Path, description = "Conversation ID"),
        ChatSessionParams,
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
    Query(params): Query<ChatSessionParams>,
) -> Result<StatusCode, (StatusCode, Json<ApiErrorResponse>)> {
    conversation_for_session(&state, &conversation_id, &params.session_id).await?;
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
        ChatSessionParams,
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
    Query(params): Query<ChatSessionParams>,
    Json(request): Json<ResolveChatPendingRequestRequest>,
) -> Result<Json<ChatPendingRequest>, (StatusCode, Json<ApiErrorResponse>)> {
    conversation_for_session(&state, &conversation_id, &params.session_id).await?;
    let pending = state
        .chats
        .resolve_pending_request(&conversation_id, &request_id, request)
        .await
        .map_err(map_chat_error)?;
    Ok(Json(pending))
}
