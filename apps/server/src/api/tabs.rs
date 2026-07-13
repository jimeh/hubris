use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use utoipa::IntoParams;

use crate::api::files::ApiErrorResponse;
use crate::error::ApiError;
use crate::state::AppState;
use crate::tab::{TabInfo, WorktreeTabLayoutState};
pub use crate::tabs::{
    CreateTabRequest, ReorderTabsRequest, UpdateTabRequest, UpdateWorktreeTabLayoutRequest,
};
use crate::util::default_session_id;

#[derive(Debug, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct ListTabsParams {
    #[serde(default = "default_session_id")]
    pub session_id: String,
}

#[utoipa::path(
    get,
    path = "/api/tabs",
    params(ListTabsParams),
    responses(
        (status = 200, description = "List tabs", body = [TabInfo]),
    ),
)]
pub async fn list_tabs(
    State(state): State<AppState>,
    Query(params): Query<ListTabsParams>,
) -> Json<Vec<TabInfo>> {
    Json(state.tabs_service.list_tabs(&params.session_id))
}

#[utoipa::path(
    post,
    path = "/api/tabs",
    request_body = CreateTabRequest,
    responses(
        (status = 201, description = "Tab created", body = TabInfo),
        (status = 400, description = "Invalid tab request", body = ApiErrorResponse),
        (status = 404, description = "Worktree not found", body = ApiErrorResponse),
        (status = 500, description = "Internal server error", body = ApiErrorResponse),
    ),
)]
pub async fn create_tab(
    State(state): State<AppState>,
    Json(req): Json<CreateTabRequest>,
) -> Result<(StatusCode, Json<TabInfo>), ApiError> {
    let (status, tab) = state.tabs_service.create_tab(&state, req).await?;
    Ok((status, Json(tab)))
}

#[utoipa::path(
    delete,
    path = "/api/tabs/{id}",
    params(
        ("id" = String, Path, description = "Tab ID"),
    ),
    responses(
        (status = 204, description = "Tab removed"),
        (status = 404, description = "Tab not found"),
    ),
)]
pub async fn delete_tab(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    close_tab_by_id(&state, &id).await
}

pub(crate) async fn close_tab_by_id(state: &AppState, id: &str) -> Result<StatusCode, ApiError> {
    state.tabs_service.close_tab_by_id(state, id).await
}

#[utoipa::path(
    patch,
    path = "/api/tabs/{id}",
    params(
        ("id" = String, Path, description = "Tab ID"),
    ),
    request_body = UpdateTabRequest,
    responses(
        (status = 200, description = "Tab updated", body = TabInfo),
        (status = 400, description = "Invalid tab update", body = ApiErrorResponse),
        (status = 404, description = "Tab not found"),
    ),
)]
pub async fn update_tab(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateTabRequest>,
) -> Result<Json<TabInfo>, ApiError> {
    state
        .tabs_service
        .update_tab(&state, &id, req)
        .await
        .map(Json)
}

#[utoipa::path(
    put,
    path = "/api/projects/{id}/worktrees/{worktreeId}/tab-layout",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktreeId" = String, Path, description = "Worktree ID"),
    ),
    request_body = UpdateWorktreeTabLayoutRequest,
    responses(
        (status = 200, description = "Worktree tab layout updated", body = WorktreeTabLayoutState),
        (status = 400, description = "Invalid tab layout", body = ApiErrorResponse),
        (status = 404, description = "Worktree not found", body = ApiErrorResponse),
    ),
)]
pub async fn update_worktree_tab_layout(
    State(state): State<AppState>,
    Path((project_id, worktree_id)): Path<(String, String)>,
    Json(request): Json<UpdateWorktreeTabLayoutRequest>,
) -> Result<Json<WorktreeTabLayoutState>, ApiError> {
    state
        .tabs_service
        .update_worktree_tab_layout(&state, &project_id, &worktree_id, request)
        .await
        .map(Json)
}

#[utoipa::path(
    put,
    path = "/api/tabs/reorder",
    request_body = ReorderTabsRequest,
    responses(
        (status = 200, description = "Tabs reordered", body = [TabInfo]),
        (status = 400, description = "Invalid request"),
    ),
)]
pub async fn reorder_tabs(
    State(state): State<AppState>,
    Json(req): Json<ReorderTabsRequest>,
) -> Result<Json<Vec<TabInfo>>, ApiError> {
    state.tabs_service.reorder_tabs(&state, req).map(Json)
}
