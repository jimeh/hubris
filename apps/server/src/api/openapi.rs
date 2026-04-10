use axum::Json;
use utoipa::OpenApi;

use crate::api::code_server::{
    CodeServerInstallPhase, CodeServerInstallProgress, CodeServerLatestCheck,
    CodeServerProcessStatus, CodeServerStatus, InstallCodeServerRequest,
};
use crate::api::editor_themes::{
    DiscoveredExtension, DiscoveredTheme, EditorThemeEntry, ImportThemeRequest, VscodeThemeJson,
    VscodeTokenColor, VscodeTokenColorSettings, VscodeTokenScope,
};
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
    AppearanceSettings, AppearanceSettingsPatch, ColorScheme, EditorSettings, EditorSettingsPatch,
    Settings, SettingsPatch, SettingsState, SettingsStatus, SettingsStatusKind, TerminalFontSource,
    TerminalSettings, TerminalSettingsPatch, TerminalTabLabelMode, WorktreeLocationMode,
    WorktreeSettings, WorktreeSettingsPatch,
};
use crate::api::system::SystemInfo;
use crate::api::tabs::{CreateTabRequest, ReorderTabsRequest, UpdateTabRequest};
use crate::api::terminal::{ClientControlMessage, ServerControlMessage};
use crate::api::worktrees::{
    CreateWorktreeRequest, GitCommitDetailsResponse, GitCommitPerson, GitCommitSummary,
    GitFileChange, GitFileChangeType, ImportWorktreeRequest, ImportableWorktree,
    ListImportableWorktreesResponse, ListWorktreeStartPointsResponse, ListWorktreesResponse,
    RenameWorktreeBranchRequest, ReorderWorktreesRequest, StartPoint, UpdateWorktreeRequest,
    Worktree, WorktreeGitPathActionRequest, WorktreeGitStatusResponse,
};
use crate::tab::{GitDiffScope, TabInfo};

#[derive(OpenApi)]
#[openapi(
    paths(
        openapi_json,
        crate::api::code_server::get_code_server_status,
        crate::api::code_server::check_code_server_update,
        crate::api::code_server::install_code_server,
        crate::api::code_server::start_code_server,
        crate::api::code_server::stop_code_server,
        crate::api::code_server::restart_code_server,
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
        crate::api::worktrees::update_project_worktree,
        crate::api::worktrees::create_project_worktree,
        crate::api::worktrees::list_project_worktree_start_points,
        crate::api::worktrees::reorder_project_worktrees,
        crate::api::worktrees::list_importable_worktrees,
        crate::api::worktrees::import_project_worktree,
        crate::api::worktrees::delete_project_worktree,
        crate::api::worktrees::get_project_worktree_git_status,
        crate::api::worktrees::get_project_worktree_commit_details,
        crate::api::worktrees::stage_project_worktree_path,
        crate::api::worktrees::unstage_project_worktree_path,
        crate::api::worktrees::discard_project_worktree_path,
        crate::api::worktrees::rename_worktree_branch,
        crate::api::tabs::list_tabs,
        crate::api::tabs::create_tab,
        crate::api::tabs::update_tab,
        crate::api::tabs::reorder_tabs,
        crate::api::tabs::delete_tab,
        crate::api::events::event_stream,
        crate::api::terminal::ws_handler,
        crate::api::system::get_system_info,
        crate::api::settings::get_settings,
        crate::api::settings::put_settings,
        crate::api::settings::patch_settings,
        crate::api::editor_themes::list_editor_themes,
        crate::api::editor_themes::get_editor_theme,
        crate::api::editor_themes::upload_editor_theme,
        crate::api::editor_themes::delete_editor_theme,
        crate::api::editor_themes::discover_editor_themes,
        crate::api::editor_themes::import_extension_theme,
    ),
    components(
        schemas(
            DirEntry,
            ListFilesResponse,
            ApiErrorResponse,
            CodeServerInstallPhase,
            CodeServerInstallProgress,
            CodeServerProcessStatus,
            CodeServerLatestCheck,
            CodeServerStatus,
            InstallCodeServerRequest,
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
            ImportableWorktree,
            ListImportableWorktreesResponse,
            ImportWorktreeRequest,
            UpdateWorktreeRequest,
            StartPoint,
            ListWorktreeStartPointsResponse,
            GitFileChangeType,
            GitFileChange,
            GitCommitSummary,
            GitCommitPerson,
            GitCommitDetailsResponse,
            WorktreeGitStatusResponse,
            WorktreeGitPathActionRequest,
            RenameWorktreeBranchRequest,
            GitDiffScope,
            TabInfo,
            CreateTabRequest,
            UpdateTabRequest,
            ReorderTabsRequest,
            ClientControlMessage,
            ServerControlMessage,
            ColorScheme,
            TerminalFontSource,
            TerminalTabLabelMode,
            WorktreeLocationMode,
            AppearanceSettings,
            AppearanceSettingsPatch,
            TerminalSettings,
            TerminalSettingsPatch,
            EditorSettings,
            EditorSettingsPatch,
            WorktreeSettings,
            WorktreeSettingsPatch,
            Settings,
            SettingsPatch,
            SettingsStatusKind,
            SettingsStatus,
            SettingsState,
            SystemInfo,
            EditorThemeEntry,
            VscodeThemeJson,
            VscodeTokenColor,
            VscodeTokenColorSettings,
            VscodeTokenScope,
            DiscoveredTheme,
            DiscoveredExtension,
            ImportThemeRequest,
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
