use std::path::PathBuf;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::api::worktrees::{
    close_tabs_for_worktree, is_missing_worktree_remove_error, list_worktrees_for_project,
};
pub use crate::domain::project::Project;
use crate::error::ApiError;
use crate::events::EventKind;
use crate::git;
use crate::project_store::ReorderOutcome;
use crate::state::AppState;

#[derive(Debug, Deserialize, ToSchema)]
pub struct AddProjectRequest {
    pub path: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateProjectRequest {
    pub name: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReorderProjectsRequest {
    pub project_ids: Vec<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct DeleteProjectParams {
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub delete_managed_worktrees: bool,
}

/// Project listing response with a freshly computed repository error.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListItem {
    #[serde(flatten)]
    project: Project,
    #[serde(skip_serializing_if = "Option::is_none")]
    git_error: Option<String>,
}

async fn with_git_errors(projects: Vec<Project>) -> Vec<ProjectListItem> {
    let mut responses = Vec::with_capacity(projects.len());
    for project in projects {
        let path = PathBuf::from(&project.path);
        let git_error = match git::resolve_local_root(&path).await {
            Ok(_) => None,
            Err(err) => Some(err.message),
        };
        responses.push(ProjectListItem { project, git_error });
    }
    responses
}

#[utoipa::path(
    get,
    path = "/api/projects",
    responses(
        (status = 200, description = "List projects", body = [ProjectListItem]),
    ),
)]
pub async fn list_projects(
    State(state): State<AppState>,
) -> Result<Json<Vec<ProjectListItem>>, ApiError> {
    let projects = state.projects.list().await;
    Ok(Json(with_git_errors(projects).await))
}

