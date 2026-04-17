use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use portable_pty::{CommandBuilder, NativePtySystem, PtySystem};
use reqwest::Url;
use serde::Deserialize;
use tokio::time::{self, MissedTickBehavior};
use utoipa::{IntoParams, ToSchema};

use crate::api::files::ApiErrorResponse;
use crate::api::worktrees::resolve_worktree;
use crate::events::EventKind;
use crate::pty::live_tab::{DEFAULT_SCROLLBACK, LiveTab, TerminalSize};
use crate::state::AppState;
use crate::tab::{
    GitDiffScope, TabInfo, TerminalTabLabels, WorktreePaneNode, WorktreePaneTabs,
    WorktreeTabLayout, WorktreeTabLayoutState,
};

type TerminalCloseReceiver = tokio::sync::broadcast::Receiver<()>;
type TerminalNotificationReceiver = tokio::sync::broadcast::Receiver<()>;
type TerminalTitleReceiver = tokio::sync::broadcast::Receiver<Option<String>>;

const MISSING_COMMIT_ID_MESSAGE: &str = "commit_id is required for commit diffs.";
const MISSING_BROWSER_URL_MESSAGE: &str = "url is required for browser tabs.";
const INVALID_BROWSER_URL_MESSAGE: &str =
    "Browser tabs only support http://, https://, and about:blank URLs.";
const INVALID_BROWSER_HISTORY_MESSAGE: &str = "history_index must point at an entry in history.";
const BROWSER_FIELDS_REQUIRE_BROWSER_TAB_MESSAGE: &str =
    "Browser tab fields can only be updated on browser tabs.";
const INVALID_LAYOUT_MESSAGE: &str = "Invalid tab layout.";
const BLANK_BROWSER_URL: &str = "about:blank";

#[derive(Debug)]
pub struct TabsApiError {
    status: StatusCode,
    message: String,
}

impl TabsApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl IntoResponse for TabsApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ApiErrorResponse {
                message: self.message,
            }),
        )
            .into_response()
    }
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CreateTabRequest {
    Terminal {
        worktree_id: String,
        #[serde(default)]
        pane_id: Option<String>,
    },
    File {
        worktree_id: String,
        path: String,
        #[serde(default)]
        pane_id: Option<String>,
        #[serde(default)]
        preview: bool,
    },
    GitDiff {
        worktree_id: String,
        path: String,
        #[serde(default)]
        pane_id: Option<String>,
        scope: GitDiffScope,
        #[serde(default)]
        original_path: Option<String>,
        #[serde(default)]
        commit_id: Option<String>,
        #[serde(default)]
        preview: bool,
    },
    Browser {
        worktree_id: String,
        #[serde(default)]
        pane_id: Option<String>,
        url: String,
    },
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateTabRequest {
    #[serde(default)]
    pub custom_label: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub history: Option<Vec<String>>,
    #[serde(default)]
    pub history_index: Option<usize>,
    pub position: Option<f64>,
    pub preview: Option<bool>,
    pub has_notification: Option<bool>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ReorderTabsRequest {
    pub worktree_id: String,
    pub pane_id: String,
    pub tab_ids: Vec<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorktreeTabLayoutRequest {
    pub root_id: String,
    pub nodes: Vec<WorktreePaneNode>,
    pub panes: Vec<WorktreePaneTabs>,
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
        CreateTabRequest::Terminal { worktree_id, .. }
        | CreateTabRequest::File { worktree_id, .. }
        | CreateTabRequest::GitDiff { worktree_id, .. }
        | CreateTabRequest::Browser { worktree_id, .. } => worktree_id,
    }
}

fn pane_id_for_create(req: &CreateTabRequest) -> Option<&str> {
    match req {
        CreateTabRequest::Terminal { pane_id, .. }
        | CreateTabRequest::File { pane_id, .. }
        | CreateTabRequest::GitDiff { pane_id, .. }
        | CreateTabRequest::Browser { pane_id, .. } => pane_id.as_deref(),
    }
}

fn normalize_browser_url(raw: &str) -> Result<String, TabsApiError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(TabsApiError::new(
            StatusCode::BAD_REQUEST,
            MISSING_BROWSER_URL_MESSAGE,
        ));
    }

    if trimmed == BLANK_BROWSER_URL {
        return Ok(BLANK_BROWSER_URL.to_string());
    }

    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        let host = trimmed
            .split('/')
            .next()
            .unwrap_or_default()
            .split('?')
            .next()
            .unwrap_or_default()
            .split('#')
            .next()
            .unwrap_or_default();
        let is_localish = host.starts_with("localhost")
            || host.starts_with("127.0.0.1")
            || host.starts_with("[::1]");
        let has_port = host
            .rsplit_once(':')
            .is_some_and(|(hostname, port)| !hostname.is_empty() && port.parse::<u16>().is_ok());
        if !is_localish && !has_port {
            return Err(TabsApiError::new(
                StatusCode::BAD_REQUEST,
                INVALID_BROWSER_URL_MESSAGE,
            ));
        }
        format!("http://{trimmed}")
    };

    let parsed = Url::parse(&candidate)
        .map_err(|_| TabsApiError::new(StatusCode::BAD_REQUEST, INVALID_BROWSER_URL_MESSAGE))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(TabsApiError::new(
            StatusCode::BAD_REQUEST,
            INVALID_BROWSER_URL_MESSAGE,
        ));
    }

    Ok(parsed.to_string())
}

