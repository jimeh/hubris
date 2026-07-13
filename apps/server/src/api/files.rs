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
use crate::api::monaco_languages_generated::{
    MONACO_EXTENSION_ASSOCIATIONS, MONACO_FILENAME_ASSOCIATIONS, MONACO_FIRST_LINE_ASSOCIATIONS,
    MonacoFirstLineRule,
};
use crate::api::worktrees::{ResolvedWorktree, resolve_worktree};
pub use crate::domain::worktree_files::{
    ListWorktreeFilesResponse, WorktreeFileEntry, WorktreeFileKind,
};
use crate::error::ApiError;
use crate::fs_sync::sync_parent_directory;
use crate::git::{GitCommitDiffError, GitDiffBlobContent, GitDiffBlobSource};
use crate::state::AppState;
use crate::tab::GitDiffScope;
use crate::worktree_path_policy::{
    DISALLOWED_PATH_MESSAGE, WorktreePathPolicy, WorktreePathPolicyError,
};

pub use crate::error::ApiErrorResponse;

const MAX_TEXT_FILE_BYTES: u64 = 1024 * 1024;
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct ListFilesParams {
    /// Directory to list. Defaults to home dir.
    pub path: Option<String>,
    /// Whether to include dotfiles. Defaults to false.
    #[serde(default)]
    pub show_hidden: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_git_repo: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListFilesResponse {
    /// Canonical absolute path of the listed directory.
    pub path: String,
    /// Subdirectories within `path`.
    pub entries: Vec<DirEntry>,
    /// User's home directory (for quick-nav in UI).
    pub home_dir: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct ListWorktreeFilesParams {
    /// Relative path from the worktree root. Empty means root.
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenameWorktreeFileRequest {
    /// Relative path from the worktree root.
    pub path: String,
    /// New basename for the file or directory.
    pub new_name: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenameWorktreeFileResponse {
    /// Updated relative path from the worktree root.
    pub path: String,
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct WorktreeFileContentParams {
    /// Relative path from the worktree root.
    pub path: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
pub struct WriteWorktreeFileContentRequest {
    pub path: String,
    pub content: String,
    pub expected_version_token: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct WriteWorktreeFileContentResponse {
    pub path: String,
    pub version_token: String,
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct WorktreeGitDiffParams {
    /// Relative path from the worktree root.
    pub path: String,
    pub scope: GitDiffScope,
    /// Original relative path for rename/copy actions.
    #[serde(default)]
    pub original_path: Option<String>,
    #[serde(default)]
    pub commit_id: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeGitDiffResponse {
    pub path: String,
    pub scope: GitDiffScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_id: Option<String>,
    pub left_label: String,
    pub right_label: String,
    pub left_content: String,
    pub right_content: String,
    pub language: String,
    pub read_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_version_token: Option<String>,
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

struct OptionalWorktreeDiffSide {
    content: DiffSideContent,
    version_token: Option<String>,
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
) -> Result<Json<ListFilesResponse>, ApiError> {
    let home = dirs::home_dir();

    let dir = match &params.path {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => home
            .clone()
            .ok_or_else(|| ApiError::internal("Internal server error."))?,
    };

    let dir = tokio::fs::canonicalize(&dir)
        .await
        .map_err(map_io_file_error)?;

    let meta = tokio::fs::metadata(&dir).await.map_err(|error| {
        tracing::warn!(error = %error, "failed to read directory metadata");
        ApiError::internal("Internal server error.")
    })?;
    if !meta.is_dir() {
        return Err(ApiError::bad_request("Invalid path."));
    }

    let mut read_dir = tokio::fs::read_dir(&dir).await.map_err(|error| {
        tracing::warn!(error = %error, "failed to open directory listing");
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            ApiError::forbidden("Permission denied.")
        } else {
            ApiError::internal("Internal server error.")
        }
    })?;

    let mut entries = Vec::new();
    while let Some(entry) = read_dir.next_entry().await.map_err(|error| {
        tracing::warn!(error = %error, "failed to read directory entry");
        ApiError::internal("Internal server error.")
    })? {
        let name = entry.file_name().to_string_lossy().to_string();
        if !params.show_hidden && name.starts_with('.') {
            continue;
        }

        let file_type = match entry.file_type().await {
            Ok(file_type) => file_type,
            Err(error) => {
                tracing::warn!(error = %error, "failed to inspect directory entry");
                continue;
            }
        };
        if !file_type.is_dir() {
            continue;
        }

        let git_path = entry.path().join(".git");
        let is_git_repo = match tokio::fs::metadata(&git_path).await {
            Ok(metadata) => metadata.is_dir() || metadata.is_file(),
            Err(error) => {
                tracing::debug!(error = %error, "directory has no readable git metadata");
                false
            }
        };
        entries.push(DirEntry { name, is_git_repo });
    }

    entries.sort_by_key(|entry| entry.name.to_lowercase());

    Ok(Json(ListFilesResponse {
        path: dir.to_string_lossy().to_string(),
        entries,
        home_dir: home.map(|value| value.to_string_lossy().to_string()),
    }))
}

#[utoipa::path(
    get,
    path = "/api/projects/{id}/worktrees/{worktreeId}/files",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktreeId" = String, Path, description = "Worktree ID"),
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
) -> Result<Json<ListWorktreeFilesResponse>, ApiError> {
    let resolved = resolve_project_worktree(&state, &project_id, &worktree_id).await?;

    state
        .worktree_files
        .list_directory(&resolved, &params.path)
        .await
        .map(Json)
        .map_err(map_worktree_file_api_error)
}

#[utoipa::path(
    get,
    path = "/api/projects/{id}/worktrees/{worktreeId}/files/content",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktreeId" = String, Path, description = "Worktree ID"),
        WorktreeFileContentParams,
    ),
    responses(
        (
            status = 200,
            description = "Load editable worktree file content",
            body = WorktreeFileContentResponse
        ),
        (status = 400, description = "Invalid relative path", body = ApiErrorResponse),
        (status = 403, description = "Permission denied", body = ApiErrorResponse),
        (status = 404, description = "Project, worktree, or file not found", body = ApiErrorResponse),
        (status = 500, description = "Internal server error", body = ApiErrorResponse),
    ),
)]
pub async fn get_project_worktree_file_content(
    State(state): State<AppState>,
    AxumPath((project_id, worktree_id)): AxumPath<(String, String)>,
    Query(params): Query<WorktreeFileContentParams>,
) -> Result<Json<WorktreeFileContentResponse>, ApiError> {
    let resolved = resolve_project_worktree(&state, &project_id, &worktree_id).await?;
    let policy = WorktreePathPolicy::from_resolved(&resolved)
        .await
        .map_err(map_policy_build_error)?;
    let (path, absolute_path) = resolve_existing_file_path(&policy, &params.path).await?;
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
    path = "/api/projects/{id}/worktrees/{worktreeId}/files/content",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktreeId" = String, Path, description = "Worktree ID"),
    ),
    request_body = WriteWorktreeFileContentRequest,
    responses(
        (
            status = 200,
            description = "Save editable worktree file content",
            body = WriteWorktreeFileContentResponse
        ),
        (status = 400, description = "Invalid path or unsupported file", body = ApiErrorResponse),
        (status = 403, description = "Permission denied", body = ApiErrorResponse),
        (status = 404, description = "Project, worktree, or file not found", body = ApiErrorResponse),
        (status = 409, description = "Version conflict", body = ApiErrorResponse),
        (status = 500, description = "Internal server error", body = ApiErrorResponse),
    ),
)]
pub async fn put_project_worktree_file_content(
    State(state): State<AppState>,
    AxumPath((project_id, worktree_id)): AxumPath<(String, String)>,
    Json(request): Json<WriteWorktreeFileContentRequest>,
) -> Result<Json<WriteWorktreeFileContentResponse>, ApiError> {
    let resolved = resolve_project_worktree(&state, &project_id, &worktree_id).await?;
    let policy = WorktreePathPolicy::from_resolved(&resolved)
        .await
        .map_err(map_policy_build_error)?;
    let (path, absolute_path) = resolve_existing_file_path(&policy, &request.path).await?;
    let mut file = OpenOptions::new()
        .read(true)
        .open(&absolute_path)
        .await
        .map_err(map_io_file_error)?;
    let metadata = file.metadata().await.map_err(map_io_file_error)?;
    if !metadata.is_file() {
        return Err(ApiError::with_status(
            StatusCode::NOT_FOUND,
            "File not found.",
        ));
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(unsupported_file_error());
    }

    let mut current_bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut current_bytes)
        .await
        .map_err(map_io_file_error)?;
    let current_token = version_token(&current_bytes, &metadata);
    if current_token != request.expected_version_token {
        return Err(ApiError::with_status(
            StatusCode::CONFLICT,
            "File changed on disk.",
        ));
    }

    if request.content.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err(unsupported_file_error());
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
        .await
        .map_err(map_worktree_file_api_error)?;

    Ok(Json(WriteWorktreeFileContentResponse {
        path,
        version_token: version_token(request.content.as_bytes(), &next_metadata),
    }))
}

#[utoipa::path(
    get,
    path = "/api/projects/{id}/worktrees/{worktreeId}/git/diff",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktreeId" = String, Path, description = "Worktree ID"),
        WorktreeGitDiffParams,
    ),
    responses(
        (
            status = 200,
            description = "Load a staged, unstaged, or commit file diff",
            body = WorktreeGitDiffResponse
        ),
        (status = 400, description = "Invalid relative path", body = ApiErrorResponse),
        (status = 403, description = "Permission denied", body = ApiErrorResponse),
        (status = 404, description = "Project or worktree not found", body = ApiErrorResponse),
        (status = 500, description = "Internal server error", body = ApiErrorResponse),
    ),
)]
pub async fn get_project_worktree_git_diff(
    State(state): State<AppState>,
    AxumPath((project_id, worktree_id)): AxumPath<(String, String)>,
    Query(params): Query<WorktreeGitDiffParams>,
) -> Result<Json<WorktreeGitDiffResponse>, ApiError> {
    let resolved = resolve_project_worktree(&state, &project_id, &worktree_id).await?;
    let path = normalize_relative_path(&params.path)?;
    let original_path = params
        .original_path
        .as_deref()
        .map(normalize_relative_path)
        .transpose()?;
    let left_path = original_path.clone().unwrap_or_else(|| path.clone());
    let right_path = path.clone();
    let commit_id = match params.scope {
        GitDiffScope::Commit => Some(
            params
                .commit_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    ApiError::with_status(
                        StatusCode::BAD_REQUEST,
                        "commit_id is required for commit diffs.",
                    )
                })?
                .to_string(),
        ),
        GitDiffScope::Staged | GitDiffScope::Unstaged => None,
    };

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
        GitDiffScope::Commit => {
            load_commit_diff_side(
                &resolved.worktree.path,
                commit_id.as_deref().unwrap_or_default(),
                true,
                &left_path,
            )
            .await?
        }
    };
    let (right_content, modified_version_token) = match params.scope {
        GitDiffScope::Staged => (
            load_git_diff_side(
                &resolved.worktree.path,
                GitDiffBlobSource::Index,
                &right_path,
            )
            .await?,
            None,
        ),
        GitDiffScope::Unstaged => {
            let policy = WorktreePathPolicy::from_resolved(&resolved)
                .await
                .map_err(map_policy_build_error)?;
            let side = load_optional_worktree_diff_side(&policy, &right_path).await?;
            (side.content, side.version_token)
        }
        GitDiffScope::Commit => (
            load_commit_diff_side(
                &resolved.worktree.path,
                commit_id.as_deref().unwrap_or_default(),
                false,
                &right_path,
            )
            .await?,
            None,
        ),
    };

    let unsupported_reason = match (&left_content, &right_content) {
        (DiffSideContent::Unsupported(reason), _) => Some(reason.clone()),
        (_, DiffSideContent::Unsupported(reason)) => Some(reason.clone()),
        _ => None,
    };
    let editable = matches!(params.scope, GitDiffScope::Unstaged)
        && unsupported_reason.is_none()
        && modified_version_token.is_some();
    let language = infer_language(
        &path,
        preferred_diff_first_line(&right_content, &left_content),
    );

    Ok(Json(WorktreeGitDiffResponse {
        path,
        scope: params.scope,
        original_path,
        commit_id,
        left_label: match params.scope {
            GitDiffScope::Staged => "HEAD".to_string(),
            GitDiffScope::Unstaged => "Index".to_string(),
            GitDiffScope::Commit => "Parent".to_string(),
        },
        right_label: match params.scope {
            GitDiffScope::Staged => "Index".to_string(),
            GitDiffScope::Unstaged => "Working Tree".to_string(),
            GitDiffScope::Commit => "Commit".to_string(),
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
        read_only: !editable,
        modified_version_token: editable.then_some(modified_version_token).flatten(),
        unsupported_reason,
    }))
}

