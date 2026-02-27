use std::path::PathBuf;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct AddProjectRequest {
    pub path: String,
}

async fn load_projects(
    state: &AppState,
) -> Result<Vec<Project>, std::io::Error> {
    let path = state.projects_file();
    match tokio::fs::read_to_string(&path).await {
        Ok(contents) => {
            let projects: Vec<Project> =
                serde_json::from_str(&contents).unwrap_or_default();
            Ok(projects)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e),
    }
}

async fn save_projects(
    state: &AppState,
    projects: &[Project],
) -> Result<(), std::io::Error> {
    let path = state.projects_file();
    let contents = serde_json::to_string_pretty(projects)
        .map_err(std::io::Error::other)?;
    tokio::fs::write(&path, contents).await
}

pub async fn list_projects(
    State(state): State<AppState>,
) -> Result<Json<Vec<Project>>, StatusCode> {
    let projects = load_projects(&state)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
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
    let project = Project {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        path: req.path,
    };
    let mut projects = load_projects(&state).await.unwrap_or_default();
    projects.push(project.clone());
    save_projects(&state, &projects)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok((StatusCode::CREATED, Json(project)))
}

pub async fn delete_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> StatusCode {
    let mut projects = load_projects(&state).await.unwrap_or_default();
    let before = projects.len();
    projects.retain(|p| p.id != id);
    if projects.len() == before {
        return StatusCode::NOT_FOUND;
    }
    save_projects(&state, &projects).await.unwrap_or(());
    StatusCode::NO_CONTENT
}
