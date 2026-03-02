use std::path::PathBuf;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::api::worktrees::{close_tabs_for_worktree, list_worktrees_for_project};
use crate::events::EventKind;
use crate::git;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub position: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AddProjectRequest {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProjectRequest {
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReorderProjectsRequest {
    pub project_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteProjectParams {
    #[serde(default)]
    pub force: bool,
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

pub async fn add_project(
    State(state): State<AppState>,
    Json(req): Json<AddProjectRequest>,
) -> Result<(StatusCode, Json<Project>), StatusCode> {
    let input_path = PathBuf::from(&req.path);
    if !input_path.is_dir() {
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
    Ok((StatusCode::CREATED, Json(project)))
}

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

    if let Ok(worktrees) = list_worktrees_for_project(&state, &project).await {
        for worktree in worktrees.iter().filter(|wt| !wt.is_local) {
            let local_root =
                match git::resolve_local_root(PathBuf::from(&project.path).as_path()).await {
                    Ok(root) => root,
                    Err(_) => return StatusCode::BAD_REQUEST,
                };

            if git::remove_worktree(
                &local_root,
                PathBuf::from(&worktree.path).as_path(),
                params.force,
            )
            .await
            .is_err()
            {
                return if params.force {
                    StatusCode::INTERNAL_SERVER_ERROR
                } else {
                    StatusCode::CONFLICT
                };
            }
        }

        for worktree in worktrees {
            close_tabs_for_worktree(&state, &worktree.id);
        }
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