fn browser_tab_label(url: &str) -> String {
    if url == BLANK_BROWSER_URL {
        return "New Browser".to_string();
    }

    Url::parse(url)
        .ok()
        .and_then(|parsed| {
            parsed
                .host_str()
                .filter(|host| !host.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| url.to_string())
}

fn validate_create_tab_request(req: &mut CreateTabRequest) -> Result<(), TabsApiError> {
    match req {
        CreateTabRequest::GitDiff {
            scope, commit_id, ..
        } => {
            if *scope != GitDiffScope::Commit {
                *commit_id = None;
                return Ok(());
            }

            let normalized = commit_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    TabsApiError::new(StatusCode::BAD_REQUEST, MISSING_COMMIT_ID_MESSAGE)
                })?
                .to_string();
            *commit_id = Some(normalized);
            Ok(())
        }
        CreateTabRequest::Browser { url, .. } => {
            *url = normalize_browser_url(url)?;
            Ok(())
        }
        CreateTabRequest::Terminal { .. } | CreateTabRequest::File { .. } => Ok(()),
    }
}

fn map_status_to_tab_error(status: StatusCode) -> TabsApiError {
    let message = match status {
        StatusCode::BAD_REQUEST => "Invalid tab request.",
        StatusCode::NOT_FOUND => "Worktree not found.",
        _ => "Internal server error.",
    };
    TabsApiError::new(status, message)
}

fn normalize_custom_label(label: &str) -> Option<String> {
    let trimmed = label.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn next_terminal_number(state: &AppState, worktree_id: &str) -> u32 {
    let mut next = state
        .next_terminal_num_by_worktree
        .entry(worktree_id.to_string())
        .or_insert(1);
    let current = *next;
    *next += 1;
    current
}

fn make_pane_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn make_layout_node_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn normalize_split_ratio(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.15, 0.85)
    } else {
        0.5
    }
}

fn default_worktree_layout(pane_id: String) -> WorktreeTabLayout {
    let root_id = make_layout_node_id();
    WorktreeTabLayout {
        root_id: root_id.clone(),
        nodes: vec![WorktreePaneNode::Leaf {
            id: root_id,
            pane_id,
        }],
    }
}

fn layout_nodes_by_id(
    layout: &WorktreeTabLayout,
) -> Result<HashMap<String, WorktreePaneNode>, TabsApiError> {
    if layout.root_id.trim().is_empty() || layout.nodes.is_empty() {
        return Err(TabsApiError::new(
            StatusCode::BAD_REQUEST,
            INVALID_LAYOUT_MESSAGE,
        ));
    }

    layout
        .nodes
        .iter()
        .try_fold(HashMap::new(), |mut nodes, node| {
            let node_id = match node {
                WorktreePaneNode::Leaf { id, .. } | WorktreePaneNode::Split { id, .. } => id,
            };

            if node_id.trim().is_empty() || nodes.insert(node_id.clone(), node.clone()).is_some() {
                return Err(TabsApiError::new(
                    StatusCode::BAD_REQUEST,
                    INVALID_LAYOUT_MESSAGE,
                ));
            }

            Ok(nodes)
        })
}

