use axum::Json;
use utoipa::OpenApi;

use crate::api::files::{
    ApiErrorResponse, DirEntry, ListFilesResponse, ListWorktreeFilesResponse,
    RenameWorktreeFileRequest, RenameWorktreeFileResponse, WorktreeFileContentParams,
    WorktreeFileContentResponse, WorktreeFileEntry, WorktreeFileKind, WorktreeGitDiffParams,
    WorktreeGitDiffResponse, WriteWorktreeFileContentRequest, WriteWorktreeFileContentResponse,
};
use crate::api::projects::{
    AddProjectRequest, Project, ReorderProjectsRequest, UpdateProjectRequest,
};
use crate::api::settings::{
    AppearanceSettings, AppearanceSettingsPatch, ColorScheme, Settings, SettingsPatch,
    SettingsState, SettingsStatus, SettingsStatusKind, TerminalFontSource, TerminalSettings,
    TerminalSettingsPatch, WorktreeLocationMode, WorktreeSettings, WorktreeSettingsPatch,
};
use crate::api::tabs::{CreateTabRequest, ReorderTabsRequest, UpdateTabRequest};
use crate::api::terminal::{ClientControlMessage, ServerControlMessage};
use crate::api::worktrees::{
    CreateWorktreeRequest, GitCommitDetailsResponse, GitCommitPerson, GitCommitSummary,
    GitFileChange, GitFileChangeType, ListWorktreeStartPointsResponse, ListWorktreesResponse,
    ReorderWorktreesRequest, StartPoint, Worktree, WorktreeGitPathActionRequest,
    WorktreeGitStatusResponse,
};
use crate::tab::{GitDiffScope, TabInfo};

#[derive(OpenApi)]
#[openapi(
    paths(
        openapi_json,
        crate::api::files::list_files,
        crate::api::files::list_project_worktree_files,
        crate::api::files::get_project_worktree_file_content,
        crate::api::files::put_project_worktree_file_content,
        crate::api::files::rename_project_worktree_file,
        crate::api::files::get_project_worktree_git_diff,
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
        crate::api::worktrees::get_project_worktree_git_status,
        crate::api::worktrees::get_project_worktree_commit_details,
        crate::api::worktrees::stage_project_worktree_path,
        crate::api::worktrees::unstage_project_worktree_path,
        crate::api::worktrees::discard_project_worktree_path,
        crate::api::tabs::list_tabs,
        crate::api::tabs::create_tab,
        crate::api::tabs::update_tab,
        crate::api::tabs::reorder_tabs,
        crate::api::tabs::delete_tab,
        crate::api::events::event_stream,
        crate::api::terminal::ws_handler,
        crate::api::settings::get_settings,
        crate::api::settings::put_settings,
        crate::api::settings::patch_settings,
    ),
    components(
        schemas(
            DirEntry,
            ListFilesResponse,
            ApiErrorResponse,
            WorktreeFileKind,
            WorktreeFileEntry,
            ListWorktreeFilesResponse,
            RenameWorktreeFileRequest,
            RenameWorktreeFileResponse,
            WorktreeFileContentParams,
            WorktreeFileContentResponse,
            WriteWorktreeFileContentRequest,
            WriteWorktreeFileContentResponse,
            WorktreeGitDiffParams,
            WorktreeGitDiffResponse,
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
            GitFileChangeType,
            GitFileChange,
            GitCommitSummary,
            GitCommitPerson,
            GitCommitDetailsResponse,
            WorktreeGitStatusResponse,
            WorktreeGitPathActionRequest,
            GitDiffScope,
            TabInfo,
            CreateTabRequest,
            UpdateTabRequest,
            ReorderTabsRequest,
            ClientControlMessage,
            ServerControlMessage,
            ColorScheme,
            TerminalFontSource,
            WorktreeLocationMode,
            AppearanceSettings,
            AppearanceSettingsPatch,
            TerminalSettings,
            TerminalSettingsPatch,
            WorktreeSettings,
            WorktreeSettingsPatch,
            Settings,
            SettingsPatch,
            SettingsStatusKind,
            SettingsStatus,
            SettingsState,
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
