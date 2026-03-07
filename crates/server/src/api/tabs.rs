use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use portable_pty::{CommandBuilder, NativePtySystem, PtySystem};
use serde::Deserialize;
use utoipa::{IntoParams, ToSchema};

use crate::api::worktrees::resolve_worktree;
use crate::events::EventKind;
use crate::pty::live_tab::{
    DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS, DEFAULT_SCROLLBACK, LiveTab, TabInfo, TerminalSize,
};
use crate::state::AppState;

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateTabRequest {
    pub worktree_id: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateTabRequest {
    pub label: Option<String>,
    pub position: Option<f64>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ReorderTabsRequest {
    pub worktree_id: String,
    pub tab_ids: Vec<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListTabsParams {
    #[serde(default = "default_session_id")]
    pub session_id: String,
}

fn default_session_id() -> String {
    "default".to_string()
}

#[utoipa::path(
    get,
    path = "/api/tabs",
    params(ListTabsParams),
    responses(
        (status = 200, description = "List tabs", body = [TabInfo]),
    ),
)]
pub async fn list_tabs(
    State(state): State<AppState>,
    Query(params): Query<ListTabsParams>,
) -> Json<Vec<TabInfo>> {
    let mut tabs: Vec<TabInfo> = state
        .tabs
        .iter()
        .map(|e| e.value().info())
        .filter(|t| t.session_id == params.session_id)
        .collect();
    tabs.sort_by(|a, b| {
        a.position
            .partial_cmp(&b.position)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Json(tabs)
}

#[utoipa::path(
    post,
    path = "/api/tabs",
    request_body = CreateTabRequest,
    responses(
        (status = 201, description = "Tab created", body = TabInfo),
        (status = 404, description = "Worktree not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn create_tab(
    State(state): State<AppState>,
    Json(req): Json<CreateTabRequest>,
) -> Result<(StatusCode, Json<TabInfo>), StatusCode> {
    // TODO: Track a worktree_id -> path index in AppState so tab creation
    // avoids scanning all projects/worktrees via git on every request.
    let resolved = resolve_worktree(&state, &req.worktree_id)
        .await?
        .ok_or(StatusCode::NOT_FOUND)?;

    let tab_num = state.next_tab_num.fetch_add(1, Ordering::Relaxed);

    let max_pos = state
        .tabs
        .iter()
        .map(|e| e.value().info().position)
        .fold(0.0_f64, f64::max);

    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let info = TabInfo {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: "default".to_string(),
        worktree_id: req.worktree_id.clone(),
        label: format!("Terminal {}", tab_num),
        tab_type: "terminal".to_string(),
        position: max_pos + 1.0,
        created_at,
    };

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(TerminalSize::default_pty().to_pty_size())
        .map_err(|e| {
            tracing::error!("failed to open pty: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(PathBuf::from(&resolved.worktree.path));
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        tracing::error!("failed to spawn shell: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    drop(pair.slave);

    let live_tab = LiveTab::spawn(
        info.clone(),
        pair.master,
        child,
        DEFAULT_SCROLLBACK,
        TerminalSize::new(DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS),
    );
    let mut close_rx = live_tab.close_tx.subscribe();
    let tab = Arc::new(live_tab);
    state.tabs.insert(info.id.clone(), tab);

    state.events.emit(EventKind::TabCreated(info.clone()));

    {
        let tabs = state.tabs.clone();
        let events = state.events.clone();
        let id = info.id.clone();
        tokio::spawn(async move {
            let _ = close_rx.recv().await;
            if tabs.remove(&id).is_some() {
                events.emit(EventKind::TabClosed { tab_id: id });
            }
        });
    }

    Ok((StatusCode::CREATED, Json(info)))
}

#[utoipa::path(
    delete,
    path = "/api/tabs/{id}",
    params(
        ("id" = String, Path, description = "Tab ID"),
    ),
    responses(
        (status = 204, description = "Tab removed"),
        (status = 404, description = "Tab not found"),
    ),
)]
pub async fn delete_tab(State(state): State<AppState>, Path(id): Path<String>) -> StatusCode {
    match state.tabs.remove(&id) {
        Some((_, tab)) => {
            tab.notify_close();
            state.events.emit(EventKind::TabClosed { tab_id: id });
            StatusCode::NO_CONTENT
        }
        None => StatusCode::NOT_FOUND,
    }
}

#[utoipa::path(
    patch,
    path = "/api/tabs/{id}",
    params(
        ("id" = String, Path, description = "Tab ID"),
    ),
    request_body = UpdateTabRequest,
    responses(
        (status = 200, description = "Tab updated", body = TabInfo),
        (status = 404, description = "Tab not found"),
    ),
)]
pub async fn update_tab(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateTabRequest>,
) -> Result<Json<TabInfo>, StatusCode> {
    let tab = state
        .tabs
        .get(&id)
        .map(|e| e.value().clone())
        .ok_or(StatusCode::NOT_FOUND)?;

    let updated = tab.update_info(|info| {
        if let Some(label) = req.label {
            info.label = label;
        }
        if let Some(position) = req.position {
            info.position = position;
        }
        info.clone()
    });

    state.events.emit(EventKind::TabUpdated(updated.clone()));

    Ok(Json(updated))
}

#[utoipa::path(
    put,
    path = "/api/tabs/reorder",
    request_body = ReorderTabsRequest,
    responses(
        (status = 200, description = "Tabs reordered", body = [TabInfo]),
        (status = 400, description = "Invalid request"),
    ),
)]
pub async fn reorder_tabs(
    State(state): State<AppState>,
    Json(req): Json<ReorderTabsRequest>,
) -> Result<Json<Vec<TabInfo>>, StatusCode> {
    // Collect tabs belonging to this worktree.
    let worktree_tab_ids: HashSet<String> = state
        .tabs
        .iter()
        .filter(|e| e.value().info().worktree_id == req.worktree_id)
        .map(|e| e.key().clone())
        .collect();

    if worktree_tab_ids.len() != req.tab_ids.len() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let received: HashSet<String> = req.tab_ids.iter().cloned().collect();
    if worktree_tab_ids != received {
        return Err(StatusCode::BAD_REQUEST);
    }

    // Assign sequential positions based on the new order.
    for (i, id) in req.tab_ids.iter().enumerate() {
        if let Some(tab) = state.tabs.get(id) {
            tab.value().update_info(|info| {
                info.position = (i + 1) as f64;
                info.clone()
            });
        }
    }

    // Collect reordered tabs for the response.
    let mut reordered: Vec<TabInfo> = state
        .tabs
        .iter()
        .filter(|e| e.value().info().worktree_id == req.worktree_id)
        .map(|e| e.value().info())
        .collect();
    reordered.sort_by(|a, b| {
        a.position
            .partial_cmp(&b.position)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    state.events.emit(EventKind::TabsReordered {
        worktree_id: req.worktree_id,
        tabs: reordered.clone(),
    });

    Ok(Json(reordered))
}