fn collect_layout_leaf_panes(layout: &WorktreeTabLayout) -> Result<Vec<String>, TabsApiError> {
    let nodes = layout_nodes_by_id(layout)?;
    let mut pane_ids = Vec::new();
    let mut seen_panes = HashSet::new();
    let mut visited = HashSet::new();
    let mut stack = vec![layout.root_id.clone()];

    while let Some(node_id) = stack.pop() {
        if !visited.insert(node_id.clone()) {
            return Err(TabsApiError::new(
                StatusCode::BAD_REQUEST,
                INVALID_LAYOUT_MESSAGE,
            ));
        }

        match nodes.get(&node_id) {
            Some(WorktreePaneNode::Leaf { pane_id, .. }) => {
                if pane_id.trim().is_empty() || !seen_panes.insert(pane_id.clone()) {
                    return Err(TabsApiError::new(
                        StatusCode::BAD_REQUEST,
                        INVALID_LAYOUT_MESSAGE,
                    ));
                }
                pane_ids.push(pane_id.clone());
            }
            Some(WorktreePaneNode::Split {
                ratio,
                first_id,
                second_id,
                ..
            }) => {
                if !ratio.is_finite()
                    || !(0.0..=1.0).contains(ratio)
                    || first_id.trim().is_empty()
                    || second_id.trim().is_empty()
                    || first_id == second_id
                {
                    return Err(TabsApiError::new(
                        StatusCode::BAD_REQUEST,
                        INVALID_LAYOUT_MESSAGE,
                    ));
                }
                stack.push(second_id.clone());
                stack.push(first_id.clone());
            }
            None => {
                return Err(TabsApiError::new(
                    StatusCode::BAD_REQUEST,
                    INVALID_LAYOUT_MESSAGE,
                ));
            }
        }
    }

    if pane_ids.is_empty() || visited.len() != nodes.len() {
        return Err(TabsApiError::new(
            StatusCode::BAD_REQUEST,
            INVALID_LAYOUT_MESSAGE,
        ));
    }

    Ok(pane_ids)
}

fn first_layout_pane_id(layout: &WorktreeTabLayout) -> Option<String> {
    let nodes = layout_nodes_by_id(layout).ok()?;
    let mut next_id = layout.root_id.clone();

    loop {
        match nodes.get(&next_id) {
            Some(WorktreePaneNode::Leaf { pane_id, .. }) => {
                return Some(pane_id.clone());
            }
            Some(WorktreePaneNode::Split { first_id, .. }) => {
                next_id = first_id.clone();
            }
            None => return None,
        }
    }
}

