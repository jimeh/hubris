use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use axum::Json;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use tokio::fs::{self, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use utoipa::{IntoParams, ToSchema};

use crate::api::errors::map_worktree_file_error;
use crate::api::worktrees::{ResolvedWorktree, resolve_worktree};
use crate::fs_sync::sync_parent_directory;
use crate::git::{GitDiffBlobContent, GitDiffBlobSource};
use crate::state::AppState;
use crate::tab::GitDiffScope;

const MAX_TEXT_FILE_BYTES: u64 = 1024 * 1024;
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

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

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[into_params(parameter_in = Query)]
pub struct WorktreeFileContentParams {
    /// Relative path from the worktree root.
    pub path: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct WorktreeFileContentResponse {
    pub path: String,
    pub content: String,
    pub version_token: String,
    pub language: String,
    pub read_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported_reason: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct WriteWorktreeFileContentRequest {
    pub path: String,
    pub content: String,
    pub expected_version_token: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct WriteWorktreeFileContentResponse {
    pub path: String,
    pub version_token: String,
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[into_params(parameter_in = Query)]
pub struct WorktreeGitDiffParams {
    /// Relative path from the worktree root.
    pub path: String,
    pub scope: GitDiffScope,
    /// Original relative path for rename/copy actions.
    #[serde(default)]
    pub original_path: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct WorktreeGitDiffResponse {
    pub path: String,
    pub scope: GitDiffScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub left_label: String,
    pub right_label: String,
    pub left_content: String,
    pub right_content: String,
    pub language: String,
    pub read_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported_reason: Option<String>,
}

struct LoadedTextFile {
    content: String,
    version_token: String,
    language: String,
    read_only: bool,
    unsupported_reason: Option<String>,
}

enum DiffSideContent {
    Text(String),
    Unsupported(String),
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
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => home.clone().ok_or(StatusCode::INTERNAL_SERVER_ERROR)?,
    };

    let dir = tokio::fs::canonicalize(&dir).await.map_err(map_io_status)?;

    let meta = tokio::fs::metadata(&dir)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !meta.is_dir() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let mut read_dir = tokio::fs::read_dir(&dir)
        .await
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        })?;

    let mut entries = Vec::new();
    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        if !params.show_hidden && name.starts_with('.') {
            continue;
        }

        let file_type = match entry.file_type().await {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if !file_type.is_dir() {
            continue;
        }

        let git_path = entry.path().join(".git");
        entries.push(DirEntry {
            name,
            is_git_repo: git_path.is_dir() || git_path.is_file(),
        });
    }

    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(Json(ListFilesResponse {
        path: dir.to_string_lossy().to_string(),
        entries,
        home_dir: home.map(|value| value.to_string_lossy().to_string()),
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
    AxumPath((project_id, worktree_id)): AxumPath<(String, String)>,
    Query(params): Query<ListWorktreeFilesParams>,
) -> Result<Json<ListWorktreeFilesResponse>, StatusCode> {
    let resolved = resolve_project_worktree(&state, &project_id, &worktree_id).await?;

    state
        .worktree_files
        .list_directory(&resolved, &params.path)
        .await
        .map(Json)
        .map_err(map_worktree_file_error)
}

#[utoipa::path(
    get,
    path = "/api/projects/{id}/worktrees/{worktree_id}/files/content",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktree_id" = String, Path, description = "Worktree ID"),
        WorktreeFileContentParams,
    ),
    responses(
        (
            status = 200,
            description = "Load editable worktree file content",
            body = WorktreeFileContentResponse
        ),
        (status = 400, description = "Invalid relative path"),
        (status = 403, description = "Permission denied"),
        (status = 404, description = "Project, worktree, or file not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn get_project_worktree_file_content(
    State(state): State<AppState>,
    AxumPath((project_id, worktree_id)): AxumPath<(String, String)>,
    Query(params): Query<WorktreeFileContentParams>,
) -> Result<Json<WorktreeFileContentResponse>, StatusCode> {
    let resolved = resolve_project_worktree(&state, &project_id, &worktree_id).await?;
    let (path, absolute_path) = resolve_existing_file_path(&resolved, &params.path).await?;
    let loaded = load_text_file(&absolute_path, &path).await?;

    Ok(Json(WorktreeFileContentResponse {
        path,
        content: loaded.content,
        version_token: loaded.version_token,
        language: loaded.language,
        read_only: loaded.read_only,
        unsupported_reason: loaded.unsupported_reason,
    }))
}

#[utoipa::path(
    put,
    path = "/api/projects/{id}/worktrees/{worktree_id}/files/content",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktree_id" = String, Path, description = "Worktree ID"),
    ),
    request_body = WriteWorktreeFileContentRequest,
    responses(
        (
            status = 200,
            description = "Save editable worktree file content",
            body = WriteWorktreeFileContentResponse
        ),
        (status = 400, description = "Invalid path or unsupported file"),
        (status = 403, description = "Permission denied"),
        (status = 404, description = "Project, worktree, or file not found"),
        (status = 409, description = "Version conflict"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn put_project_worktree_file_content(
    State(state): State<AppState>,
    AxumPath((project_id, worktree_id)): AxumPath<(String, String)>,
    Json(request): Json<WriteWorktreeFileContentRequest>,
) -> Result<Json<WriteWorktreeFileContentResponse>, StatusCode> {
    let resolved = resolve_project_worktree(&state, &project_id, &worktree_id).await?;
    let (path, absolute_path) = resolve_existing_file_path(&resolved, &request.path).await?;
    let mut file = OpenOptions::new()
        .read(true)
        .open(&absolute_path)
        .await
        .map_err(map_io_status)?;
    let metadata = file.metadata().await.map_err(map_io_status)?;
    if !metadata.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(StatusCode::BAD_REQUEST);
    }

    let mut current_bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut current_bytes)
        .await
        .map_err(map_io_status)?;
    let current_token = version_token(&current_bytes, &metadata);
    if current_token != request.expected_version_token {
        return Err(StatusCode::CONFLICT);
    }

    if request.content.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err(StatusCode::BAD_REQUEST);
    }

    if current_bytes == request.content.as_bytes() {
        return Ok(Json(WriteWorktreeFileContentResponse {
            path,
            version_token: current_token,
        }));
    }

    validate_existing_text_file_for_write(&current_bytes)?;

    let next_metadata = write_worktree_file_atomically(
        &absolute_path,
        &metadata,
        &current_token,
        request.content.as_bytes(),
    )
    .await?;

    state
        .worktree_files
        .invalidate_relative_paths(&resolved, std::slice::from_ref(&path))
        .map_err(map_worktree_file_error)?;

    Ok(Json(WriteWorktreeFileContentResponse {
        path,
        version_token: version_token(request.content.as_bytes(), &next_metadata),
    }))
}

#[utoipa::path(
    get,
    path = "/api/projects/{id}/worktrees/{worktree_id}/git/diff",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktree_id" = String, Path, description = "Worktree ID"),
        WorktreeGitDiffParams,
    ),
    responses(
        (
            status = 200,
            description = "Load a staged or unstaged file diff",
            body = WorktreeGitDiffResponse
        ),
        (status = 400, description = "Invalid relative path"),
        (status = 403, description = "Permission denied"),
        (status = 404, description = "Project or worktree not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn get_project_worktree_git_diff(
    State(state): State<AppState>,
    AxumPath((project_id, worktree_id)): AxumPath<(String, String)>,
    Query(params): Query<WorktreeGitDiffParams>,
) -> Result<Json<WorktreeGitDiffResponse>, StatusCode> {
    let resolved = resolve_project_worktree(&state, &project_id, &worktree_id).await?;
    let path = normalize_relative_path(&params.path)?;
    let original_path = params
        .original_path
        .as_deref()
        .map(normalize_relative_path)
        .transpose()?;
    let language = infer_language(&path);
    let left_path = original_path.clone().unwrap_or_else(|| path.clone());
    let right_path = path.clone();

    let left_content = match params.scope {
        GitDiffScope::Staged => {
            load_git_diff_side(&resolved.worktree.path, GitDiffBlobSource::Head, &left_path).await?
        }
        GitDiffScope::Unstaged => {
            load_git_diff_side(
                &resolved.worktree.path,
                GitDiffBlobSource::Index,
                &left_path,
            )
            .await?
        }
    };
    let right_content = match params.scope {
        GitDiffScope::Staged => {
            load_git_diff_side(
                &resolved.worktree.path,
                GitDiffBlobSource::Index,
                &right_path,
            )
            .await?
        }
        GitDiffScope::Unstaged => load_optional_worktree_diff_side(&resolved, &right_path).await?,
    };

    let unsupported_reason = match (&left_content, &right_content) {
        (DiffSideContent::Unsupported(reason), _) => Some(reason.clone()),
        (_, DiffSideContent::Unsupported(reason)) => Some(reason.clone()),
        _ => None,
    };

    Ok(Json(WorktreeGitDiffResponse {
        path,
        scope: params.scope,
        original_path,
        left_label: match params.scope {
            GitDiffScope::Staged => "HEAD".to_string(),
            GitDiffScope::Unstaged => "Index".to_string(),
        },
        right_label: match params.scope {
            GitDiffScope::Staged => "Index".to_string(),
            GitDiffScope::Unstaged => "Working Tree".to_string(),
        },
        left_content: match left_content {
            DiffSideContent::Text(content) => content,
            DiffSideContent::Unsupported(_) => String::new(),
        },
        right_content: match right_content {
            DiffSideContent::Text(content) => content,
            DiffSideContent::Unsupported(_) => String::new(),
        },
        language,
        read_only: true,
        unsupported_reason,
    }))
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
    AxumPath((project_id, worktree_id)): AxumPath<(String, String)>,
    Json(request): Json<RenameWorktreeFileRequest>,
) -> Result<Json<RenameWorktreeFileResponse>, StatusCode> {
    let resolved = resolve_project_worktree(&state, &project_id, &worktree_id).await?;

    let path = state
        .worktree_files
        .rename_entry(&resolved, &request.path, &request.new_name)
        .await
        .map_err(map_worktree_file_error)?;

    Ok(Json(RenameWorktreeFileResponse { path }))
}

async fn resolve_project_worktree(
    state: &AppState,
    project_id: &str,
    worktree_id: &str,
) -> Result<ResolvedWorktree, StatusCode> {
    let resolved = resolve_worktree(state, worktree_id)
        .await?
        .ok_or(StatusCode::NOT_FOUND)?;
    if resolved.project_id != project_id {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(resolved)
}

fn map_io_status(error: std::io::Error) -> StatusCode {
    match error.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
        std::io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn normalize_relative_path(raw: &str) -> Result<String, StatusCode> {
    let trimmed = raw.trim_matches('/');
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err(StatusCode::BAD_REQUEST);
    }

    let mut segments = Vec::new();
    for segment in trimmed.split('/') {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.contains('\\')
            || segment.contains(':')
        {
            return Err(StatusCode::BAD_REQUEST);
        }
        segments.push(segment);
    }

    Ok(segments.join("/"))
}

async fn resolve_existing_file_path(
    resolved: &ResolvedWorktree,
    raw_path: &str,
) -> Result<(String, PathBuf), StatusCode> {
    let path = normalize_relative_path(raw_path)?;
    let root = tokio::fs::canonicalize(&resolved.worktree.path)
        .await
        .map_err(map_io_status)?;
    let candidate = root.join(&path);
    let parent = candidate.parent().ok_or(StatusCode::BAD_REQUEST)?;
    let canonical_parent = tokio::fs::canonicalize(parent)
        .await
        .map_err(map_io_status)?;
    if !canonical_parent.starts_with(&root) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let canonical = tokio::fs::canonicalize(&candidate)
        .await
        .map_err(map_io_status)?;
    if !canonical.starts_with(&root) {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok((path, canonical))
}

fn infer_language(path: &str) -> String {
    match Path::new(path).extension().and_then(|ext| ext.to_str()) {
        Some("rs") => "rust",
        Some("ts") => "typescript",
        Some("tsx") => "typescript",
        Some("js") => "javascript",
        Some("jsx") => "javascript",
        Some("json") => "json",
        Some("md") => "markdown",
        Some("toml") => "toml",
        Some("yaml") | Some("yml") => "yaml",
        Some("html") => "html",
        Some("css") => "css",
        Some("scss") => "scss",
        Some("sh") | Some("bash") => "shell",
        Some("py") => "python",
        Some("go") => "go",
        Some("java") => "java",
        Some("sql") => "sql",
        Some("xml") => "xml",
        Some("c") => "c",
        Some("h") => "cpp",
        Some("cpp") | Some("cc") | Some("cxx") | Some("hpp") => "cpp",
        _ => "plaintext",
    }
    .to_string()
}

fn version_token(bytes: &[u8], metadata: &std::fs::Metadata) -> String {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
        .hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn validate_existing_text_file_for_write(bytes: &[u8]) -> Result<(), StatusCode> {
    std::str::from_utf8(bytes)
        .map(|_| ())
        .map_err(|_| StatusCode::BAD_REQUEST)
}

async fn load_text_file(path: &Path, relative_path: &str) -> Result<LoadedTextFile, StatusCode> {
    let metadata = fs::metadata(path).await.map_err(map_io_status)?;
    if !metadata.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }

    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Ok(LoadedTextFile {
            content: String::new(),
            version_token: version_token(&[], &metadata),
            language: infer_language(relative_path),
            read_only: true,
            unsupported_reason: Some("Files larger than 1 MiB are read-only.".to_string()),
        });
    }

    let bytes = fs::read(path).await.map_err(map_io_status)?;
    let content = match String::from_utf8(bytes.clone()) {
        Ok(content) => content,
        Err(_) => {
            return Ok(LoadedTextFile {
                content: String::new(),
                version_token: version_token(&bytes, &metadata),
                language: infer_language(relative_path),
                read_only: true,
                unsupported_reason: Some("Binary files are read-only.".to_string()),
            });
        }
    };

    Ok(LoadedTextFile {
        content,
        version_token: version_token(&bytes, &metadata),
        language: infer_language(relative_path),
        read_only: false,
        unsupported_reason: None,
    })
}

async fn write_worktree_file_atomically(
    path: &Path,
    original_metadata: &std::fs::Metadata,
    original_token: &str,
    contents: &[u8],
) -> Result<std::fs::Metadata, StatusCode> {
    let temp_path = temp_worktree_file_path(path);
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp_path)
        .await
        .map_err(map_io_status)?;

    if let Err(error) = fs::set_permissions(&temp_path, original_metadata.permissions()).await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(map_io_status(error));
    }
    if let Err(error) = file.write_all(contents).await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(map_io_status(error));
    }
    if let Err(error) = file.flush().await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(map_io_status(error));
    }
    if let Err(error) = file.sync_all().await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(map_io_status(error));
    }
    drop(file);

    let current_metadata = match fs::metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) => {
            let _ = fs::remove_file(&temp_path).await;
            return Err(map_io_status(error));
        }
    };
    if !current_metadata.is_file() || current_metadata.len() > MAX_TEXT_FILE_BYTES {
        let _ = fs::remove_file(&temp_path).await;
        return Err(StatusCode::CONFLICT);
    }

    let current_bytes = match fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = fs::remove_file(&temp_path).await;
            return Err(map_io_status(error));
        }
    };
    if version_token(&current_bytes, &current_metadata) != original_token {
        let _ = fs::remove_file(&temp_path).await;
        return Err(StatusCode::CONFLICT);
    }

    if let Err(error) = fs::rename(&temp_path, path).await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(map_io_status(error));
    }
    if let Err(error) = sync_parent_directory(path).await {
        return Err(map_io_status(error));
    }

    fs::metadata(path).await.map_err(map_io_status)
}

