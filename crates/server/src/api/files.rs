use std::path::PathBuf;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::api::errors::map_worktree_file_error;
use crate::api::worktrees::resolve_worktree;
use crate::state::AppState;

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListFilesParams {
    /// Directory to list. Defaults to home dir.
    pub path: Option<String>,
    /// Whether to include dotfiles. Defaults to false.
    #[serde(default)]
    pub show_hidden: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DirEntry {
    pub name: String,
    pub is_git_repo: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ListFilesResponse {
    /// Canonical absolute path of the listed directory.
    pub path: String,
    /// Subdirectories within `path`.
    pub entries: Vec<DirEntry>,
    /// User's home directory (for quick-nav in UI).
    pub home_dir: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeFileKind {
    Directory,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct WorktreeFileEntry {
    pub name: String,
    pub path: String,
    pub kind: WorktreeFileKind,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ListWorktreeFilesResponse {
    pub generation: u32,
    /// Relative path from the worktree root.
    pub path: String,
    pub entries: Vec<WorktreeFileEntry>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListWorktreeFilesParams {
    /// Relative path from the worktree root. Empty means root.
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct RenameWorktreeFileRequest {
    /// Relative path from the worktree root.
    pub path: String,
    /// New basename for the file or directory.
    pub new_name: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RenameWorktreeFileResponse {
    /// Updated relative path from the worktree root.
    pub path: String,
}

#[utoipa::path(
    get,
    path = "/api/files",
    params(ListFilesParams),
    responses(
        (status = 200, description = "Directory listing", body = ListFilesResponse),
        (status = 400, description = "Path is not a directory"),
        (status = 403, description = "Permission denied"),
        (status = 404, description = "Directory not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn list_files(
    Query(params): Query<ListFilesParams>,
) -> Result<Json<ListFilesResponse>, StatusCode> {
    let home = dirs::home_dir();

    let dir = match &params.path {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => home.clone().ok_or(StatusCode::INTERNAL_SERVER_ERROR)?,
    };

    let dir = tokio::fs::canonicalize(&dir)
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
            std::io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        })?;

    let meta = tokio::fs::metadata(&dir)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !meta.is_dir() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let mut read_dir = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        })?;

    let mut entries = Vec::new();

    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy().to_string();

        // Skip hidden entries unless requested
        if !params.show_hidden && name.starts_with('.') {
            continue;
        }

        // Only include directories
        let file_type = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !file_type.is_dir() {
            continue;
        }

        // Check for .git subdirectory or file (worktrees)
        let git_path = entry.path().join(".git");
        let is_git_repo = git_path.is_dir() || git_path.is_file();

        entries.push(DirEntry { name, is_git_repo });
    }

    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(Json(ListFilesResponse {
        path: dir.to_string_lossy().to_string(),
        entries,
        home_dir: home.map(|h| h.to_string_lossy().to_string()),
    }))
}

#[utoipa::path(
    get,
    path = "/api/projects/{id}/worktrees/{worktree_id}/files",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktree_id" = String, Path, description = "Worktree ID"),
        ListWorktreeFilesParams,
    ),
    responses(
        (
            status = 200,
            description = "List immediate children for a worktree-relative directory",
            body = ListWorktreeFilesResponse
        ),
        (status = 400, description = "Invalid relative path"),
        (status = 403, description = "Permission denied"),
        (status = 404, description = "Project, worktree, or directory not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn list_project_worktree_files(
    State(state): State<AppState>,
    Path((project_id, worktree_id)): Path<(String, String)>,
    Query(params): Query<ListWorktreeFilesParams>,
) -> Result<Json<ListWorktreeFilesResponse>, StatusCode> {
    let resolved = resolve_worktree(&state, &worktree_id)
        .await?
        .ok_or(StatusCode::NOT_FOUND)?;
    if resolved.project_id != project_id {
        return Err(StatusCode::NOT_FOUND);
    }

    state
        .worktree_files
        .list_directory(&resolved, &params.path)
        .await
        .map(Json)
        .map_err(map_worktree_file_error)
}

#[utoipa::path(
    post,
    path = "/api/projects/{id}/worktrees/{worktree_id}/files/rename",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktree_id" = String, Path, description = "Worktree ID"),
    ),
    request_body = RenameWorktreeFileRequest,
    responses(
        (
            status = 200,
            description = "Rename a file or directory within the worktree",
            body = RenameWorktreeFileResponse
        ),
        (status = 400, description = "Invalid relative path or new name"),
        (status = 403, description = "Permission denied"),
        (status = 404, description = "Project, worktree, or path not found"),
        (status = 409, description = "Target path already exists"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn rename_project_worktree_file(
    State(state): State<AppState>,
    Path((project_id, worktree_id)): Path<(String, String)>,
    Json(request): Json<RenameWorktreeFileRequest>,
) -> Result<Json<RenameWorktreeFileResponse>, StatusCode> {
    let resolved = resolve_worktree(&state, &worktree_id)
        .await?
        .ok_or(StatusCode::NOT_FOUND)?;
    if resolved.project_id != project_id {
        return Err(StatusCode::NOT_FOUND);
    }

    let path = state
        .worktree_files
        .rename_entry(&resolved, &request.path, &request.new_name)
        .await
        .map_err(map_worktree_file_error)?;

    Ok(Json(RenameWorktreeFileResponse { path }))
}
