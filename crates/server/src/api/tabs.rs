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
use crate::pty::live_tab::{DEFAULT_SCROLLBACK, LiveTab, TerminalSize};
use crate::state::AppState;
use crate::tab::{GitDiffScope, TabInfo};

type TerminalCloseReceiver = tokio::sync::broadcast::Receiver<()>;

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CreateTabRequest {
    Terminal {
        worktree_id: String,
    },
    File {
        worktree_id: String,
        path: String,
        #[serde(default)]
        preview: bool,
    },
    GitDiff {
        worktree_id: String,
        path: String,
        scope: GitDiffScope,
        #[serde(default)]
        original_path: Option<String>,
        #[serde(default)]
        preview: bool,
    },
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateTabRequest {
    pub label: Option<String>,
    pub position: Option<f64>,
    pub preview: Option<bool>,
    pub has_notification: Option<bool>,
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

fn tab_basename(path: &str) -> String {
    path.rsplit('/')
        .find(|segment| !segment.is_empty())
        .map_or_else(|| path.to_string(), |segment| segment.to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn worktree_id_for_create(req: &CreateTabRequest) -> &str {
    match req {
        CreateTabRequest::Terminal { worktree_id }
        | CreateTabRequest::File { worktree_id, .. }
        | CreateTabRequest::GitDiff { worktree_id, .. } => worktree_id,
    }
}

fn build_tab_info(
    req: CreateTabRequest,
    id: String,
    position: f64,
    created_at: u64,
    terminal_number: u32,
) -> TabInfo {
    match req {
        CreateTabRequest::Terminal { worktree_id } => TabInfo::Terminal {
            id,
            session_id: "default".to_string(),
            worktree_id,
            label: format!("Terminal {}", terminal_number),
            position,
            created_at,
            preview: false,
            has_notification: false,
        },
        CreateTabRequest::File {
            worktree_id,
            path,
            preview,
        } => TabInfo::File {
            id,
            session_id: "default".to_string(),
            worktree_id,
            label: tab_basename(&path),
            position,
            created_at,
            preview,
            path,
        },
        CreateTabRequest::GitDiff {
            worktree_id,
            path,
            scope,
            original_path,
            preview,
        } => TabInfo::GitDiff {
            id,
            session_id: "default".to_string(),
            worktree_id,
            label: tab_basename(&path),
            position,
            created_at,
            preview,
            path,
            scope,
            original_path,
        },
    }
}

fn spawn_terminal_runtime(
    worktree_path: &str,
    info: TabInfo,
) -> Result<(Arc<LiveTab>, TerminalCloseReceiver), StatusCode> {
    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(TerminalSize::default_pty().to_pty_size())
        .map_err(|error| {
            tracing::error!("failed to open pty: {}", error);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(PathBuf::from(worktree_path));
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|error| {
        tracing::error!("failed to spawn shell: {}", error);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    drop(pair.slave);

    let live_tab = LiveTab::spawn(
        info,
        pair.master,
        child,
        DEFAULT_SCROLLBACK,
        TerminalSize::default_pty(),
    );

    let close_rx = live_tab.close_tx.subscribe();
    let tab = Arc::new(live_tab);
    Ok((tab, close_rx))
}

type TerminalNotificationReceiver = tokio::sync::broadcast::Receiver<()>;

fn spawn_terminal_notification_task(
    state: &AppState,
    id: String,
    mut notification_rx: TerminalNotificationReceiver,
    mut close_rx: TerminalCloseReceiver,
) {
    let tabs = state.tabs.clone();
    let terminal_tabs = state.terminal_tabs.clone();
    let events = state.events.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                result = notification_rx.recv() => {
                    match result {
                        Ok(()) => {}
                        Err(
                            tokio::sync::broadcast::error
                                ::RecvError::Lagged(_),
                        ) => continue,
                        Err(
                            tokio::sync::broadcast::error
                                ::RecvError::Closed,
                        ) => break,
                    }

                    // Only emit if transitioning false→true
                    let Some(mut tab) =
                        tabs.get_mut(&id)
                    else {
                        break;
                    };
                    if tab.has_notification() {
                        continue;
                    }
                    tab.set_has_notification(true);
                    let updated = tab.clone();
                    drop(tab);

                    // Also update LiveTab's internal copy
                    if let Some(lt) =
                        terminal_tabs.get(&id)
                    {
                        lt.update_info(|info| {
                            info.set_has_notification(true);
                            info.clone()
                        });
                    }

                    events.emit(EventKind::TabUpdated {
                        session_id: updated
                            .session_id()
                            .to_string(),
                        tab: updated,
                    });
                }
                _ = close_rx.recv() => break,
            }
        }
    });
}

fn spawn_terminal_cleanup_task(state: &AppState, id: String, mut close_rx: TerminalCloseReceiver) {
    let tabs = state.tabs.clone();
    let terminal_tabs = state.terminal_tabs.clone();
    let events = state.events.clone();
    tokio::spawn(async move {
        let _ = close_rx.recv().await;
        terminal_tabs.remove(&id);
        if let Some((_, tab)) = tabs.remove(&id) {
            events.emit(EventKind::TabClosed {
                session_id: tab.session_id().to_string(),
                tab_id: id,
            });
        }
    });
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
        .map(|entry| entry.value().clone())
        .filter(|tab| tab.session_id() == params.session_id)
        .collect();
    tabs.sort_by(|a, b| {
        a.position()
            .partial_cmp(&b.position())
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
    let worktree_id = worktree_id_for_create(&req).to_string();
    let resolved = resolve_worktree(&state, &worktree_id)
        .await?
        .ok_or(StatusCode::NOT_FOUND)?;

    let terminal_number = if matches!(req, CreateTabRequest::Terminal { .. }) {
        state.next_tab_num.fetch_add(1, Ordering::Relaxed)
    } else {
        0
    };

    let max_pos = state
        .tabs
        .iter()
        .map(|entry| entry.value().position())
        .fold(0.0_f64, f64::max);
    let info = build_tab_info(
        req,
        uuid::Uuid::new_v4().to_string(),
        max_pos + 1.0,
        now_ms(),
        terminal_number,
    );

    let terminal_runtime = if info.is_terminal() {
        Some(spawn_terminal_runtime(
            &resolved.worktree.path,
            info.clone(),
        )?)
    } else {
        None
    };

    if let Some((runtime, _)) = &terminal_runtime {
        state
            .terminal_tabs
            .insert(info.id().to_string(), runtime.clone());
    }
    state.tabs.insert(info.id().to_string(), info.clone());
    state.events.emit(EventKind::TabCreated {
        session_id: info.session_id().to_string(),
        tab: info.clone(),
    });
    if let Some((runtime, close_rx)) = terminal_runtime {
        let tab_id = info.id().to_string();
        spawn_terminal_notification_task(
            &state,
            tab_id.clone(),
            runtime.notification_tx.subscribe(),
            runtime.close_tx.subscribe(),
        );
        spawn_terminal_cleanup_task(&state, tab_id, close_rx);
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
    let removed = state.tabs.remove(&id);
    let Some((_, removed_tab)) = removed else {
        return StatusCode::NOT_FOUND;
    };

    if let Some((_, runtime)) = state.terminal_tabs.remove(&id) {
        runtime.notify_close();
    }

    state.events.emit(EventKind::TabClosed {
        session_id: removed_tab.session_id().to_string(),
        tab_id: id,
    });
    StatusCode::NO_CONTENT
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
    let updated = {
        let mut tab = state.tabs.get_mut(&id).ok_or(StatusCode::NOT_FOUND)?;

        if let Some(position) = req.position {
            tab.set_position(position);
        }
        if let Some(preview) = req.preview {
            tab.set_preview(preview);
        }
        if let Some(label) = req.label
            && matches!(&*tab, TabInfo::Terminal { .. })
        {
            tab.set_label(label);
        }
        if let Some(has_notification) = req.has_notification
            && matches!(&*tab, TabInfo::Terminal { .. })
        {
            tab.set_has_notification(has_notification);
        }

        tab.clone()
    };

    // Sync notification state to LiveTab's internal info
    if req.has_notification.is_some()
        && let Some(lt) = state.terminal_tabs.get(&id)
    {
        lt.update_info(|info| {
            info.set_has_notification(updated.has_notification());
            info.clone()
        });
    }

    state.events.emit(EventKind::TabUpdated {
        session_id: updated.session_id().to_string(),
        tab: updated.clone(),
    });
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
    let worktree_tabs: Vec<TabInfo> = state
        .tabs
        .iter()
        .filter(|entry| entry.value().worktree_id() == req.worktree_id)
        .map(|entry| entry.value().clone())
        .collect();
    let worktree_tab_ids: HashSet<String> = worktree_tabs
        .iter()
        .map(|tab| tab.id().to_string())
        .collect();

    if worktree_tab_ids.len() != req.tab_ids.len() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let received: HashSet<String> = req.tab_ids.iter().cloned().collect();
    if worktree_tab_ids != received {
        return Err(StatusCode::BAD_REQUEST);
    }

    let Some(first_tab) = worktree_tabs.first() else {
        return Ok(Json(vec![]));
    };
    let session_id = first_tab.session_id().to_string();
    if worktree_tabs
        .iter()
        .any(|tab| tab.session_id() != session_id)
    {
        return Err(StatusCode::BAD_REQUEST);
    }

    for (index, id) in req.tab_ids.iter().enumerate() {
        if let Some(mut tab) = state.tabs.get_mut(id) {
            tab.set_position((index + 1) as f64);
        }
    }

    let mut reordered: Vec<TabInfo> = state
        .tabs
        .iter()
        .filter(|entry| entry.value().worktree_id() == req.worktree_id)
        .map(|entry| entry.value().clone())
        .collect();
    reordered.sort_by(|a, b| {
        a.position()
            .partial_cmp(&b.position())
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    state.events.emit(EventKind::TabsReordered {
        session_id,
        worktree_id: req.worktree_id,
        tabs: reordered.clone(),
    });

    Ok(Json(reordered))
}
