use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::api::projects::Project;
use crate::api::settings::Settings;
use crate::events::EventKind;
use crate::git;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Worktree {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub path: String,
    pub branch: String,
    pub is_local: bool,
    pub position: f64,
}

#[derive(Debug, Serialize)]
pub struct ListWorktreesResponse {
    pub worktrees: Vec<Worktree>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartPointKind {
    Local,
    Remote,
}

#[derive(Debug, Clone, Serialize)]
pub struct StartPoint {
    pub value: String,
    pub kind: StartPointKind,
}

#[derive(Debug, Serialize)]
pub struct ListWorktreeStartPointsResponse {
    pub start_points: Vec<StartPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_start_point: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateWorktreeRequest {
    pub branch: String,
    #[serde(default)]
    pub start_point: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReorderWorktreesRequest {
    pub worktree_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteWorktreeParams {
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone)]
pub struct ResolvedWorktree {
    pub project_id: String,
    pub local_root: PathBuf,
    pub worktree: Worktree,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ProjectMeta {
    #[serde(default)]
    worktree_order: Vec<String>,
}

async fn load_meta(state: &AppState, project_id: &str) -> ProjectMeta {
    let path = state.project_meta_file(project_id);
    match tokio::fs::read_to_string(path).await {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => ProjectMeta::default(),
    }
}

async fn save_meta(
    state: &AppState,
    project_id: &str,
    meta: &ProjectMeta,
) -> Result<(), StatusCode> {
    let dir = state.project_meta_dir();
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let path = state.project_meta_file(project_id);
    let body = serde_json::to_string_pretty(meta).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tokio::fs::write(path, body)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn load_settings(state: &AppState) -> Settings {
    match tokio::fs::read_to_string(state.settings_file()).await {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
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

    let mode = settings
        .worktree
        .as_ref()
        .map(|w| w.location_mode.as_str())
        .unwrap_or("dataDir");

    if mode == "repoLocalDotHubris" {
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

fn sort_non_local(mut non_local: Vec<Worktree>, order: &[String]) -> Vec<Worktree> {
    let mut by_id: HashMap<String, Worktree> =
        non_local.drain(..).map(|wt| (wt.id.clone(), wt)).collect();

    let mut ordered = Vec::new();
    for id in order {
        if let Some(wt) = by_id.remove(id) {
            ordered.push(wt);
        }
    }

    let mut remaining: Vec<Worktree> = by_id.into_values().collect();
    remaining.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    ordered.extend(remaining);
    ordered
}

fn map_start_point_kind(kind: git::GitStartPointKind) -> StartPointKind {
    match kind {
        git::GitStartPointKind::Local => StartPointKind::Local,
        git::GitStartPointKind::Remote => StartPointKind::Remote,
    }
}

pub async fn list_worktrees_for_project(
    state: &AppState,
    project: &Project,
) -> Result<Vec<Worktree>, String> {
    let local_root = git::resolve_local_root(PathBuf::from(&project.path).as_path())
        .await
        .map_err(|e| e.message)?;

    let raw = git::list_worktrees(&local_root)
        .await
        .map_err(|e| e.message)?;

    let meta = load_meta(state, &project.id).await;

    let local_root_str = local_root.to_string_lossy().to_string();
    let mut local = None;
    let mut non_local = Vec::new();

    for wt in raw {
        let path = wt.path.to_string_lossy().to_string();
        let is_local = path == local_root_str;
        let id = git::worktree_id(&wt.path);
        let branch = wt.branch.unwrap_or_else(|| "detached".to_string());

        let view = Worktree {
            id,
            project_id: project.id.clone(),
            name: if is_local {
                "local".to_string()
            } else {
                branch.clone()
            },
            path,
            branch,
            is_local,
            position: 0.0,
        };

        if is_local {
            local = Some(view);
        } else {
            non_local.push(view);
        }
    }

    let mut ordered = Vec::new();
    if let Some(local) = local {
        ordered.push(local);
    }

    ordered.extend(sort_non_local(non_local, &meta.worktree_order));

    for (idx, wt) in ordered.iter_mut().enumerate() {
        wt.position = (idx + 1) as f64;
    }

    Ok(ordered)
}

pub async fn resolve_worktree(
    state: &AppState,
    worktree_id: &str,
) -> Result<Option<ResolvedWorktree>, StatusCode> {
    let projects = state
        .load_projects()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    for project in projects {
        let local_root = match git::resolve_local_root(PathBuf::from(&project.path).as_path()).await
        {
            Ok(root) => root,
            Err(_) => continue,
        };

        let worktrees = match list_worktrees_for_project(state, &project).await {
            Ok(list) => list,
            Err(_) => continue,
        };

        if let Some(worktree) = worktrees.into_iter().find(|w| w.id == worktree_id) {
            return Ok(Some(ResolvedWorktree {
                project_id: project.id.clone(),
                local_root,
                worktree,
            }));
        }
    }

    Ok(None)
}

pub fn close_tabs_for_worktree(state: &AppState, worktree_id: &str) {
    let tab_ids: Vec<String> = state
        .tabs
        .iter()
        .filter(|e| e.value().info().worktree_id == worktree_id)
        .map(|e| e.key().clone())
        .collect();

    for tab_id in tab_ids {
        if let Some((_, tab)) = state.tabs.remove(&tab_id) {
            tab.notify_close();
            state.events.emit(EventKind::TabClosed { tab_id });
        }
    }
}

pub async fn list_project_worktrees(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<ListWorktreesResponse>, StatusCode> {
    let projects = state
        .load_projects()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or(StatusCode::NOT_FOUND)?;

    match list_worktrees_for_project(&state, project).await {
        Ok(worktrees) => Ok(Json(ListWorktreesResponse {
            worktrees,
            git_error: None,
        })),
        Err(err) => Ok(Json(ListWorktreesResponse {
            worktrees: vec![],
            git_error: Some(err),
        })),
    }
}

pub async fn create_project_worktree(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(req): Json<CreateWorktreeRequest>,
) -> Result<(StatusCode, Json<Worktree>), StatusCode> {
    let branch = req.branch.trim();
    let start_point = req
        .start_point
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if !validate_branch(branch) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let projects = state
        .load_projects()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or(StatusCode::NOT_FOUND)?;

    let local_root = git::resolve_local_root(PathBuf::from(&project.path).as_path())
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    let settings = load_settings(&state).await;
    let target = resolve_target_path(&state, project, branch, &settings);

    git::create_worktree(&local_root, branch, &target, start_point)
        .await
        .map_err(|_| StatusCode::CONFLICT)?;

    let mut list = list_worktrees_for_project(&state, project)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let created = list
        .iter()
        .find(|wt| !wt.is_local && wt.branch == branch)
        .cloned()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut meta = load_meta(&state, &project.id).await;
    meta.worktree_order.retain(|id| id != &created.id);
    meta.worktree_order.insert(0, created.id.clone());
    save_meta(&state, &project.id, &meta).await?;

    list = list_worktrees_for_project(&state, project)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

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

pub async fn list_project_worktree_start_points(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<ListWorktreeStartPointsResponse>, StatusCode> {
    let projects = state
        .load_projects()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or(StatusCode::NOT_FOUND)?;

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
        Ok(start_points) => Ok(Json(ListWorktreeStartPointsResponse {
            start_points: start_points
                .into_iter()
                .map(|start_point| StartPoint {
                    value: start_point.value,
                    kind: map_start_point_kind(start_point.kind),
                })
                .collect(),
            default_start_point,
            git_error: None,
        })),
        Err(err) => Ok(Json(ListWorktreeStartPointsResponse {
            start_points: vec![],
            default_start_point,
            git_error: Some(err.message),
        })),
    }
}

pub async fn reorder_project_worktrees(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(req): Json<ReorderWorktreesRequest>,
) -> Result<Json<Vec<Worktree>>, StatusCode> {
    let projects = state
        .load_projects()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or(StatusCode::NOT_FOUND)?;

    let worktrees = list_worktrees_for_project(&state, project)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    let non_local_ids: Vec<String> = worktrees
        .iter()
        .filter(|wt| !wt.is_local)
        .map(|wt| wt.id.clone())
        .collect();

    if non_local_ids.len() != req.worktree_ids.len() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let expected: HashSet<String> = non_local_ids.into_iter().collect();
    let received: HashSet<String> = req.worktree_ids.iter().cloned().collect();
    if expected != received {
        return Err(StatusCode::BAD_REQUEST);
    }

    let mut meta = load_meta(&state, &project.id).await;
    meta.worktree_order = req.worktree_ids;
    save_meta(&state, &project.id, &meta).await?;

    let reordered = list_worktrees_for_project(&state, project)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    state.events.emit(EventKind::WorktreesReordered {
        project_id: project.id.clone(),
        worktrees: reordered.clone(),
    });

    Ok(Json(reordered))
}

pub async fn delete_project_worktree(
    State(state): State<AppState>,
    Path((project_id, worktree_id)): Path<(String, String)>,
    Query(params): Query<DeleteWorktreeParams>,
) -> StatusCode {
    let projects = match state.load_projects().await {
        Ok(projects) => projects,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR,
    };
    let project = match projects.iter().find(|p| p.id == project_id) {
        Some(project) => project,
        None => return StatusCode::NOT_FOUND,
    };

    let local_root = match git::resolve_local_root(PathBuf::from(&project.path).as_path()).await {
        Ok(root) => root,
        Err(_) => return StatusCode::BAD_REQUEST,
    };

    let worktrees = match list_worktrees_for_project(&state, project).await {
        Ok(list) => list,
        Err(_) => return StatusCode::BAD_REQUEST,
    };

    let worktree = match worktrees.iter().find(|wt| wt.id == worktree_id) {
        Some(worktree) => worktree,
        None => return StatusCode::NOT_FOUND,
    };

    if worktree.is_local {
        return StatusCode::BAD_REQUEST;
    }

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

    let mut meta = load_meta(&state, &project.id).await;
    meta.worktree_order.retain(|id| id != &worktree_id);
    let _ = save_meta(&state, &project.id, &meta).await;

    close_tabs_for_worktree(&state, &worktree_id);

    state.events.emit(EventKind::WorktreeDeleted {
        project_id: project.id.clone(),
        worktree_id: worktree_id.clone(),
    });

    let updated = list_worktrees_for_project(&state, project)
        .await
        .unwrap_or_default();

    state.events.emit(EventKind::ProjectWorktreesUpdated {
        project_id: project.id.clone(),
        worktrees: updated,
        git_error: None,
    });

    StatusCode::NO_CONTENT
}