#[utoipa::path(
    post,
    path = "/api/projects/{id}/worktrees/{worktreeId}/files/rename",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktreeId" = String, Path, description = "Worktree ID"),
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
) -> Result<Json<RenameWorktreeFileResponse>, ApiError> {
    let resolved = resolve_project_worktree(&state, &project_id, &worktree_id).await?;

    let path = state
        .worktree_files
        .rename_entry(&resolved, &request.path, &request.new_name)
        .await
        .map_err(map_worktree_file_api_error)?;

    Ok(Json(RenameWorktreeFileResponse { path }))
}

async fn resolve_project_worktree(
    state: &AppState,
    project_id: &str,
    worktree_id: &str,
) -> Result<ResolvedWorktree, ApiError> {
    let resolved = resolve_worktree(state, worktree_id)
        .await
        .map_err(|error| {
            tracing::debug!(error = %error, "failed to resolve worktree for file request");
            map_status_to_file_error(error.status())
        })?
        .ok_or_else(|| ApiError::not_found("Project, worktree, or file not found."))?;
    if resolved.project_id != project_id {
        return Err(ApiError::not_found("Project, worktree, or file not found."));
    }
    Ok(resolved)
}

fn normalize_relative_path(raw: &str) -> Result<String, ApiError> {
    let trimmed = raw.trim_matches('/');
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err(ApiError::with_status(
            StatusCode::BAD_REQUEST,
            "Invalid path.",
        ));
    }

    let mut segments = Vec::new();
    for segment in trimmed.split('/') {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.contains('\\')
            || segment.contains(':')
        {
            return Err(ApiError::with_status(
                StatusCode::BAD_REQUEST,
                "Invalid path.",
            ));
        }
        segments.push(segment);
    }

    Ok(segments.join("/"))
}