fn temp_worktree_file_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(
        "{file_name}.tmp.{}.{}",
        std::process::id(),
        counter
    ))
}

async fn load_git_diff_side(
    worktree_path: &str,
    source: GitDiffBlobSource,
    path: &str,
) -> Result<DiffSideContent, StatusCode> {
    match crate::git::read_diff_blob(Path::new(worktree_path), source, path, MAX_TEXT_FILE_BYTES)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        GitDiffBlobContent::Missing => Ok(DiffSideContent::Text(String::new())),
        GitDiffBlobContent::Text(content) => Ok(DiffSideContent::Text(content)),
        GitDiffBlobContent::Unsupported(reason) => Ok(DiffSideContent::Unsupported(reason)),
    }
}

async fn load_optional_worktree_diff_side(
    resolved: &ResolvedWorktree,
    path: &str,
) -> Result<DiffSideContent, StatusCode> {
    let path = normalize_relative_path(path)?;
    let root = fs::canonicalize(&resolved.worktree.path)
        .await
        .map_err(map_io_status)?;
    let candidate = root.join(&path);
    let canonical_candidate = match fs::canonicalize(&candidate).await {
        Ok(canonical_candidate) => canonical_candidate,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DiffSideContent::Text(String::new()));
        }
        Err(error) => return Err(map_io_status(error)),
    };
    if !canonical_candidate.starts_with(&root) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let metadata = fs::metadata(&canonical_candidate)
        .await
        .map_err(map_io_status)?;
    if !metadata.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Ok(DiffSideContent::Unsupported(
            "Diffs larger than 1 MiB are read-only.".to_string(),
        ));
    }

    let bytes = match fs::read(&canonical_candidate).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DiffSideContent::Text(String::new()));
        }
        Err(error) => return Err(map_io_status(error)),
    };

    match String::from_utf8(bytes) {
        Ok(content) => Ok(DiffSideContent::Text(content)),
        Err(_) => Ok(DiffSideContent::Unsupported(
            "Binary diffs are not supported.".to_string(),
        )),
    }
}
