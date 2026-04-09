use std::path::PathBuf;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utoipa::{IntoParams, ToSchema};

use crate::api::worktrees::{
    close_tabs_for_worktree, is_missing_worktree_remove_error, list_worktrees_for_project,
};
use crate::events::EventKind;
use crate::git;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, TS)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub position: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_error: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct AddProjectRequest {
    pub path: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateProjectRequest {
    pub name: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ReorderProjectsRequest {
    pub project_ids: Vec<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct DeleteProjectParams {
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub delete_managed_worktrees: bool,
}

async fn save_projects(state: &AppState, projects: &[Project]) -> Result<(), std::io::Error> {
    let path = state.projects_file();
    let mut to_store = projects.to_vec();
    for project in &mut to_store {
        project.git_error = None;
    }
    let contents = serde_json::to_string_pretty(&to_store).map_err(std::io::Error::other)?;
    tokio::fs::write(&path, contents).await
}

async fn with_git_errors(mut projects: Vec<Project>) -> Vec<Project> {
    for project in &mut projects {
        let path = PathBuf::from(&project.path);
        project.git_error = match git::resolve_local_root(&path).await {
            Ok(_) => None,
            Err(err) => Some(err.message),
        };
    }
    projects
}

#[utoipa::path(
    get,
    path = "/api/projects",
    responses(
        (status = 200, description = "List projects", body = [Project]),
    ),
)]
pub async fn list_projects(
    State(state): State<AppState>,
) -> Result<Json<Vec<Project>>, StatusCode> {
    let mut projects = state
        .load_projects()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    projects.sort_by(|a, b| {
        a.position
            .partial_cmp(&b.position)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
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
) -> Result<(StatusCode, Json<Project>), StatusCode> {
    let input_path = PathBuf::from(&req.path);
    let input_metadata = tokio::fs::metadata(&input_path)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    if !input_metadata.is_dir() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let local_root = git::resolve_local_root(&input_path)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    let canonical_path = local_root.to_string_lossy().to_string();
    let mut projects = state.load_projects().await.unwrap_or_default();
    if let Some(existing) = projects
        .iter()
        .find(|project| project.path == canonical_path)
        .cloned()
    {
        return Ok((StatusCode::OK, Json(existing)));
    }

    let name = local_root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unnamed")
        .to_string();
    let max_pos = projects.iter().map(|p| p.position).fold(0.0_f64, f64::max);
    let project = Project {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        path: canonical_path,
        position: max_pos + 1.0,
        git_error: None,
    };

    projects.push(project.clone());
    save_projects(&state, &projects)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    state.events.emit(EventKind::ProjectAdded(project.clone()));
    match list_worktrees_for_project(&state, &project).await {
        Ok(worktrees) => {
            state.events.emit(EventKind::ProjectWorktreesUpdated {
                project_id: project.id.clone(),
                worktrees,
                git_error: None,
            });
        }
        Err(err) => {
            state.events.emit(EventKind::ProjectWorktreesUpdated {
                project_id: project.id.clone(),
                worktrees: vec![],
                git_error: Some(err),
            });
        }
    }
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
) -> Result<Json<Project>, StatusCode> {
    let mut projects = state
        .load_projects()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let project = projects
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or(StatusCode::NOT_FOUND)?;
    if let Some(name) = req.name {
        project.name = name;
    }
    let updated = project.clone();
    save_projects(&state, &projects)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
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
) -> Result<Json<Vec<Project>>, StatusCode> {
    let mut projects = state
        .load_projects()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if req.project_ids.len() != projects.len() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let all_exist = req
        .project_ids
        .iter()
        .all(|id| projects.iter().any(|p| p.id == *id));
    if !all_exist {
        return Err(StatusCode::BAD_REQUEST);
    }

    for (i, id) in req.project_ids.iter().enumerate() {
        if let Some(p) = projects.iter_mut().find(|p| p.id == *id) {
            p.position = (i + 1) as f64;
        }
    }
    projects.sort_by(|a, b| {
        a.position
            .partial_cmp(&b.position)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    save_projects(&state, &projects)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
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
) -> StatusCode {
    let mut projects = match state.load_projects().await {
        Ok(projects) => projects,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR,
    };

    let project = match projects.iter().find(|p| p.id == id).cloned() {
        Some(project) => project,
        None => return StatusCode::NOT_FOUND,
    };

    let worktrees = match list_worktrees_for_project(&state, &project).await {
        Ok(worktrees) => worktrees,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR,
    };

    if params.delete_managed_worktrees {
        let managed_worktrees: Vec<_> = worktrees.iter().filter(|wt| !wt.is_local).collect();
        if !managed_worktrees.is_empty() {
            let should_resolve_root = managed_worktrees.iter().any(|wt| !wt.missing_on_disk);
            if should_resolve_root {
                let local_root =
                    match git::resolve_local_root(PathBuf::from(&project.path).as_path()).await {
                        Ok(root) => root,
                        Err(_) => return StatusCode::BAD_REQUEST,
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

                        return if params.force {
                            StatusCode::INTERNAL_SERVER_ERROR
                        } else {
                            StatusCode::CONFLICT
                        };
                    }
                }
            }
        }
    }

    for worktree in worktrees {
        close_tabs_for_worktree(&state, &worktree.id);
    }

    projects.retain(|p| p.id != id);
    if save_projects(&state, &projects).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }

    let _ = tokio::fs::remove_file(state.project_meta_file(&id)).await;

    state.events.emit(EventKind::ProjectRemoved {
        project_id: id.clone(),
    });

    StatusCode::NO_CONTENT
}