async fn resolve_existing_file_path(
    policy: &WorktreePathPolicy,
    raw_path: &str,
) -> Result<(String, PathBuf), ApiError> {
    let path = normalize_relative_path(raw_path)?;
    let canonical = policy
        .resolve_existing(&path)
        .await
        .map_err(map_path_policy_error)?;
    Ok((path, canonical))
}

fn infer_language(path: &str, first_line: Option<&str>) -> String {
    let lowercase_path = path.to_ascii_lowercase();
    let filename = lowercase_path
        .rsplit('/')
        .next()
        .unwrap_or(lowercase_path.as_str());

    if let Some(association) = MONACO_FILENAME_ASSOCIATIONS
        .iter()
        .find(|association| association.filename == filename)
    {
        return association.language.to_string();
    }

    if let Some(association) = MONACO_EXTENSION_ASSOCIATIONS
        .iter()
        .find(|association| filename.ends_with(association.suffix))
    {
        return association.language.to_string();
    }

    if let Some(normalized_first_line) = normalize_first_line(first_line)
        && let Some(association) = MONACO_FIRST_LINE_ASSOCIATIONS
            .iter()
            .find(|association| first_line_rule_matches(association.rule, normalized_first_line))
    {
        return association.language.to_string();
    }

    "plaintext".to_string()
}

