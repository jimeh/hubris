use std::path::PathBuf;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::events::EventKind;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub position: f64,
}

#[derive(Debug, Deserialize)]
pub struct AddProjectRequest {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProjectRequest {
    pub position: Option<f64>,
    pub name: Option<String>,
}

async fn save_projects(state: &AppState, projects: &[Project]) -> Result<(), std::io::Error> {
    let path = state.projects_file();
    let contents = serde_json::to_string_pretty(projects).map_err(std::io::Error::other)?;
    tokio::fs::write(&path, contents).await
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
    Ok(Json(projects))
}

pub async fn add_project(
    State(state): State<AppState>,
    Json(req): Json<AddProjectRequest>,
) -> Result<(StatusCode, Json<Project>), StatusCode> {
    let path = PathBuf::from(&req.path);
    if !path.is_dir() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unnamed")
        .to_string();
    let mut projects = state.load_projects().await.unwrap_or_default();
    let max_pos = projects.iter().map(|p| p.position).fold(0.0_f64, f64::max);
    let project = Project {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        path: req.path,
        position: max_pos + 1.0,
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
    if let Some(pos) = req.position {
        project.position = pos;
    }
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

pub async fn delete_project(State(state): State<AppState>, Path(id): Path<String>) -> StatusCode {
    let mut projects = state.load_projects().await.unwrap_or_default();
    let before = projects.len();
    projects.retain(|p| p.id != id);
    if projects.len() == before {
        return StatusCode::NOT_FOUND;
    }
    save_projects(&state, &projects).await.unwrap_or(());

    state.events.emit(EventKind::ProjectRemoved {
        project_id: id.clone(),
    });

    // Kill all tabs belonging to the deleted project
    let tab_ids: Vec<String> = state
        .tabs
        .iter()
        .filter(|e| e.value().info().project_id == id)
        .map(|e| e.key().clone())
        .collect();
    for tid in tab_ids {
        if let Some((_, tab)) = state.tabs.remove(&tid) {
            tab.notify_close();
            state.events.emit(EventKind::TabClosed { tab_id: tid });
        }
    }

    StatusCode::NO_CONTENT
}
