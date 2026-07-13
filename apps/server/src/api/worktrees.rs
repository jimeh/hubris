use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utoipa::{IntoParams, ToSchema};

use crate::api::errors::map_worktree_file_error;
use crate::api::projects::Project;
use crate::api::settings::{Settings, WorktreeLocationMode};
pub use crate::domain::worktree::ResolvedWorktree;
use crate::domain::worktree::{
    ManagedWorktree, ProjectMeta, load_meta, local_worktree_id, normalize_meta,
};
pub use crate::domain::worktree::{Worktree, WorktreeUiMode, list_worktrees_for_project};
use crate::error::ApiError;
use crate::events::EventKind;
use crate::git;
use crate::state::AppState;
use crate::worktree_state::WorktreeRestoreState;

pub use hubris_git::{GitCommitPerson, GitCommitSummary, GitFileChange, GitFileChangeType};

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListWorktreesResponse {
    pub worktrees: Vec<Worktree>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct StartPoint {
    pub value: String,
    pub sha: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_ref: Option<String>,
    pub remote_refs: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListWorktreeStartPointsResponse {
    pub start_points: Vec<StartPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_start_point: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_error: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeRequest {
    pub branch: String,
    #[serde(default)]
    pub start_point: Option<String>,
    #[serde(default)]
    pub source_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportableWorktree {
    pub id: String,
    pub path: String,
    pub branch: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListImportableWorktreesResponse {
    pub importable_worktrees: Vec<ImportableWorktree>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_error: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportWorktreeRequest {
    pub path: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReorderWorktreesRequest {
    pub worktree_ids: Vec<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorktreeRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub source_ref: Option<String>,
    #[serde(default)]
    pub ui_mode: Option<WorktreeUiMode>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorktreeRestoreStateRequest {
    #[serde(default)]
    pub active_tab_id: Option<String>,
    #[serde(default)]
    pub focused_pane_id: Option<String>,
    #[serde(default)]
    pub pane_mru: Option<Vec<String>>,
    #[serde(default)]
    pub tab_mru_by_pane: Option<HashMap<String, Vec<String>>>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenameWorktreeBranchRequest {
    pub new_branch: String,
}

#[derive(Debug, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct DeleteWorktreeParams {
    #[serde(default)]
    pub force: bool,
    // The pre-camelCase spelling stays accepted as an alias: this flag
    // separates "untrack" from "delete the worktree directory", and a
    // stale client whose `untrack_only=true` was silently dropped by
    // the `#[serde(default)]` would fall into the destructive branch.
    #[serde(default, alias = "untrack_only")]
    pub untrack_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetailsResponse {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    pub message: String,
    pub author: GitCommitPerson,
    pub committer: GitCommitPerson,
    pub files: Vec<GitFileChange>,
}

#[derive(Debug, Clone, Serialize, ToSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeGitStatusResponse {
    pub generation: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
    pub unstaged_files: Vec<GitFileChange>,
    pub staged_files: Vec<GitFileChange>,
    pub ahead_count: usize,
    pub ahead_commits: Vec<GitCommitSummary>,
    pub comparison_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comparison_error: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeGitPathActionRequest {
    /// Relative path from the worktree root.
    pub path: String,
    /// Original relative path for rename/copy actions.
    #[serde(default)]
    pub original_path: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum GitPathAction {
    Stage,
    Unstage,
    Discard,
}

async fn save_meta(state: &AppState, project_id: &str, meta: &ProjectMeta) -> Result<(), ApiError> {
    let dir = state.project_meta_dir();
    tokio::fs::create_dir_all(&dir).await.map_err(|error| {
        tracing::warn!(error = %error, "failed to create project metadata directory");
        ApiError::internal("Internal server error.")
    })?;
    let path = state.project_meta_file(project_id);
    let body = serde_json::to_string_pretty(meta).map_err(|error| {
        tracing::warn!(error = %error, "failed to serialize project metadata");
        ApiError::internal("Internal server error.")
    })?;
    tokio::fs::write(path, body).await.map_err(|error| {
        tracing::warn!(error = %error, "failed to write project metadata");
        ApiError::internal("Internal server error.")
    })
}

fn sanitize_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "repo".to_string()
    } else {
        trimmed.to_string()
    }
}

fn validate_branch(branch: &str) -> bool {
    if branch.is_empty() || branch.starts_with('-') {
        return false;
    }
    for seg in branch.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return false;
        }
    }
    !branch.chars().any(|c| c.is_ascii_control() || c == '\\')
}

fn resolve_target_path(
    state: &AppState,
    project: &Project,
    branch: &str,
    settings: &Settings,
) -> PathBuf {
    let mut branch_path = PathBuf::new();
    for seg in branch.split('/') {
        branch_path = branch_path.join(seg);
    }

    if settings.worktree.location_mode == WorktreeLocationMode::RepoLocalDotHubris {
        PathBuf::from(&project.path)
            .join(".hubris")
            .join("worktrees")
            .join(branch_path)
    } else {
        state
            .data_dir
            .join("worktrees")
            .join(sanitize_segment(&project.name))
            .join(branch_path)
    }
}

fn is_missing_worktree_error(message: &str) -> bool {
    let message = message.to_lowercase();
    message.contains("not a working tree")
        || message.contains("worktree not found")
        || message.contains("does not exist")
        || message.contains("cannot find")
}

pub async fn resolve_worktree(
    state: &AppState,
    worktree_id: &str,
) -> Result<Option<ResolvedWorktree>, ApiError> {
    if let Some(project_id) = state.project_id_for_worktree(worktree_id) {
        if let Some(project) = state.projects.get(&project_id).await {
            let worktrees = list_worktrees_for_project(state, &project).await;

            if let Some(worktree) = worktrees.into_iter().find(|w| w.id == worktree_id) {
                return Ok(Some(ResolvedWorktree {
                    project_id: project.id.clone(),
                    local_root: PathBuf::from(&project.path),
                    worktree,
                }));
            }
        }

        state
            .project_id_by_worktree
            .remove_if(worktree_id, |_, cached_project_id| {
                cached_project_id == &project_id
            });
    }

    let projects = state.projects.list().await;

    for project in projects {
        let worktrees = list_worktrees_for_project(state, &project).await;

        if let Some(worktree) = worktrees.into_iter().find(|w| w.id == worktree_id) {
            let local_root = PathBuf::from(&project.path);
            state.remember_worktree_project(&worktree.id, &project.id);
            return Ok(Some(ResolvedWorktree {
                project_id: project.id.clone(),
                local_root,
                worktree,
            }));
        }
    }

    Ok(None)
}

pub async fn close_tabs_for_worktree(state: &AppState, worktree_id: &str) -> Result<(), ApiError> {
    state
        .tabs_service
        .close_tabs_for_worktree(state, worktree_id)
        .await
}

fn normalize_restore_state(
    state: &AppState,
    worktree_id: &str,
    request: UpdateWorktreeRestoreStateRequest,
) -> WorktreeRestoreState {
    let restore_state = WorktreeRestoreState {
        active_tab_id: request.active_tab_id,
        focused_pane_id: request.focused_pane_id,
        pane_mru: request.pane_mru.unwrap_or_default(),
        tab_mru_by_pane: request.tab_mru_by_pane.unwrap_or_default(),
    };
    state
        .tabs_service
        .normalize_restore_state(worktree_id, restore_state)
}

#[utoipa::path(
    put,
    path = "/api/projects/{id}/worktrees/{worktreeId}/restore-state",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktreeId" = String, Path, description = "Worktree ID"),
    ),
    request_body = UpdateWorktreeRestoreStateRequest,
    responses(
        (status = 204, description = "Worktree restore state updated"),
        (status = 404, description = "Worktree not found"),
    ),
)]
pub async fn put_worktree_restore_state(
    State(state): State<AppState>,
    Path((project_id, worktree_id)): Path<(String, String)>,
    Json(request): Json<UpdateWorktreeRestoreStateRequest>,
) -> Result<StatusCode, ApiError> {
    match resolve_worktree(&state, &worktree_id).await? {
        Some(resolved) if resolved.project_id == project_id => {}
        _ => return Err(ApiError::not_found("Worktree not found.")),
    }

    state.remember_worktree_project(&worktree_id, &project_id);
    let restore_state = normalize_restore_state(&state, &worktree_id, request);
    state
        .tabs_service
        .set_restore_state(worktree_id.clone(), restore_state.clone());
    state
        .persistence
        .update_restore_state(project_id, worktree_id, restore_state);

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/api/projects/{id}/worktrees",
    params(
        ("id" = String, Path, description = "Project ID"),
    ),
    responses(
        (status = 200, description = "Project worktrees", body = ListWorktreesResponse),
        (status = 404, description = "Project not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn list_project_worktrees(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<ListWorktreesResponse>, ApiError> {
    let projects = state.projects.list().await;
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| ApiError::not_found("Project or worktree not found."))?;

    let worktrees = list_worktrees_for_project(&state, project).await;
    Ok(Json(ListWorktreesResponse {
        worktrees,
        git_error: None,
    }))
}

#[utoipa::path(
    patch,
    path = "/api/projects/{id}/worktrees/{worktreeId}",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktreeId" = String, Path, description = "Worktree ID"),
    ),
    request_body = UpdateWorktreeRequest,
    responses(
        (status = 200, description = "Worktree updated", body = Worktree),
        (status = 404, description = "Project or worktree not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn update_project_worktree(
    State(state): State<AppState>,
    Path((project_id, worktree_id)): Path<(String, String)>,
    Json(req): Json<UpdateWorktreeRequest>,
) -> Result<Json<Worktree>, ApiError> {
    let projects = state.projects.list().await;
    let project = projects
        .iter()
        .find(|project| project.id == project_id)
        .ok_or_else(|| ApiError::not_found("Project or worktree not found."))?;
    let local_worktree_id = local_worktree_id(project);

    let worktrees = list_worktrees_for_project(&state, project).await;
    if !worktrees.iter().any(|worktree| worktree.id == worktree_id) {
        return Err(ApiError::not_found("Project or worktree not found."));
    }

    let mut meta = load_meta(state.project_meta_file(&project.id)).await;
    if let Some(name) = &req.name {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(ApiError::bad_request("Invalid worktree request."));
        }
        if let Some(managed) = meta
            .managed_worktrees
            .iter_mut()
            .find(|wt| wt.id == worktree_id)
        {
            managed.name = Some(trimmed.to_string());
        }
    }
    if let Some(source_ref) = &req.source_ref
        && let Some(managed) = meta
            .managed_worktrees
            .iter_mut()
            .find(|wt| wt.id == worktree_id)
    {
        let trimmed = source_ref.trim();
        managed.source_ref = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
        state.worktree_files.evict_tracker(&worktree_id);
    }
    if let Some(ui_mode) = req.ui_mode {
        meta.worktree_ui_modes.insert(worktree_id.clone(), ui_mode);
    }
    normalize_meta(&mut meta, &local_worktree_id);
    save_meta(&state, &project.id, &meta).await?;

    let updated_worktrees = list_worktrees_for_project(&state, project).await;
    let updated_worktree = updated_worktrees
        .iter()
        .find(|worktree| worktree.id == worktree_id)
        .cloned()
        .ok_or_else(|| ApiError::not_found("Project or worktree not found."))?;

    state.events.emit(EventKind::ProjectWorktreesUpdated {
        project_id: project.id.clone(),
        worktrees: updated_worktrees,
        git_error: None,
    });

    Ok(Json(updated_worktree))
}

#[utoipa::path(
    post,
    path = "/api/projects/{id}/worktrees",
    params(
        ("id" = String, Path, description = "Project ID"),
    ),
    request_body = CreateWorktreeRequest,
    responses(
        (status = 201, description = "Worktree created", body = Worktree),
        (status = 400, description = "Invalid request"),
        (status = 404, description = "Project not found"),
        (status = 409, description = "Worktree creation conflict"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn create_project_worktree(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(req): Json<CreateWorktreeRequest>,
) -> Result<(StatusCode, Json<Worktree>), ApiError> {
    let branch = req.branch.trim();
    let start_point = req
        .start_point
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let source_ref = req
        .source_ref
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if !validate_branch(branch) {
        return Err(ApiError::bad_request("Invalid worktree request."));
    }

    let projects = state.projects.list().await;
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| ApiError::not_found("Project or worktree not found."))?;

    let local_root = git::resolve_local_root(PathBuf::from(&project.path).as_path())
        .await
        .map_err(|error| {
            tracing::warn!(error = %error, "failed to resolve project git root");
            ApiError::bad_request("Invalid worktree request.")
        })?;

    let settings = state.settings.get().await.settings;
    let target = resolve_target_path(&state, project, branch, &settings);

    git::create_worktree(&local_root, branch, &target, start_point)
        .await
        .map_err(|error| {
            tracing::warn!(error = %error, "failed to create worktree");
            ApiError::conflict("Worktree creation conflict.")
        })?;

    let canonical_target = tokio::fs::canonicalize(&target).await.unwrap_or(target);
    let created_id = git::worktree_id(&canonical_target);
    let created_path = canonical_target.to_string_lossy().to_string();
    let created = Worktree {
        id: created_id.clone(),
        project_id: project.id.clone(),
        name: branch.to_string(),
        path: created_path.clone(),
        branch: branch.to_string(),
        source_ref: source_ref.clone(),
        ui_mode: WorktreeUiMode::default(),
        is_local: false,
        is_imported: false,
        missing_on_disk: false,
        position: 0.0,
    };

    let mut meta = load_meta(state.project_meta_file(&project.id)).await;
    meta.managed_worktrees.retain(|wt| wt.id != created_id);
    meta.managed_worktrees.push(ManagedWorktree {
        id: created.id.clone(),
        path: created.path.clone(),
        branch: created.branch.clone(),
        name: Some(created.name.clone()),
        source_ref,
        imported: false,
    });
    meta.worktree_order.retain(|id| id != &created.id);
    meta.worktree_order.insert(0, created.id.clone());
    normalize_meta(&mut meta, &local_worktree_id(project));
    save_meta(&state, &project.id, &meta).await?;

    let list = list_worktrees_for_project(&state, project).await;

    state
        .events
        .emit(EventKind::WorktreeCreated(created.clone()));
    state.events.emit(EventKind::ProjectWorktreesUpdated {
        project_id: project.id.clone(),
        worktrees: list,
        git_error: None,
    });

    Ok((StatusCode::CREATED, Json(created)))
}

#[utoipa::path(
    get,
    path = "/api/projects/{id}/worktrees/{worktreeId}/git-status",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktreeId" = String, Path, description = "Worktree ID"),
    ),
    responses(
        (
            status = 200,
            description = "Git status for a worktree",
            body = WorktreeGitStatusResponse
        ),
        (status = 404, description = "Project or worktree not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn get_project_worktree_git_status(
    State(state): State<AppState>,
    Path((project_id, worktree_id)): Path<(String, String)>,
) -> Result<Json<WorktreeGitStatusResponse>, ApiError> {
    let resolved = resolve_worktree(&state, &worktree_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Project or worktree not found."))?;
    if resolved.project_id != project_id {
        return Err(ApiError::not_found("Project or worktree not found."));
    }
    let (generation, status) = state
        .worktree_files
        .read_git_status(&resolved)
        .await
        .map_err(|error| {
            tracing::warn!(error = ?error, "failed to read worktree git status");
            ApiError::internal("Internal server error.")
        })?;

    Ok(Json(WorktreeGitStatusResponse {
        generation,
        source_ref: resolved.worktree.source_ref,
        unstaged_files: status.unstaged_files,
        staged_files: status.staged_files,
        ahead_count: status.ahead_count,
        ahead_commits: status.ahead_commits,
        comparison_available: status.comparison_available,
        comparison_error: status.comparison_error,
    }))
}

#[utoipa::path(
    get,
    path = "/api/projects/{id}/worktrees/{worktreeId}/git/commits/{commitId}",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktreeId" = String, Path, description = "Worktree ID"),
        ("commitId" = String, Path, description = "Commit SHA"),
    ),
    responses(
        (
            status = 200,
            description = "Commit details for a worktree commit",
            body = GitCommitDetailsResponse
        ),
        (status = 404, description = "Project, worktree, or commit not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn get_project_worktree_commit_details(
    State(state): State<AppState>,
    Path((project_id, worktree_id, commit_id)): Path<(String, String, String)>,
) -> Result<Json<GitCommitDetailsResponse>, ApiError> {
    let resolved = resolve_worktree(&state, &worktree_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Project or worktree not found."))?;
    if resolved.project_id != project_id {
        return Err(ApiError::not_found("Project or worktree not found."));
    }

    let details =
        git::read_commit_details(std::path::Path::new(&resolved.worktree.path), &commit_id)
            .await
            .map_err(|error| {
                tracing::warn!(error = ?error, "failed to read worktree commit details");
                match error {
                    git::GitCommitDetailsError::NotFound => {
                        ApiError::not_found("Commit not found.")
                    }
                    git::GitCommitDetailsError::Internal => {
                        ApiError::internal("Internal server error.")
                    }
                }
            })?;

    Ok(Json(GitCommitDetailsResponse {
        id: details.id,
        short_id: details.short_id,
        summary: details.summary,
        message: details.message,
        author: GitCommitPerson {
            name: details.author.name,
            email: details.author.email,
            date: details.author.date,
        },
        committer: GitCommitPerson {
            name: details.committer.name,
            email: details.committer.email,
            date: details.committer.date,
        },
        files: details.files,
    }))
}

#[utoipa::path(
    post,
    path = "/api/projects/{id}/worktrees/{worktreeId}/git/stage",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktreeId" = String, Path, description = "Worktree ID"),
    ),
    request_body = WorktreeGitPathActionRequest,
    responses(
        (status = 204, description = "Path staged"),
        (status = 400, description = "Invalid relative path"),
        (status = 403, description = "Permission denied"),
        (status = 404, description = "Project, worktree, or path not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn stage_project_worktree_path(
    State(state): State<AppState>,
    Path((project_id, worktree_id)): Path<(String, String)>,
    Json(request): Json<WorktreeGitPathActionRequest>,
) -> Result<StatusCode, ApiError> {
    perform_git_path_action(
        state,
        project_id,
        worktree_id,
        &request.path,
        request.original_path.as_deref(),
        GitPathAction::Stage,
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/projects/{id}/worktrees/{worktreeId}/git/unstage",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktreeId" = String, Path, description = "Worktree ID"),
    ),
    request_body = WorktreeGitPathActionRequest,
    responses(
        (status = 204, description = "Path unstaged"),
        (status = 400, description = "Invalid relative path"),
        (status = 403, description = "Permission denied"),
        (status = 404, description = "Project, worktree, or path not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn unstage_project_worktree_path(
    State(state): State<AppState>,
    Path((project_id, worktree_id)): Path<(String, String)>,
    Json(request): Json<WorktreeGitPathActionRequest>,
) -> Result<StatusCode, ApiError> {
    perform_git_path_action(
        state,
        project_id,
        worktree_id,
        &request.path,
        request.original_path.as_deref(),
        GitPathAction::Unstage,
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/projects/{id}/worktrees/{worktreeId}/git/discard",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktreeId" = String, Path, description = "Worktree ID"),
    ),
    request_body = WorktreeGitPathActionRequest,
    responses(
        (status = 204, description = "Worktree changes discarded for the path"),
        (status = 400, description = "Invalid relative path"),
        (status = 403, description = "Permission denied"),
        (status = 404, description = "Project, worktree, or path not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn discard_project_worktree_path(
    State(state): State<AppState>,
    Path((project_id, worktree_id)): Path<(String, String)>,
    Json(request): Json<WorktreeGitPathActionRequest>,
) -> Result<StatusCode, ApiError> {
    perform_git_path_action(
        state,
        project_id,
        worktree_id,
        &request.path,
        request.original_path.as_deref(),
        GitPathAction::Discard,
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/projects/{id}/worktrees/{worktreeId}/git/rename-branch",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktreeId" = String, Path, description = "Worktree ID"),
    ),
    request_body = RenameWorktreeBranchRequest,
    responses(
        (status = 200, description = "Branch renamed", body = Worktree),
        (status = 400, description = "Invalid branch name"),
        (status = 404, description = "Project or worktree not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn rename_worktree_branch(
    State(state): State<AppState>,
    Path((project_id, worktree_id)): Path<(String, String)>,
    Json(req): Json<RenameWorktreeBranchRequest>,
) -> Result<Json<Worktree>, ApiError> {
    let new_branch = req.new_branch.trim().to_string();
    if !validate_branch(&new_branch) {
        return Err(ApiError::bad_request("Invalid worktree request."));
    }

    let projects = state.projects.list().await;
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| ApiError::not_found("Project or worktree not found."))?;
    let local_worktree_id = local_worktree_id(project);

    let worktrees = list_worktrees_for_project(&state, project).await;
    let worktree = worktrees
        .iter()
        .find(|w| w.id == worktree_id)
        .ok_or_else(|| ApiError::not_found("Project or worktree not found."))?;

    if worktree.is_local {
        return Err(ApiError::bad_request("Invalid worktree request."));
    }

    let old_branch = worktree.branch.clone();
    let worktree_path = PathBuf::from(&worktree.path);
    git::rename_branch(&worktree_path, &new_branch)
        .await
        .map_err(|error| {
            tracing::warn!(error = %error, "failed to rename worktree branch");
            ApiError::internal("Internal server error.")
        })?;

    let mut meta = load_meta(state.project_meta_file(&project.id)).await;
    let previous_meta = meta.clone();
    if let Some(managed) = meta
        .managed_worktrees
        .iter_mut()
        .find(|wt| wt.id == worktree_id)
    {
        if managed.name.as_deref() == Some(managed.branch.as_str()) {
            managed.name = Some(new_branch.clone());
        }
        managed.branch = new_branch.clone();
    }
    normalize_meta(&mut meta, &local_worktree_id);
    save_meta(&state, &project.id, &meta).await?;

    if let Err(error) = state
        .chats
        .rename_project_branch(&project.id, &old_branch, &new_branch)
        .await
    {
        tracing::warn!(error = %error, "failed to rename chat branch");
        let _ = git::rename_branch(&worktree_path, &old_branch).await;
        let _ = save_meta(&state, &project.id, &previous_meta).await;
        return Err(ApiError::internal("Internal server error."));
    }

    state.worktree_files.evict_tracker(&worktree_id);

    let updated_worktrees = list_worktrees_for_project(&state, project).await;
    let updated_worktree = updated_worktrees
        .iter()
        .find(|w| w.id == worktree_id)
        .cloned()
        .ok_or_else(|| ApiError::not_found("Project or worktree not found."))?;

    state.events.emit(EventKind::ProjectWorktreesUpdated {
        project_id: project.id.clone(),
        worktrees: updated_worktrees,
        git_error: None,
    });

    Ok(Json(updated_worktree))
}

async fn perform_git_path_action(
    state: AppState,
    project_id: String,
    worktree_id: String,
    path: &str,
    original_path: Option<&str>,
    action: GitPathAction,
) -> Result<StatusCode, ApiError> {
    let resolved = resolve_worktree(&state, &worktree_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Project or worktree not found."))?;
    if resolved.project_id != project_id {
        return Err(ApiError::not_found("Project or worktree not found."));
    }

    let worktree_path = PathBuf::from(&resolved.worktree.path);
    let paths = match action {
        GitPathAction::Stage => git::stage_worktree_path(&worktree_path, path, original_path).await,
        GitPathAction::Unstage => {
            git::unstage_worktree_path(&worktree_path, path, original_path).await
        }
        GitPathAction::Discard => git::discard_worktree_path(&worktree_path, path).await,
    }
    .map_err(map_git_path_action_error)?;

    if let Some(original_path) = original_path {
        state
            .worktree_files
            .record_git_rewrite_hint(&resolved, path, original_path)
            .await
            .map_err(map_worktree_file_api_error)?;
    }

    state
        .worktree_files
        .invalidate_relative_paths(&resolved, &paths)
        .await
        .map_err(map_worktree_file_api_error)?;

    Ok(StatusCode::NO_CONTENT)
}

fn map_git_path_action_error(error: git::GitPathActionError) -> ApiError {
    tracing::warn!(error = ?error, "worktree git path action failed");
    let status = match error {
        git::GitPathActionError::InvalidPath => StatusCode::BAD_REQUEST,
        git::GitPathActionError::Conflict => StatusCode::CONFLICT,
        git::GitPathActionError::NotFound => StatusCode::NOT_FOUND,
        git::GitPathActionError::PermissionDenied => StatusCode::FORBIDDEN,
        git::GitPathActionError::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    };
    ApiError::with_status(status, "Worktree operation failed.")
}

fn map_worktree_file_api_error(error: crate::worktree_files::WorktreeFileError) -> ApiError {
    tracing::warn!(error = ?error, "worktree file operation failed");
    ApiError::with_status(
        map_worktree_file_error(error),
        "Worktree file operation failed.",
    )
}

#[utoipa::path(
    get,
    path = "/api/projects/{id}/worktrees/start-points",
    params(
        ("id" = String, Path, description = "Project ID"),
    ),
    responses(
        (
            status = 200,
            description = "Candidate worktree start points",
            body = ListWorktreeStartPointsResponse
        ),
        (status = 404, description = "Project not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn list_project_worktree_start_points(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<ListWorktreeStartPointsResponse>, ApiError> {
    let projects = state.projects.list().await;
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| ApiError::not_found("Project or worktree not found."))?;

    let local_root = match git::resolve_local_root(PathBuf::from(&project.path).as_path()).await {
        Ok(root) => root,
        Err(err) => {
            return Ok(Json(ListWorktreeStartPointsResponse {
                start_points: vec![],
                default_start_point: None,
                git_error: Some(err.message),
            }));
        }
    };

    let default_start_point = git::current_branch(&local_root).await.ok().flatten();
    match git::list_branch_start_points(&local_root).await {
        Ok(start_points) => {
            let mut by_sha: HashMap<String, (Vec<String>, Vec<String>, i64)> = HashMap::new();
            for start_point in start_points {
                let entry = by_sha
                    .entry(start_point.sha)
                    .or_insert_with(|| (Vec::new(), Vec::new(), i64::MIN));
                entry.2 = entry.2.max(start_point.commit_timestamp);
                match start_point.kind {
                    git::GitStartPointKind::Local => {
                        if !entry.0.contains(&start_point.name) {
                            entry.0.push(start_point.name);
                        }
                    }
                    git::GitStartPointKind::Remote => {
                        if !entry.1.contains(&start_point.name) {
                            entry.1.push(start_point.name);
                        }
                    }
                }
            }

            let mut grouped: Vec<(StartPoint, i64)> = Vec::new();
            for (sha, (mut local_refs, mut remote_refs, commit_timestamp)) in by_sha {
                local_refs.sort();
                remote_refs.sort();

                if !local_refs.is_empty() {
                    for local_ref in local_refs {
                        grouped.push((
                            StartPoint {
                                value: local_ref.clone(),
                                sha: sha.clone(),
                                local_ref: Some(local_ref),
                                remote_refs: remote_refs.clone(),
                            },
                            commit_timestamp,
                        ));
                    }
                    continue;
                }

                if let Some(first_remote) = remote_refs.first().cloned() {
                    grouped.push((
                        StartPoint {
                            value: first_remote,
                            sha,
                            local_ref: None,
                            remote_refs,
                        },
                        commit_timestamp,
                    ));
                }
            }

            grouped.sort_by(|(a, a_ts), (b, b_ts)| {
                b_ts.cmp(a_ts)
                    .then_with(|| match (&a.local_ref, &b.local_ref) {
                        (Some(a_local), Some(b_local)) => a_local.cmp(b_local),
                        (Some(_), None) => Ordering::Less,
                        (None, Some(_)) => Ordering::Greater,
                        (None, None) => {
                            let a_first_remote = a.remote_refs.first().unwrap_or(&a.value);
                            let b_first_remote = b.remote_refs.first().unwrap_or(&b.value);
                            a_first_remote.cmp(b_first_remote)
                        }
                    })
            });

            let grouped: Vec<StartPoint> = grouped.into_iter().map(|(sp, _)| sp).collect();

            Ok(Json(ListWorktreeStartPointsResponse {
                start_points: grouped,
                default_start_point,
                git_error: None,
            }))
        }
        Err(err) => Ok(Json(ListWorktreeStartPointsResponse {
            start_points: vec![],
            default_start_point,
            git_error: Some(err.message),
        })),
    }
}

#[utoipa::path(
    put,
    path = "/api/projects/{id}/worktrees/reorder",
    params(
        ("id" = String, Path, description = "Project ID"),
    ),
    request_body = ReorderWorktreesRequest,
    responses(
        (status = 200, description = "Worktrees reordered", body = [Worktree]),
        (status = 400, description = "Invalid reorder payload"),
        (status = 404, description = "Project not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn reorder_project_worktrees(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(req): Json<ReorderWorktreesRequest>,
) -> Result<Json<Vec<Worktree>>, ApiError> {
    let projects = state.projects.list().await;
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| ApiError::not_found("Project or worktree not found."))?;

    let worktrees = list_worktrees_for_project(&state, project).await;

    let non_local_ids: Vec<String> = worktrees
        .iter()
        .filter(|wt| !wt.is_local)
        .map(|wt| wt.id.clone())
        .collect();

    if non_local_ids.len() != req.worktree_ids.len() {
        return Err(ApiError::bad_request("Invalid worktree request."));
    }

    let expected: HashSet<String> = non_local_ids.into_iter().collect();
    let received: HashSet<String> = req.worktree_ids.iter().cloned().collect();
    if expected != received {
        return Err(ApiError::bad_request("Invalid worktree request."));
    }

    let mut meta = load_meta(state.project_meta_file(&project.id)).await;
    meta.worktree_order = req.worktree_ids.clone();
    normalize_meta(&mut meta, &local_worktree_id(project));
    save_meta(&state, &project.id, &meta).await?;

    let reordered = list_worktrees_for_project(&state, project).await;

    state.events.emit(EventKind::WorktreesReordered {
        project_id: project.id.clone(),
        worktrees: reordered.clone(),
    });

    Ok(Json(reordered))
}

#[utoipa::path(
    get,
    path = "/api/projects/{id}/worktrees/importable",
    params(
        ("id" = String, Path, description = "Project ID"),
    ),
    responses(
        (status = 200, description = "Importable worktrees", body = ListImportableWorktreesResponse),
        (status = 404, description = "Project not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn list_importable_worktrees(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<ListImportableWorktreesResponse>, ApiError> {
    let projects = state.projects.list().await;
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| ApiError::not_found("Project or worktree not found."))?;

    let local_root = match git::resolve_local_root(PathBuf::from(&project.path).as_path()).await {
        Ok(root) => root,
        Err(err) => {
            return Ok(Json(ListImportableWorktreesResponse {
                importable_worktrees: vec![],
                git_error: Some(err.message),
            }));
        }
    };

    let git_worktrees = match git::list_worktrees(&local_root).await {
        Ok(list) => list,
        Err(err) => {
            return Ok(Json(ListImportableWorktreesResponse {
                importable_worktrees: vec![],
                git_error: Some(err.message),
            }));
        }
    };

    let meta = load_meta(state.project_meta_file(&project.id)).await;
    let local_path = tokio::fs::canonicalize(&project.path)
        .await
        .unwrap_or_else(|_| PathBuf::from(&project.path));
    let mut managed_paths: HashSet<PathBuf> = HashSet::new();
    for wt in &meta.managed_worktrees {
        let p = tokio::fs::canonicalize(&wt.path)
            .await
            .unwrap_or_else(|_| PathBuf::from(&wt.path));
        managed_paths.insert(p);
    }

    let mut importable = Vec::new();
    for git_wt in &git_worktrees {
        let canonical = tokio::fs::canonicalize(&git_wt.path)
            .await
            .unwrap_or_else(|_| git_wt.path.clone());
        if canonical == local_path || managed_paths.contains(&canonical) {
            continue;
        }
        importable.push(ImportableWorktree {
            id: git::worktree_id(&canonical),
            path: canonical.to_string_lossy().to_string(),
            branch: git_wt.branch.clone(),
        });
    }

    Ok(Json(ListImportableWorktreesResponse {
        importable_worktrees: importable,
        git_error: None,
    }))
}

#[utoipa::path(
    post,
    path = "/api/projects/{id}/worktrees/import",
    params(
        ("id" = String, Path, description = "Project ID"),
    ),
    request_body = ImportWorktreeRequest,
    responses(
        (status = 201, description = "Worktree imported", body = Worktree),
        (status = 400, description = "Invalid request or path is not a worktree"),
        (status = 404, description = "Project not found"),
        (status = 409, description = "Worktree already managed"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn import_project_worktree(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(req): Json<ImportWorktreeRequest>,
) -> Result<(StatusCode, Json<Worktree>), ApiError> {
    let path = req.path.trim();
    if path.is_empty() {
        return Err(ApiError::bad_request("Invalid worktree request."));
    }

    let projects = state.projects.list().await;
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| ApiError::not_found("Project or worktree not found."))?;

    let canonical = tokio::fs::canonicalize(path).await.map_err(|error| {
        tracing::warn!(error = %error, "failed to canonicalize imported worktree path");
        ApiError::bad_request("Invalid worktree request.")
    })?;

    // Reject if path is the local worktree.
    let local_canonical = tokio::fs::canonicalize(&project.path)
        .await
        .unwrap_or_else(|_| PathBuf::from(&project.path));
    if canonical == local_canonical {
        return Err(ApiError::bad_request("Invalid worktree request."));
    }

    // Validate the path is a known git worktree for this project.
    let local_root = git::resolve_local_root(PathBuf::from(&project.path).as_path())
        .await
        .map_err(|error| {
            tracing::warn!(error = %error, "failed to resolve project git root");
            ApiError::bad_request("Invalid worktree request.")
        })?;
    let git_worktrees = git::list_worktrees(&local_root).await.map_err(|error| {
        tracing::warn!(error = %error, "failed to list git worktrees");
        ApiError::internal("Internal server error.")
    })?;
    let mut matched = None;
    for wt in &git_worktrees {
        let wt_canonical = tokio::fs::canonicalize(&wt.path)
            .await
            .unwrap_or_else(|_| wt.path.clone());
        if wt_canonical == canonical {
            matched = Some(wt);
            break;
        }
    }
    let git_wt = matched.ok_or_else(|| ApiError::bad_request("Invalid worktree request."))?;

    // Check not already managed.
    let mut meta = load_meta(state.project_meta_file(&project.id)).await;
    let wt_id = git::worktree_id(&canonical);
    if meta.managed_worktrees.iter().any(|wt| wt.id == wt_id) {
        return Err(ApiError::conflict("Worktree conflict."));
    }

    let branch = git_wt.branch.clone().unwrap_or_else(|| {
        canonical
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    });
    let name = branch.clone();
    let canonical_str = canonical.to_string_lossy().to_string();

    let imported = Worktree {
        id: wt_id.clone(),
        project_id: project.id.clone(),
        name: name.clone(),
        path: canonical_str.clone(),
        branch: branch.clone(),
        source_ref: None,
        ui_mode: WorktreeUiMode::default(),
        is_local: false,
        is_imported: true,
        missing_on_disk: false,
        position: 0.0,
    };

    meta.managed_worktrees.retain(|wt| wt.id != wt_id);
    meta.managed_worktrees.push(ManagedWorktree {
        id: wt_id.clone(),
        path: canonical_str,
        branch,
        name: Some(name),
        source_ref: None,
        imported: true,
    });
    meta.worktree_order.retain(|id| id != &wt_id);
    meta.worktree_order.insert(0, wt_id);
    let lwt_id = local_worktree_id(project);
    normalize_meta(&mut meta, &lwt_id);
    save_meta(&state, &project.id, &meta).await?;

    let list = list_worktrees_for_project(&state, project).await;

    state
        .events
        .emit(EventKind::WorktreeCreated(imported.clone()));
    state.events.emit(EventKind::ProjectWorktreesUpdated {
        project_id: project.id.clone(),
        worktrees: list,
        git_error: None,
    });

    Ok((StatusCode::CREATED, Json(imported)))
}

#[utoipa::path(
    delete,
    path = "/api/projects/{id}/worktrees/{worktreeId}",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktreeId" = String, Path, description = "Worktree ID"),
        DeleteWorktreeParams,
    ),
    responses(
        (status = 204, description = "Worktree removed"),
        (status = 400, description = "Invalid worktree request"),
        (status = 404, description = "Project or worktree not found"),
        (status = 409, description = "Worktree has uncommitted changes"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn delete_project_worktree(
    State(state): State<AppState>,
    Path((project_id, worktree_id)): Path<(String, String)>,
    Query(params): Query<DeleteWorktreeParams>,
) -> Result<StatusCode, ApiError> {
    let projects = state.projects.list().await;
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| ApiError::not_found("Project not found."))?;

    let worktrees = list_worktrees_for_project(&state, project).await;

    let worktree = worktrees
        .iter()
        .find(|wt| wt.id == worktree_id)
        .ok_or_else(|| ApiError::not_found("Worktree not found."))?;

    if worktree.is_local {
        return Err(ApiError::bad_request("Invalid worktree request."));
    }

    if !params.untrack_only && !worktree.missing_on_disk {
        let local_root = match git::resolve_local_root(PathBuf::from(&project.path).as_path()).await
        {
            Ok(root) => root,
            Err(error) => {
                tracing::warn!(error = %error, "failed to resolve project git root");
                return Err(ApiError::bad_request("Invalid worktree request."));
            }
        };

        if let Err(err) = git::remove_worktree(
            &local_root,
            PathBuf::from(&worktree.path).as_path(),
            params.force,
        )
        .await
            && !is_missing_worktree_error(&err.message)
        {
            tracing::warn!(error = %err, "failed to remove worktree");
            return Err(if params.force {
                ApiError::internal("Internal server error.")
            } else {
                ApiError::conflict("Worktree has uncommitted changes.")
            });
        }
    }

    let mut meta = load_meta(state.project_meta_file(&project.id)).await;
    meta.managed_worktrees.retain(|wt| wt.id != worktree_id);
    meta.worktree_order.retain(|id| id != &worktree_id);
    meta.worktree_ui_modes.remove(&worktree_id);
    normalize_meta(&mut meta, &local_worktree_id(project));
    save_meta(&state, &project.id, &meta).await?;

    close_tabs_for_worktree(&state, &worktree_id).await?;
    state
        .persistence
        .delete_worktree(project.id.clone(), worktree_id.clone());

    state.events.emit(EventKind::WorktreeDeleted {
        project_id: project.id.clone(),
        worktree_id: worktree_id.clone(),
    });

    let updated = list_worktrees_for_project(&state, project).await;

    state.events.emit(EventKind::ProjectWorktreesUpdated {
        project_id: project.id.clone(),
        worktrees: updated,
        git_error: None,
    });

    Ok(StatusCode::NO_CONTENT)
}

pub(crate) fn is_missing_worktree_remove_error(message: &str) -> bool {
    is_missing_worktree_error(message)
}

#[cfg(test)]
mod tests {
    use super::DeleteWorktreeParams;
    use axum::extract::Query;
    use axum::http::Uri;

    fn parse(query: &str) -> DeleteWorktreeParams {
        let uri: Uri = format!("http://host/?{query}").parse().unwrap();
        Query::try_from_uri(&uri).map(|Query(p)| p).unwrap()
    }

    #[test]
    fn delete_worktree_params_accept_both_untrack_spellings() {
        assert!(parse("untrackOnly=true").untrack_only);
        assert!(parse("untrack_only=true").untrack_only);
        assert!(!parse("").untrack_only);
    }
}