fn normalize_first_line(first_line: Option<&str>) -> Option<&str> {
    first_line
        .map(|line| line.strip_prefix('\u{feff}').unwrap_or(line))
        .filter(|line| !line.is_empty())
}

fn first_line_of_text(text: &str) -> Option<&str> {
    if text.is_empty() {
        return None;
    }

    Some(text.split('\n').next().unwrap_or(text))
}

fn diff_side_first_line(content: &DiffSideContent) -> Option<&str> {
    match content {
        DiffSideContent::Text(content) => first_line_of_text(content),
        DiffSideContent::Unsupported(_) => None,
    }
}

fn preferred_diff_first_line<'a>(
    right_content: &'a DiffSideContent,
    left_content: &'a DiffSideContent,
) -> Option<&'a str> {
    normalize_first_line(diff_side_first_line(right_content))
        .or_else(|| normalize_first_line(diff_side_first_line(left_content)))
}

fn shebang_tokens(first_line: &str) -> Option<impl Iterator<Item = &str>> {
    if !first_line.starts_with("#!") {
        return None;
    }

    Some(first_line.split(|character: char| {
        !character.is_ascii_alphanumeric()
            && character != '.'
            && character != '-'
            && character != '_'
    }))
}

fn matches_python_shebang_token(token: &str) -> bool {
    if token == "python" {
        return true;
    }

    token.strip_prefix("python").is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix
                .chars()
                .all(|character| character.is_ascii_digit() || character == '.' || character == '-')
    })
}

