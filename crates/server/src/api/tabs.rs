use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::Deserialize;

use crate::events::EventKind;
use crate::pty::live_tab::{DEFAULT_SCROLLBACK, LiveTab, TabInfo};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct CreateTabRequest {
    pub project_id: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTabRequest {
    pub label: Option<String>,
    pub position: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct ListTabsParams {
    #[serde(default = "default_session_id")]
    pub session_id: String,
}

fn default_session_id() -> String {
    "default".to_string()
}

/// GET /api/tabs?session_id=default
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

/// POST /api/tabs
pub async fn create_tab(
    State(state): State<AppState>,
    Json(req): Json<CreateTabRequest>,
) -> Result<(StatusCode, Json<TabInfo>), StatusCode> {
    // Validate project exists
    let projects = state
        .load_projects()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let project = projects
        .iter()
        .find(|p| p.id == req.project_id)
        .ok_or(StatusCode::NOT_FOUND)?;

    let tab_num = state.next_tab_num.fetch_add(1, Ordering::Relaxed);

    // Position: after all existing tabs
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
        project_id: req.project_id.clone(),
        label: format!("Terminal {}", tab_num),
        tab_type: "terminal".to_string(),
        position: max_pos + 1.0,
        created_at,
    };

    // Spawn PTY
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

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&project.path);
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        tracing::error!("failed to spawn shell: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    drop(pair.slave);

    let live_tab = LiveTab::spawn(info.clone(), pair.master, child, DEFAULT_SCROLLBACK);
    let mut close_rx = live_tab.close_tx.subscribe();
    let tab = Arc::new(live_tab);
    state.tabs.insert(info.id.clone(), tab);

    // Emit event
    state.events.emit(EventKind::TabCreated(info.clone()));

    // Auto-remove tab when shell exits
    {
        let tabs = state.tabs.clone();
        let events = state.events.clone();
        let id = info.id.clone();
        tokio::spawn(async move {
            let _ = close_rx.recv().await;
            // Only emit if we're the one removing the tab.
            // delete_tab/delete_project may have already done it.
            if tabs.remove(&id).is_some() {
                events.emit(EventKind::TabClosed { tab_id: id });
            }
        });
    }

    Ok((StatusCode::CREATED, Json(info)))
}

/// DELETE /api/tabs/{id}
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

/// PATCH /api/tabs/{id}
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