#[utoipa::path(
    post,
    path = "/api/projects",
    request_body = AddProjectRequest,
    responses(
        (status = 201, description = "Project created", body = Project),
        (status = 200, description = "Project already exists", body = Project),
        (status = 400, description = "Invalid path"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn add_project(
    State(state): State<AppState>,
    Json(req): Json<AddProjectRequest>,
) -> Result<(StatusCode, Json<Project>), ApiError> {
    let input_path = PathBuf::from(&req.path);
    let input_metadata = tokio::fs::metadata(&input_path).await.map_err(|error| {
        tracing::debug!(error = %error, "failed to read project path metadata");
        ApiError::bad_request("Invalid project path.")
    })?;
    if !input_metadata.is_dir() {
        return Err(ApiError::bad_request("Invalid project path."));
    }

    let local_root = git::resolve_local_root(&input_path)
        .await
        .map_err(|error| {
            tracing::warn!(error = %error, "failed to resolve project git root");
            ApiError::bad_request("Invalid project path.")
        })?;

    let canonical_path = local_root.to_string_lossy().to_string();
    let name = local_root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unnamed")
        .to_string();

    let outcome = state
        .projects
        .add(canonical_path, name)
        .await
        .map_err(|error| {
            tracing::warn!(error = %error, "failed to save added project");
            ApiError::internal("Internal server error.")
        })?;
    if !outcome.created {
        return Ok((StatusCode::OK, Json(outcome.project)));
    }

    let project = outcome.project;
    state.events.emit(EventKind::ProjectAdded(project.clone()));
    let worktrees = list_worktrees_for_project(&state, &project).await;
    state.events.emit(EventKind::ProjectWorktreesUpdated {
        project_id: project.id.clone(),
        worktrees,
        git_error: None,
    });
    Ok((StatusCode::CREATED, Json(project)))
}

#[utoipa::path(
    patch,
    path = "/api/projects/{id}",
    params(
        ("id" = String, Path, description = "Project ID"),
    ),
    request_body = UpdateProjectRequest,
    responses(
        (status = 200, description = "Project updated", body = Project),
        (status = 404, description = "Project not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn update_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateProjectRequest>,
) -> Result<Json<Project>, ApiError> {
    let updated = state
        .projects
        .update(&id, req.name)
        .await
        .map_err(|error| {
            tracing::warn!(error = %error, project_id = id, "failed to update project");
            ApiError::internal("Internal server error.")
        })?
        .ok_or_else(|| ApiError::not_found("Project not found."))?;
    state
        .events
        .emit(EventKind::ProjectUpdated(updated.clone()));
    Ok(Json(updated))
}

#[utoipa::path(
    put,
    path = "/api/projects/reorder",
    request_body = ReorderProjectsRequest,
    responses(
        (status = 200, description = "Projects reordered", body = [Project]),
        (status = 400, description = "Invalid order payload"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn reorder_projects(
    State(state): State<AppState>,
    Json(req): Json<ReorderProjectsRequest>,
) -> Result<Json<Vec<Project>>, ApiError> {
    let projects = match state
        .projects
        .reorder(&req.project_ids)
        .await
        .map_err(|error| {
            tracing::warn!(error = %error, "failed to reorder projects");
            ApiError::internal("Internal server error.")
        })? {
        ReorderOutcome::Reordered(projects) => projects,
        ReorderOutcome::InvalidIds => {
            return Err(ApiError::bad_request("Invalid project order."));
        }
    };
    state
        .events
        .emit(EventKind::ProjectsReordered(projects.clone()));
    Ok(Json(projects))
}

#[utoipa::path(
    delete,
    path = "/api/projects/{id}",
    params(
        ("id" = String, Path, description = "Project ID"),
        DeleteProjectParams,
    ),
    responses(
        (status = 204, description = "Project removed"),
        (status = 400, description = "Invalid project path"),
        (status = 404, description = "Project not found"),
        (
            status = 409,
            description = "Project has dirty or busy managed worktrees"
        ),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn delete_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<DeleteProjectParams>,
) -> Result<StatusCode, ApiError> {
    let project = match state.projects.get(&id).await {
        Some(project) => project,
        None => return Err(ApiError::not_found("Project not found.")),
    };

    let worktrees = list_worktrees_for_project(&state, &project).await;

    if params.delete_managed_worktrees {
        let managed_worktrees: Vec<_> = worktrees.iter().filter(|wt| !wt.is_local).collect();
        if !managed_worktrees.is_empty() {
            let should_resolve_root = managed_worktrees.iter().any(|wt| !wt.missing_on_disk);
            if should_resolve_root {
                let local_root =
                    match git::resolve_local_root(PathBuf::from(&project.path).as_path()).await {
                        Ok(root) => root,
                        Err(error) => {
                            tracing::warn!(error = %error, "failed to resolve project git root");
                            return Err(ApiError::bad_request("Invalid project path."));
                        }
                    };

                for worktree in managed_worktrees {
                    if worktree.missing_on_disk {
                        continue;
                    }

                    if let Err(err) = git::remove_worktree(
                        &local_root,
                        PathBuf::from(&worktree.path).as_path(),
                        params.force,
                    )
                    .await
                    {
                        if is_missing_worktree_remove_error(&err.message) {
                            continue;
                        }

                        tracing::warn!(error = %err, "failed to remove managed worktree");
                        return Err(if params.force {
                            ApiError::internal("Internal server error.")
                        } else {
                            ApiError::conflict("Project has managed worktree conflicts.")
                        });
                    }
                }
            }
        }
    }

    for worktree in worktrees {
        close_tabs_for_worktree(&state, &worktree.id).await?;
    }

    if let Err(error) = state.chats.delete_project_conversations(&id).await {
        tracing::warn!(error = %error, project_id = id, "failed to delete project chats");
        return Err(ApiError::internal("Internal server error."));
    }

    if let Err(error) = state.projects.remove(&id).await {
        tracing::warn!(error = %error, project_id = id, "failed to remove project");
        return Err(ApiError::internal("Internal server error."));
    }

    state.persistence.delete_project(id.clone());

    let _ = tokio::fs::remove_file(state.project_meta_file(&id)).await;

    state.events.emit(EventKind::ProjectRemoved {
        project_id: id.clone(),
    });

    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn project() -> Project {
        Project {
            id: "project-id".to_string(),
            name: "Project".to_string(),
            path: "/repo".to_string(),
            position: 2.0,
        }
    }

    #[test]
    fn project_list_item_omits_absent_git_error() {
        let item = ProjectListItem {
            project: project(),
            git_error: None,
        };

        assert_eq!(
            serde_json::to_value(item).unwrap(),
            json!({
                "id": "project-id",
                "name": "Project",
                "path": "/repo",
                "position": 2.0,
            })
        );
    }

    #[test]
    fn project_list_item_includes_present_git_error() {
        let item = ProjectListItem {
            project: project(),
            git_error: Some("repository unavailable".to_string()),
        };

        assert_eq!(
            serde_json::to_value(item).unwrap(),
            json!({
                "id": "project-id",
                "name": "Project",
                "path": "/repo",
                "position": 2.0,
                "gitError": "repository unavailable",
            })
        );
    }
}