fn matches_node_shebang_token(token: &str) -> bool {
    token.starts_with("node")
}

fn first_line_rule_matches(rule: MonacoFirstLineRule, first_line: &str) -> bool {
    match rule {
        MonacoFirstLineRule::NodeShebang => shebang_tokens(first_line)
            .is_some_and(|mut tokens| tokens.any(matches_node_shebang_token)),
        MonacoFirstLineRule::PythonShebang => shebang_tokens(first_line)
            .is_some_and(|mut tokens| tokens.any(matches_python_shebang_token)),
        MonacoFirstLineRule::XmlLike => {
            let trimmed = first_line.trim_start();
            trimmed.starts_with("<?xml")
                || trimmed.starts_with("<svg")
                || trimmed.starts_with("<!doctype svg")
        }
    }
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

fn validate_existing_text_file_for_write(bytes: &[u8]) -> Result<(), ApiError> {
    std::str::from_utf8(bytes).map(|_| ()).map_err(|error| {
        tracing::warn!(error = %error, "file is not valid UTF-8");
        unsupported_file_error()
    })
}

async fn load_text_file(path: &Path, relative_path: &str) -> Result<LoadedTextFile, ApiError> {
    let metadata = fs::metadata(path).await.map_err(map_io_file_error)?;
    if !metadata.is_file() {
        return Err(ApiError::with_status(
            StatusCode::NOT_FOUND,
            "File not found.",
        ));
    }

    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Ok(LoadedTextFile {
            content: String::new(),
            version_token: version_token(&[], &metadata),
            language: infer_language(relative_path, None),
            read_only: true,
            unsupported_reason: Some("Files larger than 1 MiB are read-only.".to_string()),
        });
    }

    let bytes = fs::read(path).await.map_err(map_io_file_error)?;
    let content = match String::from_utf8(bytes.clone()) {
        Ok(content) => content,
        Err(_) => {
            return Ok(LoadedTextFile {
                content: String::new(),
                version_token: version_token(&bytes, &metadata),
                language: infer_language(relative_path, None),
                read_only: true,
                unsupported_reason: Some("Binary files are read-only.".to_string()),
            });
        }
    };

    Ok(LoadedTextFile {
        language: infer_language(relative_path, first_line_of_text(&content)),
        content,
        version_token: version_token(&bytes, &metadata),
        read_only: false,
        unsupported_reason: None,
    })
}

