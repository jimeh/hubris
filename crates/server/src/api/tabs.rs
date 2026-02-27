use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use portable_pty::{
    CommandBuilder, NativePtySystem, PtySize, PtySystem,
};
use serde::Deserialize;

use crate::pty::live_tab::{LiveTab, TabInfo};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct CreateTabRequest {
    pub project_id: String,
}

/// GET /api/tabs — list all live tabs.
pub async fn list_tabs(
    State(state): State<AppState>,
) -> Json<Vec<TabInfo>> {
    let mut tabs: Vec<TabInfo> = state
        .tabs
        .iter()
        .map(|entry| entry.value().info.clone())
        .collect();
    tabs.sort_by_key(|t| t.created_at);
    Json(tabs)
}

/// POST /api/tabs — create a tab and spawn its PTY.
pub async fn create_tab(
    State(state): State<AppState>,
    Json(req): Json<CreateTabRequest>,
) -> Result<(StatusCode, Json<TabInfo>), StatusCode> {
    let projects = state
        .load_projects()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let project = projects
        .iter()
        .find(|p| p.id == req.project_id)
        .ok_or(StatusCode::NOT_FOUND)?;

    let tab_num = state
        .next_tab_num
        .fetch_add(1, Ordering::Relaxed);

    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let info = TabInfo {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: "default".to_string(),
        project_id: req.project_id.clone(),
        label: format!("Terminal {}", tab_num),
        tab_type: "terminal".to_string(),
        created_at,
    };

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            tracing::error!("failed to open pty: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    let shell = std::env::var("SHELL")
        .unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&project.path);
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        tracing::error!("failed to spawn shell: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    drop(pair.slave);

    let live_tab =
        LiveTab::spawn(info.clone(), pair.master, child);
    state.tabs.insert(info.id.clone(), Arc::new(live_tab));

    Ok((StatusCode::CREATED, Json(info)))
}

/// DELETE /api/tabs/{id} — close a tab and kill its PTY.
pub async fn delete_tab(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> StatusCode {
    match state.tabs.remove(&id) {
        Some(_) => StatusCode::NO_CONTENT,
        None => StatusCode::NOT_FOUND,
    }
}
