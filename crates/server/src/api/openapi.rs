use axum::Json;
use utoipa::OpenApi;

use crate::api::files::{DirEntry, ListFilesResponse};
use crate::api::projects::{
    AddProjectRequest, Project, ReorderProjectsRequest, UpdateProjectRequest,
};
use crate::api::settings::{AppearanceSettings, Settings, TerminalSettings, WorktreeSettings};
use crate::api::tabs::{CreateTabRequest, ReorderTabsRequest, UpdateTabRequest};
use crate::api::terminal::{ClientControlMessage, ServerControlMessage};
use crate::api::worktrees::{
    CreateWorktreeRequest, ListWorktreeStartPointsResponse, ListWorktreesResponse,
    ReorderWorktreesRequest, StartPoint, Worktree,
};
use crate::pty::live_tab::TabInfo;

#[derive(OpenApi)]
#[openapi(
    paths(
        openapi_json,
        crate::api::files::list_files,
        crate::api::projects::list_projects,
        crate::api::projects::add_project,
        crate::api::projects::update_project,
        crate::api::projects::reorder_projects,
        crate::api::projects::delete_project,
        crate::api::worktrees::list_project_worktrees,
        crate::api::worktrees::create_project_worktree,
        crate::api::worktrees::list_project_worktree_start_points,
        crate::api::worktrees::reorder_project_worktrees,
        crate::api::worktrees::delete_project_worktree,
        crate::api::tabs::list_tabs,
        crate::api::tabs::create_tab,
        crate::api::tabs::update_tab,
        crate::api::tabs::reorder_tabs,
        crate::api::tabs::delete_tab,
        crate::api::events::event_stream,
        crate::api::terminal::ws_handler,
        crate::api::settings::get_settings,
        crate::api::settings::save_settings,
    ),
    components(
        schemas(
            DirEntry,
            ListFilesResponse,
            Project,
            AddProjectRequest,
            UpdateProjectRequest,
            ReorderProjectsRequest,
            Worktree,
            ListWorktreesResponse,
            CreateWorktreeRequest,
            ReorderWorktreesRequest,
            StartPoint,
            ListWorktreeStartPointsResponse,
            TabInfo,
            CreateTabRequest,
            UpdateTabRequest,
            ReorderTabsRequest,
            ClientControlMessage,
            ServerControlMessage,
            AppearanceSettings,
            TerminalSettings,
            WorktreeSettings,
            Settings,
        )
    ),
    tags(
        (name = "hubris", description = "Hubris API"),
    ),
)]
pub struct ApiDoc;

pub fn spec() -> utoipa::openapi::OpenApi {
    ApiDoc::openapi()
}

/// Return the generated OpenAPI document as JSON.
#[utoipa::path(
    get,
    path = "/api/openapi.json",
    responses(
        (status = 200, description = "OpenAPI document"),
    ),
)]
pub async fn openapi_json() -> Json<utoipa::openapi::OpenApi> {
    Json(spec())
}