async fn write_worktree_file_atomically(
    path: &Path,
    original_metadata: &std::fs::Metadata,
    original_token: &str,
    contents: &[u8],
) -> Result<std::fs::Metadata, ApiError> {
    let temp_path = temp_worktree_file_path(path);
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp_path)
        .await
        .map_err(map_io_write_error)?;

    if let Err(error) = fs::set_permissions(&temp_path, original_metadata.permissions()).await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(map_io_write_error(error));
    }
    if let Err(error) = file.write_all(contents).await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(map_io_write_error(error));
    }
    if let Err(error) = file.flush().await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(map_io_write_error(error));
    }
    if let Err(error) = file.sync_all().await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(map_io_write_error(error));
    }
    drop(file);

    let current_metadata = match fs::metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) => {
            let _ = fs::remove_file(&temp_path).await;
            return Err(map_io_write_error(error));
        }
    };
    if !current_metadata.is_file() || current_metadata.len() > MAX_TEXT_FILE_BYTES {
        let _ = fs::remove_file(&temp_path).await;
        return Err(ApiError::conflict("File changed on disk."));
    }

    let current_bytes = match fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = fs::remove_file(&temp_path).await;
            return Err(map_io_write_error(error));
        }
    };
    if version_token(&current_bytes, &current_metadata) != original_token {
        let _ = fs::remove_file(&temp_path).await;
        return Err(ApiError::conflict("File changed on disk."));
    }

    if let Err(error) = fs::rename(&temp_path, path).await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(map_io_write_error(error));
    }
    if let Err(error) = sync_parent_directory(path).await {
        return Err(map_io_write_error(error));
    }

    fs::metadata(path).await.map_err(map_io_write_error)
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
) -> Result<DiffSideContent, ApiError> {
    match crate::git::read_diff_blob(Path::new(worktree_path), source, path, MAX_TEXT_FILE_BYTES)
        .await
        .map_err(|error| {
            tracing::warn!(error = ?error, "failed to read git diff blob");
            ApiError::with_status(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error.")
        })? {
        GitDiffBlobContent::Missing => Ok(DiffSideContent::Text(String::new())),
        GitDiffBlobContent::Text(content) => Ok(DiffSideContent::Text(content)),
        GitDiffBlobContent::Unsupported(reason) => Ok(DiffSideContent::Unsupported(reason)),
    }
}

async fn load_commit_diff_side(
    worktree_path: &str,
    commit_id: &str,
    use_parent: bool,
    path: &str,
) -> Result<DiffSideContent, ApiError> {
    match crate::git::read_commit_diff_blob(
        Path::new(worktree_path),
        commit_id,
        use_parent,
        path,
        MAX_TEXT_FILE_BYTES,
    )
    .await
    .map_err(|error| {
        tracing::warn!(error = ?error, "failed to read commit diff blob");
        match error {
            GitCommitDiffError::NotFound => {
                ApiError::with_status(StatusCode::NOT_FOUND, "Commit not found.")
            }
            GitCommitDiffError::Internal => {
                ApiError::with_status(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error.")
            }
        }
    })? {
        GitDiffBlobContent::Missing => Ok(DiffSideContent::Text(String::new())),
        GitDiffBlobContent::Text(content) => Ok(DiffSideContent::Text(content)),
        GitDiffBlobContent::Unsupported(reason) => Ok(DiffSideContent::Unsupported(reason)),
    }
}

async fn load_optional_worktree_diff_side(
    policy: &WorktreePathPolicy,
    path: &str,
) -> Result<OptionalWorktreeDiffSide, ApiError> {
    let path = normalize_relative_path(path)?;
    let canonical_candidate = match policy.resolve_optional(&path).await {
        Ok(Some(canonical_candidate)) => canonical_candidate,
        Ok(None) => {
            return Ok(OptionalWorktreeDiffSide {
                content: DiffSideContent::Text(String::new()),
                version_token: None,
            });
        }
        Err(error) => return Err(map_path_policy_error(error)),
    };

    let metadata = fs::metadata(&canonical_candidate)
        .await
        .map_err(map_io_file_error)?;
    if !metadata.is_file() {
        return Err(ApiError::with_status(
            StatusCode::NOT_FOUND,
            "Diff not found.",
        ));
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Ok(OptionalWorktreeDiffSide {
            content: DiffSideContent::Unsupported(
                "Diffs larger than 1 MiB are read-only.".to_string(),
            ),
            version_token: None,
        });
    }

    let bytes = match fs::read(&canonical_candidate).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(OptionalWorktreeDiffSide {
                content: DiffSideContent::Text(String::new()),
                version_token: None,
            });
        }
        Err(error) => return Err(map_io_file_error(error)),
    };

    match String::from_utf8(bytes) {
        Ok(content) => {
            let next_version_token = version_token(content.as_bytes(), &metadata);
            Ok(OptionalWorktreeDiffSide {
                content: DiffSideContent::Text(content),
                version_token: Some(next_version_token),
            })
        }
        Err(error) => {
            tracing::debug!(error = %error, "diff side is not valid UTF-8");
            Ok(OptionalWorktreeDiffSide {
                content: DiffSideContent::Unsupported(
                    "Binary diffs are not supported.".to_string(),
                ),
                version_token: None,
            })
        }
    }
}