fn sort_worktree_tabs(tabs: &mut [TabInfo]) {
    tabs.sort_by(|left, right| {
        left.pane_id()
            .cmp(right.pane_id())
            .then_with(|| {
                left.position()
                    .partial_cmp(&right.position())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| left.created_at().cmp(&right.created_at()))
            .then_with(|| left.id().cmp(right.id()))
    });
}

fn worktree_tabs(state: &AppState, worktree_id: &str) -> Vec<TabInfo> {
    let mut tabs: Vec<_> = state
        .tabs
        .iter()
        .filter(|entry| entry.value().worktree_id() == worktree_id)
        .map(|entry| entry.value().clone())
        .collect();
    sort_worktree_tabs(&mut tabs);
    tabs
}

fn collapse_empty_panes(
    layout: &WorktreeTabLayout,
    pane_tab_ids: &HashMap<String, Vec<String>>,
) -> Result<WorktreeTabLayout, TabsApiError> {
    fn rebuild_node(
        node_id: &str,
        nodes: &HashMap<String, WorktreePaneNode>,
        pane_tab_ids: &HashMap<String, Vec<String>>,
        fallback_pane_id: &str,
        is_root: bool,
    ) -> Result<Option<(String, Vec<WorktreePaneNode>)>, TabsApiError> {
        match nodes.get(node_id) {
            Some(WorktreePaneNode::Leaf { pane_id, .. }) => {
                let has_tabs = pane_tab_ids
                    .get(pane_id)
                    .is_some_and(|tab_ids| !tab_ids.is_empty());
                if !is_root && !has_tabs {
                    return Ok(None);
                }

                Ok(Some((
                    node_id.to_string(),
                    vec![WorktreePaneNode::Leaf {
                        id: node_id.to_string(),
                        pane_id: pane_id.clone(),
                    }],
                )))
            }
            Some(WorktreePaneNode::Split {
                axis,
                ratio,
                first_id,
                second_id,
                ..
            }) => {
                let next_first =
                    rebuild_node(first_id, nodes, pane_tab_ids, fallback_pane_id, false)?;
                let next_second =
                    rebuild_node(second_id, nodes, pane_tab_ids, fallback_pane_id, false)?;

                match (next_first, next_second) {
                    (
                        Some((first_root_id, mut first_nodes)),
                        Some((second_root_id, second_nodes)),
                    ) => {
                        first_nodes.extend(second_nodes);
                        first_nodes.push(WorktreePaneNode::Split {
                            id: node_id.to_string(),
                            axis: *axis,
                            ratio: normalize_split_ratio(*ratio),
                            first_id: first_root_id,
                            second_id: second_root_id,
                        });
                        Ok(Some((node_id.to_string(), first_nodes)))
                    }
                    (Some(child), None) | (None, Some(child)) => Ok(Some(child)),
                    (None, None) if is_root => {
                        let next_id = make_layout_node_id();
                        Ok(Some((
                            next_id.clone(),
                            vec![WorktreePaneNode::Leaf {
                                id: next_id,
                                pane_id: fallback_pane_id.to_string(),
                            }],
                        )))
                    }
                    (None, None) => Ok(None),
                }
            }
            None => Err(TabsApiError::new(
                StatusCode::BAD_REQUEST,
                INVALID_LAYOUT_MESSAGE,
            )),
        }
    }

    let pane_ids = collect_layout_leaf_panes(layout)?;
    let nodes = layout_nodes_by_id(layout)?;
    let fallback_pane_id = pane_ids.first().cloned().unwrap_or_else(make_pane_id);
    let Some((root_id, nodes)) = rebuild_node(
        &layout.root_id,
        &nodes,
        pane_tab_ids,
        &fallback_pane_id,
        true,
    )?
    else {
        return Err(TabsApiError::new(
            StatusCode::BAD_REQUEST,
            INVALID_LAYOUT_MESSAGE,
        ));
    };

    Ok(WorktreeTabLayout { root_id, nodes })
}

fn emit_layout_updated(
    state: &AppState,
    worktree_id: &str,
    layout: &WorktreeTabLayout,
    tabs: Vec<TabInfo>,
) {
    state.events.emit(EventKind::WorktreeTabLayoutUpdated {
        worktree_id: worktree_id.to_string(),
        state: Box::new(WorktreeTabLayoutState {
            layout: layout.clone(),
            tabs,
        }),
    });
}

fn reconcile_worktree_layout(state: &AppState, worktree_id: &str) {
    let Some(existing) = state
        .tab_layouts
        .get(worktree_id)
        .map(|entry| entry.clone())
    else {
        return;
    };

    let tabs = worktree_tabs(state, worktree_id);
    let pane_tab_ids = tabs
        .iter()
        .fold(HashMap::<String, Vec<String>>::new(), |mut map, tab| {
            map.entry(tab.pane_id().to_string())
                .or_default()
                .push(tab.id().to_string());
            map
        });
    let Ok(next_layout) = collapse_empty_panes(&existing, &pane_tab_ids) else {
        tracing::warn!(
            worktree_id,
            "skipping tab layout reconciliation because the current layout is invalid"
        );
        return;
    };

    if next_layout != existing {
        state
            .tab_layouts
            .insert(worktree_id.to_string(), next_layout.clone());
        emit_layout_updated(state, worktree_id, &next_layout, tabs);
    }
}

fn update_worktree_layout_state(
    state: &AppState,
    worktree_id: &str,
    request: UpdateWorktreeTabLayoutRequest,
) -> Result<WorktreeTabLayoutState, TabsApiError> {
    let layout = WorktreeTabLayout {
        root_id: request.root_id,
        nodes: request.nodes,
    };
    let pane_ids = collect_layout_leaf_panes(&layout)?;
    let current_tabs = worktree_tabs(state, worktree_id);
    let current_tab_ids: HashSet<String> = current_tabs
        .iter()
        .map(|tab| tab.id().to_string())
        .collect();

    let pane_map = request.panes.into_iter().try_fold(
        HashMap::<String, Vec<String>>::new(),
        |mut map, pane| {
            if !pane_ids.iter().any(|pane_id| pane_id == &pane.pane_id)
                || map.contains_key(&pane.pane_id)
            {
                return Err(TabsApiError::new(
                    StatusCode::BAD_REQUEST,
                    INVALID_LAYOUT_MESSAGE,
                ));
            }
            map.insert(pane.pane_id, pane.tab_ids);
            Ok(map)
        },
    )?;

    if pane_map.len() != pane_ids.len() {
        return Err(TabsApiError::new(
            StatusCode::BAD_REQUEST,
            INVALID_LAYOUT_MESSAGE,
        ));
    }

    let mut seen_tab_ids = HashSet::new();
    for tab_ids in pane_map.values() {
        for tab_id in tab_ids {
            if !seen_tab_ids.insert(tab_id.clone()) {
                return Err(TabsApiError::new(
                    StatusCode::BAD_REQUEST,
                    INVALID_LAYOUT_MESSAGE,
                ));
            }
        }
    }
    if seen_tab_ids != current_tab_ids {
        return Err(TabsApiError::new(
            StatusCode::BAD_REQUEST,
            INVALID_LAYOUT_MESSAGE,
        ));
    }

    for pane_id in &pane_ids {
        if let Some(tab_ids) = pane_map.get(pane_id) {
            for (index, tab_id) in tab_ids.iter().enumerate() {
                if let Some(mut tab) = state.tabs.get_mut(tab_id) {
                    tab.set_pane_id(pane_id.clone());
                    tab.set_position((index + 1) as f64);
                }
            }
        }
    }

    state
        .tab_layouts
        .insert(worktree_id.to_string(), layout.clone());
    let tabs = worktree_tabs(state, worktree_id);
    Ok(WorktreeTabLayoutState { layout, tabs })
}

fn build_tab_info(
    req: CreateTabRequest,
    id: String,
    pane_id: String,
    position: f64,
    created_at: u64,
    terminal_number: u32,
) -> TabInfo {
    match req {
        CreateTabRequest::Terminal { worktree_id, .. } => TabInfo::Terminal {
            id,
            session_id: "default".to_string(),
            worktree_id,
            pane_id,
            label: format!("Terminal {}", terminal_number),
            position,
            created_at,
            preview: false,
            has_notification: false,
            labels: TerminalTabLabels {
                custom_label: None,
                process_label: None,
                title_label: None,
            },
        },
        CreateTabRequest::File {
            worktree_id,
            path,
            preview,
            ..
        } => TabInfo::File {
            id,
            session_id: "default".to_string(),
            worktree_id,
            pane_id,
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
            commit_id,
            preview,
            ..
        } => TabInfo::GitDiff {
            id,
            session_id: "default".to_string(),
            worktree_id,
            pane_id,
            label: tab_basename(&path),
            position,
            created_at,
            preview,
            path,
            scope,
            original_path,
            commit_id,
        },
        CreateTabRequest::Browser {
            worktree_id, url, ..
        } => TabInfo::Browser {
            id,
            session_id: "default".to_string(),
            worktree_id,
            pane_id,
            label: browser_tab_label(&url),
            position,
            created_at,
            preview: false,
            history: vec![url.clone()],
            history_index: 0,
            url,
        },
    }
}

fn has_browser_update_fields(req: &UpdateTabRequest) -> bool {
    req.label.is_some() || req.url.is_some() || req.history.is_some() || req.history_index.is_some()
}

struct ValidatedBrowserUpdate {
    label: Option<String>,
    url: Option<String>,
    history: Option<Vec<String>>,
    history_index: Option<usize>,
}

fn validate_browser_update(
    tab: &TabInfo,
    req: &UpdateTabRequest,
) -> Result<ValidatedBrowserUpdate, TabsApiError> {
    if !tab.is_browser() {
        return Ok(ValidatedBrowserUpdate {
            label: None,
            url: None,
            history: None,
            history_index: None,
        });
    }

    let label = req.label.as_deref().map(|label| label.trim().to_string());
    let url = req.url.as_deref().map(normalize_browser_url).transpose()?;
    let history = req
        .history
        .as_ref()
        .map(|history| {
            history
                .iter()
                .map(|entry| normalize_browser_url(entry))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;
    let history_index = req.history_index;

    let next_history = history
        .clone()
        .or_else(|| tab.history().map(|history| history.to_vec()))
        .unwrap_or_default();
    let next_history_index = history_index
        .or_else(|| tab.history_index())
        .unwrap_or_default();

    if next_history.is_empty() || next_history_index >= next_history.len() {
        return Err(TabsApiError::new(
            StatusCode::BAD_REQUEST,
            INVALID_BROWSER_HISTORY_MESSAGE,
        ));
    }

    Ok(ValidatedBrowserUpdate {
        label,
        url,
        history,
        history_index,
    })
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

fn spawn_terminal_title_task(
    state: &AppState,
    id: String,
    mut title_rx: TerminalTitleReceiver,
    mut close_rx: TerminalCloseReceiver,
) {
    let tabs = state.tabs.clone();
    let terminal_tabs = state.terminal_tabs.clone();
    let events = state.events.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                result = title_rx.recv() => {
                    let next_title = match result {
                        Ok(title) => title,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };

                    let Some(updated) = ({
                        let Some(mut tab) = tabs.get_mut(&id) else {
                            break;
                        };
                        if tab.title_label() == next_title.as_deref() {
                            None
                        } else {
                            tab.set_title_label(next_title.clone());
                            Some(tab.clone())
                        }
                    }) else {
                        continue;
                    };

                    if let Some(runtime) = terminal_tabs.get(&id) {
                        runtime.update_info(|info| {
                            info.set_title_label(next_title.clone());
                            info.clone()
                        });
                    }

                    events.emit(EventKind::TabUpdated {
                        session_id: updated.session_id().to_string(),
                        tab: updated,
                    });
                }
                _ = close_rx.recv() => break,
            }
        }
    });
}

