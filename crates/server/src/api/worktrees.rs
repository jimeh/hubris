use std::cmp::Ordering;
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
    #[serde(default)]
    pub missing_on_disk: bool,
    pub position: f64,
}

#[derive(Debug, Serialize)]
pub struct ListWorktreesResponse {
    pub worktrees: Vec<Worktree>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StartPoint {
    pub value: String,
    pub sha: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_ref: Option<String>,
    pub remote_refs: Vec<String>,
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
struct ManagedWorktree {
    id: String,
    path: String,
    branch: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ProjectMeta {
    #[serde(default)]
    worktree_order: Vec<String>,
    #[serde(default)]
    managed_worktrees: Vec<ManagedWorktree>,
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

fn normalize_meta(meta: &mut ProjectMeta) {
    let managed_ids: HashSet<String> = meta
        .managed_worktrees
        .iter()
        .map(|wt| wt.id.clone())
        .collect();
    meta.worktree_order.retain(|id| managed_ids.contains(id));
}

fn is_missing_worktree_error(message: &str) -> bool {
    let message = message.to_lowercase();
    message.contains("not a working tree")
        || message.contains("worktree not found")
        || message.contains("does not exist")
        || message.contains("cannot find")
}

pub async fn list_worktrees_for_project(
    state: &AppState,
    project: &Project,
) -> Result<Vec<Worktree>, String> {
    let mut meta = load_meta(state, &project.id).await;
    normalize_meta(&mut meta);

    let local_path_buf = PathBuf::from(&project.path);
    let local_path = local_path_buf.to_string_lossy().to_string();
    let local = Worktree {
        id: git::worktree_id(&local_path_buf),
        project_id: project.id.clone(),
        name: "local".to_string(),
        path: local_path,
        branch: "local".to_string(),
        is_local: true,
        missing_on_disk: tokio::fs::metadata(&local_path_buf).await.is_err(),
        position: 0.0,
    };

    let mut non_local = Vec::with_capacity(meta.managed_worktrees.len());
    for managed in &meta.managed_worktrees {
        let path_buf = PathBuf::from(&managed.path);
        non_local.push(Worktree {
            id: managed.id.clone(),
            project_id: project.id.clone(),
            name: managed
                .name
                .clone()
                .unwrap_or_else(|| managed.branch.clone()),
            path: managed.path.clone(),
            branch: managed.branch.clone(),
            is_local: false,
            missing_on_disk: tokio::fs::metadata(&path_buf).await.is_err(),
            position: 0.0,
        });
    }

    let mut ordered = vec![local];
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
        let worktrees = match list_worktrees_for_project(state, &project).await {
            Ok(list) => list,
            Err(_) => continue,
        };

        if let Some(worktree) = worktrees.into_iter().find(|w| w.id == worktree_id) {
            let local_root = PathBuf::from(&project.path);
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

    let canonical_target = tokio::fs::canonicalize(&target).await.unwrap_or(target);
    let created_id = git::worktree_id(&canonical_target);
    let created_path = canonical_target.to_string_lossy().to_string();
    let created = Worktree {
        id: created_id.clone(),
        project_id: project.id.clone(),
        name: branch.to_string(),
        path: created_path.clone(),
        branch: branch.to_string(),
        is_local: false,
        missing_on_disk: false,
        position: 0.0,
    };

    let mut meta = load_meta(&state, &project.id).await;
    meta.managed_worktrees.retain(|wt| wt.id != created_id);
    meta.managed_worktrees.push(ManagedWorktree {
        id: created.id.clone(),
        path: created.path.clone(),
        branch: created.branch.clone(),
        name: Some(created.name.clone()),
    });
    meta.worktree_order.retain(|id| id != &created.id);
    meta.worktree_order.insert(0, created.id.clone());
    normalize_meta(&mut meta);
    save_meta(&state, &project.id, &meta).await?;

    let list = list_worktrees_for_project(&state, project)
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
    meta.worktree_order = req.worktree_ids.clone();
    normalize_meta(&mut meta);
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

    if !worktree.missing_on_disk {
        let local_root = match git::resolve_local_root(PathBuf::from(&project.path).as_path()).await
        {
            Ok(root) => root,
            Err(_) => return StatusCode::BAD_REQUEST,
        };

        if let Err(err) = git::remove_worktree(
            &local_root,
            PathBuf::from(&worktree.path).as_path(),
            params.force,
        )
        .await
            && !is_missing_worktree_error(&err.message)
        {
            return if params.force {
                StatusCode::INTERNAL_SERVER_ERROR
            } else {
                StatusCode::CONFLICT
            };
        }
    }

    let mut meta = load_meta(&state, &project.id).await;
    meta.managed_worktrees.retain(|wt| wt.id != worktree_id);
    meta.worktree_order.retain(|id| id != &worktree_id);
    normalize_meta(&mut meta);
    if save_meta(&state, &project.id, &meta).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }

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

pub(crate) fn is_missing_worktree_remove_error(message: &str) -> bool {
    is_missing_worktree_error(message)
}