fn map_status_to_file_error(status: StatusCode) -> ApiError {
    let message = match status {
        StatusCode::NOT_FOUND => "Project, worktree, or file not found.",
        StatusCode::FORBIDDEN => "Permission denied.",
        StatusCode::CONFLICT => "File changed on disk.",
        StatusCode::BAD_REQUEST => "Invalid path.",
        _ => "Internal server error.",
    };
    ApiError::with_status(status, message)
}

fn map_policy_build_error(error: WorktreePathPolicyError) -> ApiError {
    tracing::warn!(error = ?error, "failed to build worktree path policy");
    match error {
        WorktreePathPolicyError::NotFound => {
            ApiError::with_status(StatusCode::NOT_FOUND, "Project or worktree not found.")
        }
        WorktreePathPolicyError::PermissionDenied => {
            ApiError::with_status(StatusCode::FORBIDDEN, "Permission denied.")
        }
        WorktreePathPolicyError::Denied => {
            ApiError::with_status(StatusCode::FORBIDDEN, DISALLOWED_PATH_MESSAGE)
        }
        WorktreePathPolicyError::Internal => {
            ApiError::with_status(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error.")
        }
    }
}

fn map_path_policy_error(error: WorktreePathPolicyError) -> ApiError {
    tracing::warn!(error = ?error, "worktree path policy rejected path");
    match error {
        WorktreePathPolicyError::NotFound => {
            ApiError::with_status(StatusCode::NOT_FOUND, "File not found.")
        }
        WorktreePathPolicyError::PermissionDenied => {
            ApiError::with_status(StatusCode::FORBIDDEN, "Permission denied.")
        }
        WorktreePathPolicyError::Denied => {
            ApiError::with_status(StatusCode::FORBIDDEN, DISALLOWED_PATH_MESSAGE)
        }
        WorktreePathPolicyError::Internal => {
            ApiError::with_status(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error.")
        }
    }
}

fn map_io_file_error(error: std::io::Error) -> ApiError {
    tracing::warn!(error = %error, "file operation failed");
    match error.kind() {
        std::io::ErrorKind::NotFound => {
            ApiError::with_status(StatusCode::NOT_FOUND, "File not found.")
        }
        std::io::ErrorKind::PermissionDenied => {
            ApiError::with_status(StatusCode::FORBIDDEN, "Permission denied.")
        }
        _ => ApiError::with_status(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error."),
    }
}

fn map_io_write_error(error: std::io::Error) -> ApiError {
    tracing::warn!(error = %error, "file write operation failed");
    let status = match error.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
        std::io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    map_status_to_file_error(status)
}

fn map_worktree_file_api_error(error: crate::worktree_files::WorktreeFileError) -> ApiError {
    tracing::warn!(error = ?error, "worktree file operation failed");
    map_status_to_file_error(map_worktree_file_error(error))
}

fn unsupported_file_error() -> ApiError {
    ApiError::with_status(
        StatusCode::BAD_REQUEST,
        "Only editable text files can be saved.",
    )
}

#[cfg(test)]
mod tests {
    use super::infer_language;

    #[test]
    fn infer_language_matches_monaco_extensions() {
        assert_eq!(infer_language("notes.mdx", None), "mdx");
        assert_eq!(infer_language("package.json", None), "json");
        assert_eq!(infer_language("schema.proto", None), "proto");
        assert_eq!(infer_language("script.ps1", None), "powershell");
        assert_eq!(infer_language("main.tf", None), "hcl");
        assert_eq!(infer_language("main.tfvars", None), "hcl");
        assert_eq!(infer_language("header.h", None), "c");
        assert_eq!(infer_language("main.c", None), "c");
        assert_eq!(infer_language("main.cpp", None), "cpp");
        assert_eq!(infer_language("main.cc", None), "cpp");
        assert_eq!(infer_language("main.cxx", None), "cpp");
        assert_eq!(infer_language("main.hpp", None), "cpp");
        assert_eq!(infer_language("main.hh", None), "cpp");
        assert_eq!(infer_language("main.hxx", None), "cpp");
        assert_eq!(infer_language("app.rb", None), "ruby");
        assert_eq!(infer_language("app.kt", None), "kotlin");
        assert_eq!(infer_language("app.swift", None), "swift");
        assert_eq!(infer_language("query.graphql", None), "graphql");
        assert_eq!(infer_language("shader.wgsl", None), "wgsl");
        assert_eq!(infer_language("config.dockerfile", None), "dockerfile");
    }

    #[test]
    fn infer_language_matches_monaco_filenames() {
        assert_eq!(infer_language("Dockerfile", None), "dockerfile");
        assert_eq!(infer_language("Gemfile", None), "ruby");
        assert_eq!(infer_language(".editorconfig", None), "ini");
        assert_eq!(infer_language(".gitconfig", None), "ini");
        assert_eq!(infer_language("jakefile", None), "javascript");
    }

    #[test]
    fn infer_language_matches_monaco_first_line_rules() {
        assert_eq!(
            infer_language("script", Some("#!/usr/bin/env node")),
            "javascript"
        );
        assert_eq!(
            infer_language("script", Some("#!/usr/bin/env nodejs")),
            "javascript"
        );
        assert_eq!(
            infer_language("script", Some("#!/usr/bin/python3")),
            "python"
        );
        assert_eq!(
            infer_language("layout", Some("<?xml version=\"1.0\"")),
            "xml"
        );
        assert_eq!(
            infer_language("vector", Some("<svg viewBox=\"0 0 10 10\">")),
            "xml"
        );
        assert_eq!(
            infer_language("script", Some("#!/usr/bin/env antinode")),
            "plaintext"
        );
        assert_eq!(
            infer_language("script", Some("#!/usr/bin/env pythontool")),
            "plaintext"
        );
    }

    #[test]
    fn infer_language_falls_back_to_plaintext() {
        assert_eq!(infer_language("notes.unknown", None), "plaintext");
    }

    #[test]
    fn infer_language_uses_last_registered_duplicate_suffix() {
        assert_eq!(infer_language("policy.pp", None), "ruby");
    }
}
