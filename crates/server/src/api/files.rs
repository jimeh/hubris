use std::path::PathBuf;

use axum::Json;
use axum::extract::Query;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

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