fn spawn_terminal_process_label_task(
    state: &AppState,
    id: String,
    runtime: Arc<LiveTab>,
    mut close_rx: TerminalCloseReceiver,
) {
    let tabs = state.tabs.clone();
    let terminal_tabs = state.terminal_tabs.clone();
    let events = state.events.clone();
    tokio::spawn(async move {
        let mut interval = time::interval(std::time::Duration::from_millis(750));
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    let runtime = runtime.clone();
                    let Ok(next_process_label) = tokio::task::spawn_blocking(move || {
                        runtime.resolve_process_label()
                    }).await else {
                        continue;
                    };
                    let Some(updated) = ({
                        let Some(mut tab) = tabs.get_mut(&id) else {
                            break;
                        };
                        if tab.process_label() == next_process_label.as_deref() {
                            None
                        } else {
                            tab.set_process_label(next_process_label.clone());
                            Some(tab.clone())
                        }
                    }) else {
                        continue;
                    };

                    if let Some(live_tab) = terminal_tabs.get(&id) {
                        live_tab.update_info(|info| {
                            info.set_process_label(next_process_label.clone());
                            info.clone()
                        });
                    }

                    events.emit(EventKind::TabUpdated {
                        session_id: updated.session_id().to_string(),
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
    let tab_layouts = state.tab_layouts.clone();
    let events = state.events.clone();
    tokio::spawn(async move {
        let _ = close_rx.recv().await;
        terminal_tabs.remove(&id);
        if let Some((_, tab)) = tabs.remove(&id) {
            events.emit(EventKind::TabClosed {
                session_id: tab.session_id().to_string(),
                tab_id: id,
            });
            let worktree_id = tab.worktree_id().to_string();
            let layout = tab_layouts.get(&worktree_id).map(|entry| entry.clone());
            if let Some(layout) = layout {
                let remaining_tabs = {
                    let mut next_tabs: Vec<_> = tabs
                        .iter()
                        .filter(|entry| entry.value().worktree_id() == worktree_id)
                        .map(|entry| entry.value().clone())
                        .collect();
                    sort_worktree_tabs(&mut next_tabs);
                    next_tabs
                };
                let pane_tab_ids = remaining_tabs.iter().fold(
                    HashMap::<String, Vec<String>>::new(),
                    |mut map, next_tab| {
                        map.entry(next_tab.pane_id().to_string())
                            .or_default()
                            .push(next_tab.id().to_string());
                        map
                    },
                );
                let Ok(next_layout) = collapse_empty_panes(&layout, &pane_tab_ids) else {
                    tracing::warn!(
                        worktree_id,
                        "skipping terminal cleanup layout update because the current layout is invalid"
                    );
                    return;
                };
                if next_layout != layout {
                    tab_layouts.insert(worktree_id.clone(), next_layout.clone());
                    events.emit(EventKind::WorktreeTabLayoutUpdated {
                        worktree_id,
                        state: Box::new(WorktreeTabLayoutState {
                            layout: next_layout,
                            tabs: remaining_tabs,
                        }),
                    });
                }
            }
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
        (status = 400, description = "Invalid tab request", body = ApiErrorResponse),
        (status = 404, description = "Worktree not found", body = ApiErrorResponse),
        (status = 500, description = "Internal server error", body = ApiErrorResponse),
    ),
)]
pub async fn create_tab(
    State(state): State<AppState>,
    Json(mut req): Json<CreateTabRequest>,
) -> Result<(StatusCode, Json<TabInfo>), TabsApiError> {
    validate_create_tab_request(&mut req)?;

    let worktree_id = worktree_id_for_create(&req).to_string();
    let resolved = resolve_worktree(&state, &worktree_id)
        .await
        .map_err(map_status_to_tab_error)?
        .ok_or_else(|| map_status_to_tab_error(StatusCode::NOT_FOUND))?;

    let terminal_number = if matches!(req, CreateTabRequest::Terminal { .. }) {
        next_terminal_number(&state, &worktree_id)
    } else {
        0
    };
    let requested_pane_id = pane_id_for_create(&req).map(str::to_string);
    let existing_layout = state
        .tab_layouts
        .get(&worktree_id)
        .map(|entry| entry.clone());
    let pane_id = if let Some(layout) = existing_layout.as_ref() {
        let pane_ids = collect_layout_leaf_panes(layout)?;
        requested_pane_id
            .filter(|requested| pane_ids.iter().any(|pane_id| pane_id == requested))
            .or_else(|| first_layout_pane_id(layout))
            .unwrap_or_else(make_pane_id)
    } else {
        let pane_id = requested_pane_id.unwrap_or_else(make_pane_id);
        state.tab_layouts.insert(
            worktree_id.clone(),
            default_worktree_layout(pane_id.clone()),
        );
        pane_id
    };

    let max_pos = state
        .tabs
        .iter()
        .filter(|entry| {
            let tab = entry.value();
            tab.worktree_id() == worktree_id && tab.pane_id() == pane_id
        })
        .map(|entry| entry.value().position())
        .fold(0.0_f64, f64::max);
    let info = build_tab_info(
        req,
        uuid::Uuid::new_v4().to_string(),
        pane_id,
        max_pos + 1.0,
        now_ms(),
        terminal_number,
    );

    let terminal_runtime = if info.is_terminal() {
        Some(
            spawn_terminal_runtime(&resolved.worktree.path, info.clone())
                .map_err(map_status_to_tab_error)?,
        )
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
    if existing_layout.is_none()
        && let Some(layout) = state
            .tab_layouts
            .get(&worktree_id)
            .map(|entry| entry.clone())
    {
        emit_layout_updated(
            &state,
            &worktree_id,
            &layout,
            worktree_tabs(&state, &worktree_id),
        );
    }
    if let Some((runtime, close_rx)) = terminal_runtime {
        let tab_id = info.id().to_string();
        spawn_terminal_notification_task(
            &state,
            tab_id.clone(),
            runtime.notification_tx.subscribe(),
            runtime.close_tx.subscribe(),
        );
        spawn_terminal_title_task(
            &state,
            tab_id.clone(),
            runtime.title_tx.subscribe(),
            runtime.close_tx.subscribe(),
        );
        spawn_terminal_process_label_task(
            &state,
            tab_id.clone(),
            runtime.clone(),
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
    reconcile_worktree_layout(&state, removed_tab.worktree_id());
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
        (status = 400, description = "Invalid tab update", body = ApiErrorResponse),
        (status = 404, description = "Tab not found"),
    ),
)]
pub async fn update_tab(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateTabRequest>,
) -> Result<Json<TabInfo>, TabsApiError> {
    let updated = {
        let mut tab = state
            .tabs
            .get_mut(&id)
            .ok_or_else(|| TabsApiError::new(StatusCode::NOT_FOUND, "Tab not found."))?;

        if has_browser_update_fields(&req) && !tab.is_browser() {
            return Err(TabsApiError::new(
                StatusCode::BAD_REQUEST,
                BROWSER_FIELDS_REQUIRE_BROWSER_TAB_MESSAGE,
            ));
        }

        let browser_update = validate_browser_update(&tab, &req)?;

        if let Some(position) = req.position {
            tab.set_position(position);
        }
        if let Some(preview) = req.preview {
            tab.set_preview(preview);
        }
        if let Some(custom_label) = req.custom_label.as_deref()
            && matches!(&*tab, TabInfo::Terminal { .. })
        {
            tab.set_custom_label(normalize_custom_label(custom_label));
        }
        if let Some(has_notification) = req.has_notification
            && matches!(&*tab, TabInfo::Terminal { .. })
        {
            tab.set_has_notification(has_notification);
        }
        if let Some(label) = browser_update.label {
            tab.set_label(label);
        }
        if let Some(url) = browser_update.url {
            tab.set_url(url);
        }
        if let Some(history) = browser_update.history {
            tab.set_history(history);
        }
        if let Some(history_index) = browser_update.history_index {
            tab.set_history_index(history_index);
        }

        tab.clone()
    };

    // Sync notification state to LiveTab's internal info
    if req.has_notification.is_some()
        && let Some(lt) = state.terminal_tabs.get(&id)
    {
        lt.update_info(|info| {
            info.set_has_notification(updated.has_notification());
            if req.custom_label.is_some() {
                info.set_custom_label(updated.custom_label().map(str::to_string));
            }
            info.clone()
        });
    }
    if req.has_notification.is_none()
        && req.custom_label.is_some()
        && let Some(lt) = state.terminal_tabs.get(&id)
    {
        lt.update_info(|info| {
            info.set_custom_label(updated.custom_label().map(str::to_string));
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
    path = "/api/projects/{id}/worktrees/{worktree_id}/tab-layout",
    params(
        ("id" = String, Path, description = "Project ID"),
        ("worktree_id" = String, Path, description = "Worktree ID"),
    ),
    request_body = UpdateWorktreeTabLayoutRequest,
    responses(
        (status = 200, description = "Worktree tab layout updated", body = WorktreeTabLayoutState),
        (status = 400, description = "Invalid tab layout", body = ApiErrorResponse),
        (status = 404, description = "Worktree not found", body = ApiErrorResponse),
    ),
)]
pub async fn update_worktree_tab_layout(
    State(state): State<AppState>,
    Path((_project_id, worktree_id)): Path<(String, String)>,
    Json(request): Json<UpdateWorktreeTabLayoutRequest>,
) -> Result<Json<WorktreeTabLayoutState>, TabsApiError> {
    resolve_worktree(&state, &worktree_id)
        .await
        .map_err(map_status_to_tab_error)?
        .ok_or_else(|| map_status_to_tab_error(StatusCode::NOT_FOUND))?;

    let next_state = update_worktree_layout_state(&state, &worktree_id, request)?;
    emit_layout_updated(
        &state,
        &worktree_id,
        &next_state.layout,
        next_state.tabs.clone(),
    );
    Ok(Json(next_state))
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
) -> Result<Json<Vec<TabInfo>>, TabsApiError> {
    let tabs_in_worktree: Vec<TabInfo> = state
        .tabs
        .iter()
        .filter(|entry| entry.value().worktree_id() == req.worktree_id)
        .map(|entry| entry.value().clone())
        .collect();
    let pane_tab_ids: HashSet<String> = tabs_in_worktree
        .iter()
        .filter(|tab| tab.pane_id() == req.pane_id)
        .map(|tab| tab.id().to_string())
        .collect();

    if pane_tab_ids.len() != req.tab_ids.len() {
        return Err(TabsApiError::new(
            StatusCode::BAD_REQUEST,
            INVALID_LAYOUT_MESSAGE,
        ));
    }

    let received: HashSet<String> = req.tab_ids.iter().cloned().collect();
    if pane_tab_ids != received {
        return Err(TabsApiError::new(
            StatusCode::BAD_REQUEST,
            INVALID_LAYOUT_MESSAGE,
        ));
    }

    let Some(first_tab) = tabs_in_worktree.first() else {
        return Ok(Json(vec![]));
    };
    let session_id = first_tab.session_id().to_string();
    if tabs_in_worktree
        .iter()
        .any(|tab| tab.session_id() != session_id)
    {
        return Err(TabsApiError::new(
            StatusCode::BAD_REQUEST,
            INVALID_LAYOUT_MESSAGE,
        ));
    }

    for (index, id) in req.tab_ids.iter().enumerate() {
        if let Some(mut tab) = state.tabs.get_mut(id) {
            tab.set_position((index + 1) as f64);
        }
    }

    let reordered = worktree_tabs(&state, &req.worktree_id);

    state.events.emit(EventKind::TabsReordered {
        session_id,
        worktree_id: req.worktree_id,
        tabs: reordered.clone(),
    });

    Ok(Json(reordered))
}
