use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use dashmap::DashMap;
use portable_pty::{CommandBuilder, NativePtySystem, PtySystem};
use reqwest::Url;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::{self, MissedTickBehavior};

use crate::chat::{ChatCreateOptions, DEFAULT_CHAT_TITLE};
use crate::domain::worktree::resolve_worktree;
use crate::error::ApiError;
use crate::events::EventKind;
use crate::pty::live_tab::{
    LiveTab, ReplayFilter, RestoredTerminalBuffers, RestoredTerminalState,
    TerminalFullRebuildCapture, TerminalPersistenceCapture, TerminalPersistenceSeed, TerminalSize,
    filter_replay_bytes, normalize_shell_process_name, render_replay_screen_history,
};
use crate::state::AppState;
use crate::tab::{
    GitDiffScope, TabInfo, TerminalTabLabels, WorktreePaneNode, WorktreeTabLayout,
    WorktreeTabLayoutState,
};
use crate::tabs::{
    CreateTabRequest, ReorderTabsRequest, UpdateTabRequest, UpdateWorktreeTabLayoutRequest,
};
use crate::util::now_ms;
use crate::worktree_state::{
    LoadedWorktreeState, TerminalFlush, TerminalLabelsSnapshot, TerminalPersistedState,
    TerminalPersistedStateKind, TerminalRestorePayload, WorktreeRestoreState, WorktreeSnapshot,
};

pub type TabId = String;

#[derive(Debug, Clone)]
struct RestoredTerminalTab {
    project_id: String,
    worktree_id: String,
}

/// Owns tab state, terminal runtimes, restore coordination, and persistence
/// plumbing.
pub struct TabService {
    tabs: Arc<DashMap<TabId, TabInfo>>,
    tab_layouts: Arc<DashMap<String, WorktreeTabLayout>>,
    terminal_tabs: Arc<DashMap<TabId, Arc<LiveTab>>>,
    restored_terminal_tabs: Arc<DashMap<TabId, RestoredTerminalTab>>,
    terminal_restore_locks: Arc<DashMap<TabId, Arc<Mutex<()>>>>,
    restore_state_by_worktree: Arc<DashMap<String, WorktreeRestoreState>>,
    next_terminal_num_by_worktree: Arc<DashMap<String, u32>>,
    project_id_by_worktree: Arc<DashMap<String, String>>,
}

/// Narrow write handle for trusted callers that seed tabs directly.
#[derive(Clone)]
pub struct TabInsertHandle {
    service: Arc<TabService>,
}

/// Narrow read handle for callers that only need restore-state presence.
#[derive(Clone)]
pub struct RestoreStateHandle {
    service: Arc<TabService>,
}

impl TabInsertHandle {
    pub(crate) fn new(service: Arc<TabService>) -> Self {
        Self { service }
    }

    /// Insert a tab into the service-owned tab store.
    pub fn insert(&self, tab_id: TabId, tab: TabInfo) {
        self.service.tabs.insert(tab_id, tab);
    }
}

impl RestoreStateHandle {
    pub(crate) fn new(service: Arc<TabService>) -> Self {
        Self { service }
    }

    /// Return whether a worktree has service-owned restore state.
    pub fn contains_key(&self, worktree_id: &str) -> bool {
        self.service
            .restore_state_by_worktree
            .contains_key(worktree_id)
    }
}

impl TabService {
    pub(crate) fn new(project_id_by_worktree: Arc<DashMap<String, String>>) -> Self {
        Self {
            tabs: Arc::new(DashMap::new()),
            tab_layouts: Arc::new(DashMap::new()),
            terminal_tabs: Arc::new(DashMap::new()),
            restored_terminal_tabs: Arc::new(DashMap::new()),
            terminal_restore_locks: Arc::new(DashMap::new()),
            restore_state_by_worktree: Arc::new(DashMap::new()),
            next_terminal_num_by_worktree: Arc::new(DashMap::new()),
            project_id_by_worktree,
        }
    }

    pub(crate) fn list_tabs(&self, session_id: &str) -> Vec<TabInfo> {
        let mut tabs: Vec<_> = self
            .tabs
            .iter()
            .map(|entry| entry.value().clone())
            .filter(|tab| tab.session_id() == session_id)
            .collect();
        tabs.sort_by(|a, b| {
            a.position()
                .partial_cmp(&b.position())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        tabs
    }

    pub(crate) async fn create_tab(
        &self,
        state: &AppState,
        req: CreateTabRequest,
    ) -> Result<(StatusCode, TabInfo), ApiError> {
        create_tab_impl(state, req).await
    }

    pub(crate) async fn close_tab_by_id(
        &self,
        state: &AppState,
        id: &str,
    ) -> Result<StatusCode, ApiError> {
        close_tab_by_id_impl(state, id).await
    }

    pub(crate) async fn update_tab(
        &self,
        state: &AppState,
        id: &str,
        req: UpdateTabRequest,
    ) -> Result<TabInfo, ApiError> {
        update_tab_impl(state, id, req).await
    }

    pub(crate) async fn update_worktree_tab_layout(
        &self,
        state: &AppState,
        project_id: &str,
        worktree_id: &str,
        request: UpdateWorktreeTabLayoutRequest,
    ) -> Result<WorktreeTabLayoutState, ApiError> {
        update_worktree_tab_layout_impl(state, project_id, worktree_id, request).await
    }

    pub(crate) fn reorder_tabs(
        &self,
        state: &AppState,
        req: ReorderTabsRequest,
    ) -> Result<Vec<TabInfo>, ApiError> {
        reorder_tabs_impl(state, req)
    }

    pub(crate) async fn ensure_terminal_runtime(
        &self,
        state: &AppState,
        tab_id: &str,
    ) -> Result<Option<Arc<LiveTab>>, ApiError> {
        ensure_terminal_runtime_impl(state, tab_id).await
    }

    pub(crate) fn terminal_runtime(&self, tab_id: &str) -> Option<Arc<LiveTab>> {
        self.terminal_tabs
            .get(tab_id)
            .map(|entry| entry.value().clone())
    }

    pub(crate) fn snapshot_tabs(&self, session_id: &str) -> Vec<TabInfo> {
        self.list_tabs(session_id)
    }

    pub(crate) fn snapshot_layouts(&self) -> HashMap<String, WorktreeTabLayout> {
        self.tab_layouts
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect()
    }

    pub(crate) fn snapshot_restore_states(&self) -> HashMap<String, WorktreeRestoreState> {
        self.restore_state_by_worktree
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect()
    }

    pub(crate) fn restore_state_for_worktree(&self, worktree_id: &str) -> WorktreeRestoreState {
        self.restore_state_by_worktree
            .get(worktree_id)
            .map(|entry| entry.value().clone())
            .unwrap_or_default()
    }

    pub(crate) fn normalize_restore_state(
        &self,
        worktree_id: &str,
        restore_state: WorktreeRestoreState,
    ) -> WorktreeRestoreState {
        let tabs = self
            .tabs
            .iter()
            .filter(|entry| entry.value().worktree_id() == worktree_id)
            .map(|entry| entry.value().clone())
            .collect::<Vec<_>>();
        let layout = self.tab_layouts.get(worktree_id).map(|entry| entry.clone());
        crate::worktree_state::normalize_restore_state_for_snapshot(
            restore_state,
            &tabs,
            layout.as_ref(),
        )
    }

    pub(crate) fn set_restore_state(
        &self,
        worktree_id: String,
        restore_state: WorktreeRestoreState,
    ) {
        self.restore_state_by_worktree
            .insert(worktree_id, restore_state);
    }

    pub(crate) fn hydrate_worktree(&self, worktree: LoadedWorktreeState) {
        let worktree_id = worktree.worktree_id.clone();
        let project_id = worktree.project_id.clone();
        self.project_id_by_worktree
            .insert(worktree_id.clone(), project_id.clone());
        self.restore_state_by_worktree
            .insert(worktree_id.clone(), worktree.restore_state);
        self.next_terminal_num_by_worktree
            .insert(worktree_id.clone(), worktree.next_terminal_number.max(1));

        if let Some(layout) = worktree.layout {
            self.tab_layouts.insert(worktree_id.clone(), layout);
        }

        for tab in worktree.tabs {
            if tab.is_terminal() {
                let tab_id = tab.id().to_string();
                self.restored_terminal_tabs.insert(
                    tab_id.clone(),
                    RestoredTerminalTab {
                        project_id: project_id.clone(),
                        worktree_id: worktree_id.clone(),
                    },
                );
                self.terminal_restore_lock(&tab_id);
            }
            self.tabs.insert(tab.id().to_string(), tab);
        }
    }

    pub(crate) fn terminal_restore_lock(&self, tab_id: &str) -> Arc<Mutex<()>> {
        self.terminal_restore_locks
            .entry(tab_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub(crate) fn clear_worktree_runtime_state(&self, worktree_id: &str) {
        self.tab_layouts.remove(worktree_id);
        self.next_terminal_num_by_worktree.remove(worktree_id);
        self.restore_state_by_worktree.remove(worktree_id);
        self.project_id_by_worktree.remove(worktree_id);
        let removed_tab_ids: Vec<String> = self
            .restored_terminal_tabs
            .iter()
            .filter(|entry| entry.value().worktree_id == worktree_id)
            .map(|entry| entry.key().clone())
            .collect();
        self.restored_terminal_tabs
            .retain(|_, terminal| terminal.worktree_id != worktree_id);
        for tab_id in removed_tab_ids {
            self.terminal_restore_locks.remove(&tab_id);
        }
    }

    pub(crate) async fn close_tabs_for_worktree(
        &self,
        state: &AppState,
        worktree_id: &str,
    ) -> Result<(), ApiError> {
        self.clear_worktree_runtime_state(worktree_id);
        let tab_ids: Vec<String> = self
            .tabs
            .iter()
            .filter(|entry| entry.value().worktree_id() == worktree_id)
            .map(|entry| entry.key().clone())
            .collect();

        for tab_id in tab_ids {
            let Some(tab) = self.tabs.get(&tab_id).map(|entry| entry.value().clone()) else {
                continue;
            };
            if tab.is_agent_chat()
                && let Err(error) = state.chats.clear_open_tab_id_for_tab(&tab_id).await
            {
                tracing::warn!(
                    tab_id,
                    "failed to clear closed chat tab id: {}",
                    error.message
                );
                return Err(ApiError::internal("Internal server error."));
            }
            if let Some((_, tab)) = self.tabs.remove(&tab_id) {
                if tab.is_terminal()
                    && let Some((_, runtime)) = self.terminal_tabs.remove(&tab_id)
                {
                    runtime.notify_close();
                }
                state.events.emit(EventKind::TabClosed {
                    session_id: tab.session_id().to_string(),
                    tab_id,
                });
            }
        }
        Ok(())
    }
}

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
const TERMINAL_PERSIST_INTERVAL: Duration = Duration::from_secs(1);
const TERMINAL_PERSIST_THRESHOLD_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Default)]
struct TerminalPersistenceWorkerState {
    source_bytes_end: u64,
    replay_total_bytes: u64,
    replay_epoch: u64,
    replay_filter: ReplayFilter,
}

#[derive(Debug)]
enum TerminalPersistenceCompletion {
    Persisted {
        metadata: TerminalPersistedState,
        worker_state: TerminalPersistenceWorkerState,
    },
}

fn tab_basename(path: &str) -> String {
    path.rsplit('/')
        .find(|segment| !segment.is_empty())
        .map_or_else(|| path.to_string(), |segment| segment.to_string())
}

fn worktree_id_for_create(req: &CreateTabRequest) -> &str {
    match req {
        CreateTabRequest::Terminal { worktree_id, .. }
        | CreateTabRequest::File { worktree_id, .. }
        | CreateTabRequest::GitDiff { worktree_id, .. }
        | CreateTabRequest::Browser { worktree_id, .. }
        | CreateTabRequest::AgentChat { worktree_id, .. } => worktree_id,
    }
}

fn pane_id_for_create(req: &CreateTabRequest) -> Option<&str> {
    match req {
        CreateTabRequest::Terminal { pane_id, .. }
        | CreateTabRequest::File { pane_id, .. }
        | CreateTabRequest::GitDiff { pane_id, .. }
        | CreateTabRequest::Browser { pane_id, .. }
        | CreateTabRequest::AgentChat { pane_id, .. } => pane_id.as_deref(),
    }
}

fn normalize_browser_url(raw: &str) -> Result<String, ApiError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ApiError::with_status(
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
            return Err(ApiError::with_status(
                StatusCode::BAD_REQUEST,
                INVALID_BROWSER_URL_MESSAGE,
            ));
        }
        format!("http://{trimmed}")
    };

    let parsed = Url::parse(&candidate).map_err(|error| {
        tracing::warn!(error = %error, "failed to parse browser tab URL");
        ApiError::with_status(StatusCode::BAD_REQUEST, INVALID_BROWSER_URL_MESSAGE)
    })?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(ApiError::with_status(
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

fn validate_create_tab_request(req: &mut CreateTabRequest) -> Result<(), ApiError> {
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
                    ApiError::with_status(StatusCode::BAD_REQUEST, MISSING_COMMIT_ID_MESSAGE)
                })?
                .to_string();
            *commit_id = Some(normalized);
            Ok(())
        }
        CreateTabRequest::Browser { url, .. } => {
            *url = normalize_browser_url(url)?;
            Ok(())
        }
        CreateTabRequest::Terminal { .. }
        | CreateTabRequest::File { .. }
        | CreateTabRequest::AgentChat { .. } => Ok(()),
    }
}

fn map_status_to_tab_error(status: StatusCode) -> ApiError {
    let message = match status {
        StatusCode::BAD_REQUEST => "Invalid tab request.",
        StatusCode::NOT_FOUND => "Worktree not found.",
        _ => "Internal server error.",
    };
    ApiError::with_status(status, message)
}

fn map_worktree_api_error(error: ApiError) -> ApiError {
    tracing::debug!(error = %error, "failed to resolve worktree for tab request");
    map_status_to_tab_error(error.status())
}

fn normalize_custom_label(label: &str) -> Option<String> {
    let trimmed = label.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn next_terminal_number(state: &AppState, worktree_id: &str) -> u32 {
    let mut next = state
        .tabs_service
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
) -> Result<HashMap<String, WorktreePaneNode>, ApiError> {
    if layout.root_id.trim().is_empty() || layout.nodes.is_empty() {
        return Err(ApiError::with_status(
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
                return Err(ApiError::with_status(
                    StatusCode::BAD_REQUEST,
                    INVALID_LAYOUT_MESSAGE,
                ));
            }

            Ok(nodes)
        })
}

fn collect_layout_leaf_panes(layout: &WorktreeTabLayout) -> Result<Vec<String>, ApiError> {
    let nodes = layout_nodes_by_id(layout)?;
    let mut pane_ids = Vec::new();
    let mut seen_panes = HashSet::new();
    let mut visited = HashSet::new();
    let mut stack = vec![layout.root_id.clone()];

    while let Some(node_id) = stack.pop() {
        if !visited.insert(node_id.clone()) {
            return Err(ApiError::with_status(
                StatusCode::BAD_REQUEST,
                INVALID_LAYOUT_MESSAGE,
            ));
        }

        match nodes.get(&node_id) {
            Some(WorktreePaneNode::Leaf { pane_id, .. }) => {
                if pane_id.trim().is_empty() || !seen_panes.insert(pane_id.clone()) {
                    return Err(ApiError::with_status(
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
                    return Err(ApiError::with_status(
                        StatusCode::BAD_REQUEST,
                        INVALID_LAYOUT_MESSAGE,
                    ));
                }
                stack.push(second_id.clone());
                stack.push(first_id.clone());
            }
            None => {
                return Err(ApiError::with_status(
                    StatusCode::BAD_REQUEST,
                    INVALID_LAYOUT_MESSAGE,
                ));
            }
        }
    }

    if pane_ids.is_empty() || visited.len() != nodes.len() {
        return Err(ApiError::with_status(
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
        .tabs_service
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
) -> Result<WorktreeTabLayout, ApiError> {
    fn rebuild_node(
        node_id: &str,
        nodes: &HashMap<String, WorktreePaneNode>,
        pane_tab_ids: &HashMap<String, Vec<String>>,
        fallback_pane_id: &str,
        is_root: bool,
    ) -> Result<Option<(String, Vec<WorktreePaneNode>)>, ApiError> {
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
            None => Err(ApiError::with_status(
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
        return Err(ApiError::with_status(
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
        .tabs_service
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
            .tabs_service
            .tab_layouts
            .insert(worktree_id.to_string(), next_layout.clone());
        emit_layout_updated(state, worktree_id, &next_layout, tabs);
    }
}

fn worktree_snapshot(state: &AppState, project_id: &str, worktree_id: &str) -> WorktreeSnapshot {
    WorktreeSnapshot {
        project_id: project_id.to_string(),
        worktree_id: worktree_id.to_string(),
        layout: state
            .tabs_service
            .tab_layouts
            .get(worktree_id)
            .map(|entry| entry.value().clone()),
        tabs: worktree_tabs(state, worktree_id),
        restore_state: state.restore_state_for_worktree(worktree_id),
        next_terminal_number: state
            .tabs_service
            .next_terminal_num_by_worktree
            .get(worktree_id)
            .map(|entry| *entry.value())
            .unwrap_or(1),
    }
}

fn persist_worktree_snapshot(state: &AppState, worktree_id: &str) {
    let Some(project_id) = state.project_id_for_worktree(worktree_id) else {
        return;
    };
    state
        .persistence
        .replace_worktree_state(worktree_snapshot(state, &project_id, worktree_id));
}

fn persist_terminal_labels(state: &AppState, tab: &TabInfo) {
    let TabInfo::Terminal { worktree_id, .. } = tab else {
        return;
    };
    let Some(project_id) = state.project_id_for_worktree(worktree_id) else {
        return;
    };

    state
        .persistence
        .update_terminal_labels(TerminalLabelsSnapshot {
            project_id,
            worktree_id: worktree_id.to_string(),
            tab_id: tab.id().to_string(),
            custom_label: tab.custom_label().map(str::to_string),
            process_label: tab.smart_label().map(str::to_string),
        });
}

fn update_worktree_layout_state(
    state: &AppState,
    worktree_id: &str,
    request: UpdateWorktreeTabLayoutRequest,
) -> Result<WorktreeTabLayoutState, ApiError> {
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
                return Err(ApiError::with_status(
                    StatusCode::BAD_REQUEST,
                    INVALID_LAYOUT_MESSAGE,
                ));
            }
            map.insert(pane.pane_id, pane.tab_ids);
            Ok(map)
        },
    )?;

    if pane_map.len() != pane_ids.len() {
        return Err(ApiError::with_status(
            StatusCode::BAD_REQUEST,
            INVALID_LAYOUT_MESSAGE,
        ));
    }

    let mut seen_tab_ids = HashSet::new();
    for tab_ids in pane_map.values() {
        for tab_id in tab_ids {
            if !seen_tab_ids.insert(tab_id.clone()) {
                return Err(ApiError::with_status(
                    StatusCode::BAD_REQUEST,
                    INVALID_LAYOUT_MESSAGE,
                ));
            }
        }
    }
    if seen_tab_ids != current_tab_ids {
        return Err(ApiError::with_status(
            StatusCode::BAD_REQUEST,
            INVALID_LAYOUT_MESSAGE,
        ));
    }

    for pane_id in &pane_ids {
        if let Some(tab_ids) = pane_map.get(pane_id) {
            for (index, tab_id) in tab_ids.iter().enumerate() {
                if let Some(mut tab) = state.tabs_service.tabs.get_mut(tab_id) {
                    tab.set_pane_id(pane_id.clone());
                    tab.set_position((index + 1) as f64);
                }
            }
        }
    }

    state
        .tabs_service
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
                smart_label: None,
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
        CreateTabRequest::AgentChat {
            worktree_id,
            conversation_id,
            ..
        } => TabInfo::AgentChat {
            id,
            session_id: "default".to_string(),
            worktree_id,
            pane_id,
            label: DEFAULT_CHAT_TITLE.to_string(),
            position,
            created_at,
            preview: false,
            conversation_id: conversation_id.unwrap_or_default(),
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
) -> Result<ValidatedBrowserUpdate, ApiError> {
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
        return Err(ApiError::with_status(
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
    restore_payload: Option<TerminalRestorePayload>,
    server_scrollback_bytes: usize,
) -> Result<
    (
        Arc<LiveTab>,
        TerminalCloseReceiver,
        TerminalPersistenceWorkerState,
    ),
    ApiError,
> {
    let has_restore_payload = restore_payload.is_some();
    let initial_size = initial_terminal_size(restore_payload.as_ref());
    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(initial_size.to_pty_size())
        .map_err(|error| {
            tracing::error!("failed to open pty: {}", error);
            ApiError::internal("Internal server error.")
        })?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let shell_process_name = normalize_shell_process_name(&shell);
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(PathBuf::from(worktree_path));
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|error| {
        tracing::error!("failed to spawn shell: {}", error);
        ApiError::internal("Internal server error.")
    })?;
    drop(pair.slave);

    let worktree_root = PathBuf::from(worktree_path);
    let live_tab = match restore_payload {
        Some(payload) => LiveTab::spawn_restored(
            info,
            shell_process_name,
            worktree_root,
            pair.master,
            child,
            server_scrollback_bytes,
            RestoredTerminalState {
                size: payload.size,
                buffers: RestoredTerminalBuffers {
                    history: payload.history,
                },
            },
        ),
        None => LiveTab::spawn(
            info,
            shell_process_name,
            worktree_root,
            pair.master,
            child,
            server_scrollback_bytes,
            initial_size,
        ),
    }
    .map_err(|error| {
        tracing::error!("failed to start live tab: {}", error);
        ApiError::internal("Internal server error.")
    })?;

    let close_rx = live_tab.close_tx.subscribe();
    let tab = Arc::new(live_tab);
    let worker_state = initial_terminal_persistence_worker_state(
        has_restore_payload.then_some(()),
        tab.capture_persistence_seed(),
    );
    Ok((tab, close_rx, worker_state))
}

fn initial_terminal_size(restore_payload: Option<&TerminalRestorePayload>) -> TerminalSize {
    restore_payload
        .map(|payload| payload.size)
        .unwrap_or_else(TerminalSize::default_pty)
}

fn initial_terminal_persistence_worker_state(
    restore_payload: Option<()>,
    seed: TerminalPersistenceSeed,
) -> TerminalPersistenceWorkerState {
    if restore_payload.is_none() {
        return TerminalPersistenceWorkerState::default();
    }

    TerminalPersistenceWorkerState {
        source_bytes_end: seed.total_bytes,
        replay_total_bytes: seed.total_bytes,
        replay_epoch: seed.replay_epoch,
        replay_filter: seed.replay_filter,
    }
}

fn start_terminal_persistence_job(
    runtime: Arc<LiveTab>,
    worker_state: TerminalPersistenceWorkerState,
) -> Option<JoinHandle<TerminalPersistenceCompletion>> {
    let capture = runtime
        .capture_persistence_snapshot(worker_state.source_bytes_end, worker_state.replay_epoch);
    match &capture {
        TerminalPersistenceCapture::Incremental(incremental)
            if incremental.source_bytes_end == worker_state.source_bytes_end
                && incremental.replay_epoch == worker_state.replay_epoch =>
        {
            return None;
        }
        _ => {}
    }

    Some(tokio::spawn(async move {
        match capture {
            TerminalPersistenceCapture::Incremental(incremental) => {
                let mut replay_filter = worker_state.replay_filter.clone();
                let replay_append =
                    filter_replay_bytes(&mut replay_filter, &incremental.source_bytes);
                let replay_total_bytes = worker_state
                    .replay_total_bytes
                    .saturating_add(replay_append.len() as u64);
                TerminalPersistenceCompletion::Persisted {
                    metadata: TerminalPersistedState {
                        kind: TerminalPersistedStateKind::Append {
                            size: incremental.size,
                            replay_budget_bytes: incremental.replay_budget_bytes,
                            replay_epoch: incremental.replay_epoch,
                            source_bytes_end: incremental.source_bytes_end,
                            replay_append,
                            replay_total_bytes,
                        },
                    },
                    worker_state: TerminalPersistenceWorkerState {
                        source_bytes_end: incremental.source_bytes_end,
                        replay_total_bytes,
                        replay_epoch: incremental.replay_epoch,
                        replay_filter,
                    },
                }
            }
            TerminalPersistenceCapture::FullRebuild(rebuild) => {
                let rebuild = *rebuild;
                let TerminalFullRebuildCapture {
                    size,
                    replay_budget_bytes,
                    source_bytes_end,
                    replay_epoch,
                    replay_screen,
                    replay_filter,
                } = rebuild;
                let replay_history = tokio::task::spawn_blocking(move || {
                    render_replay_screen_history(replay_screen, replay_budget_bytes)
                })
                .await
                .unwrap_or_default();
                let replay_total_bytes = replay_history.len() as u64;
                TerminalPersistenceCompletion::Persisted {
                    metadata: TerminalPersistedState {
                        kind: TerminalPersistedStateKind::Rebuild {
                            size,
                            replay_budget_bytes,
                            replay_epoch,
                            source_bytes_end,
                            replay_history,
                            replay_total_bytes,
                        },
                    },
                    worker_state: TerminalPersistenceWorkerState {
                        source_bytes_end,
                        replay_total_bytes,
                        replay_epoch,
                        replay_filter,
                    },
                }
            }
        }
    }))
}

fn queue_terminal_persistence_flush(
    runtime: &Arc<LiveTab>,
    dirty: &mut bool,
    pending_bytes: &mut usize,
    in_flight: &mut Option<JoinHandle<TerminalPersistenceCompletion>>,
    worker_state: &TerminalPersistenceWorkerState,
) {
    if !*dirty || in_flight.is_some() {
        return;
    }
    if let Some(job) = start_terminal_persistence_job(runtime.clone(), worker_state.clone()) {
        *dirty = false;
        *pending_bytes = 0;
        *in_flight = Some(job);
    } else {
        *dirty = false;
        *pending_bytes = 0;
    }
}

fn spawn_terminal_persistence_task(
    state: &AppState,
    project_id: String,
    worktree_id: String,
    tab_id: String,
    runtime: Arc<LiveTab>,
    initial_worker_state: TerminalPersistenceWorkerState,
) {
    let persistence = state.persistence.clone();
    let mut output_rx = runtime.output_tx.subscribe();
    let mut close_rx = runtime.close_tx.subscribe();
    tokio::spawn(async move {
        let mut dirty = initial_worker_state.source_bytes_end == 0
            && initial_worker_state.replay_total_bytes == 0;
        let mut pending_bytes = 0usize;
        let mut closing = false;
        let mut worker_state = initial_worker_state;
        let mut in_flight: Option<JoinHandle<TerminalPersistenceCompletion>> = None;
        let mut interval = time::interval(TERMINAL_PERSIST_INTERVAL);
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                result = async {
                    match &mut in_flight {
                        Some(handle) => Some(handle.await),
                        None => None,
                    }
                }, if in_flight.is_some() => {
                    in_flight = None;
                    match result {
                        Some(Ok(TerminalPersistenceCompletion::Persisted { metadata, worker_state: next_worker_state })) => {
                            worker_state = next_worker_state;
                            persistence.enqueue_terminal_flush(TerminalFlush {
                                project_id: project_id.clone(),
                                worktree_id: worktree_id.clone(),
                                tab_id: tab_id.clone(),
                                metadata,
                                flushed_at_ms: now_ms(),
                            });
                        }
                        Some(Err(error)) => {
                            tracing::warn!(tab_id, "terminal persistence worker failed: {error}");
                            dirty = true;
                        }
                        None => {}
                    }
                }
                result = output_rx.recv() => {
                    match result {
                        Ok(data) => {
                            dirty = true;
                            pending_bytes = pending_bytes.saturating_add(data.len());
                            if pending_bytes >= TERMINAL_PERSIST_THRESHOLD_BYTES {
                                queue_terminal_persistence_flush(
                                    &runtime,
                                    &mut dirty,
                                    &mut pending_bytes,
                                    &mut in_flight,
                                    &worker_state,
                                );
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            dirty = true;
                            queue_terminal_persistence_flush(
                                &runtime,
                                &mut dirty,
                                &mut pending_bytes,
                                &mut in_flight,
                                &worker_state,
                            );
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            closing = true;
                        }
                    }
                }
                _ = interval.tick() => {
                    queue_terminal_persistence_flush(
                        &runtime,
                        &mut dirty,
                        &mut pending_bytes,
                        &mut in_flight,
                        &worker_state,
                    );
                }
                _ = close_rx.recv() => {
                    dirty = true;
                    closing = true;
                }
            }

            if closing {
                queue_terminal_persistence_flush(
                    &runtime,
                    &mut dirty,
                    &mut pending_bytes,
                    &mut in_flight,
                    &worker_state,
                );
                if !dirty && in_flight.is_none() {
                    break;
                }
            }
        }
    });
}

fn register_terminal_runtime(
    state: &AppState,
    project_id: String,
    worktree_id: String,
    tab_id: String,
    runtime: Arc<LiveTab>,
    initial_worker_state: TerminalPersistenceWorkerState,
    close_rx: TerminalCloseReceiver,
) {
    state
        .tabs_service
        .terminal_tabs
        .insert(tab_id.clone(), runtime.clone());
    state.tabs_service.restored_terminal_tabs.remove(&tab_id);
    spawn_terminal_notification_task(
        state,
        tab_id.clone(),
        runtime.notification_tx.subscribe(),
        runtime.close_tx.subscribe(),
    );
    spawn_terminal_title_task(
        state,
        tab_id.clone(),
        runtime.title_tx.subscribe(),
        runtime.close_tx.subscribe(),
    );
    spawn_terminal_smart_label_task(
        state,
        tab_id.clone(),
        runtime.clone(),
        runtime.close_tx.subscribe(),
    );
    spawn_terminal_persistence_task(
        state,
        project_id,
        worktree_id,
        tab_id.clone(),
        runtime,
        initial_worker_state,
    );
    spawn_terminal_cleanup_task(state.clone(), tab_id, close_rx);
}

fn spawn_terminal_notification_task(
    state: &AppState,
    id: String,
    mut notification_rx: TerminalNotificationReceiver,
    mut close_rx: TerminalCloseReceiver,
) {
    let tabs = state.tabs_service.tabs.clone();
    let terminal_tabs = state.tabs_service.terminal_tabs.clone();
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
    let tabs = state.tabs_service.tabs.clone();
    let terminal_tabs = state.tabs_service.terminal_tabs.clone();
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

fn spawn_terminal_smart_label_task(
    state: &AppState,
    id: String,
    runtime: Arc<LiveTab>,
    mut close_rx: TerminalCloseReceiver,
) {
    let tabs = state.tabs_service.tabs.clone();
    let terminal_tabs = state.tabs_service.terminal_tabs.clone();
    let events = state.events.clone();
    let state_for_persist = state.clone();
    tokio::spawn(async move {
        let mut interval = time::interval(std::time::Duration::from_millis(750));
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    let runtime = runtime.clone();
                    let Ok(next_smart_label) = tokio::task::spawn_blocking(move || {
                        runtime.resolve_smart_label()
                    }).await else {
                        continue;
                    };
                    let Some(updated) = ({
                        let Some(mut tab) = tabs.get_mut(&id) else {
                            break;
                        };
                        if tab.smart_label() == next_smart_label.as_deref() {
                            None
                        } else {
                            tab.set_smart_label(next_smart_label.clone());
                            Some(tab.clone())
                        }
                    }) else {
                        continue;
                    };

                    if let Some(live_tab) = terminal_tabs.get(&id) {
                        live_tab.update_info(|info| {
                            info.set_smart_label(next_smart_label.clone());
                            info.clone()
                        });
                    }

                    persist_terminal_labels(&state_for_persist, &updated);

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

fn spawn_terminal_cleanup_task(state: AppState, id: String, mut close_rx: TerminalCloseReceiver) {
    let tabs = state.tabs_service.tabs.clone();
    let terminal_tabs = state.tabs_service.terminal_tabs.clone();
    let tab_layouts = state.tabs_service.tab_layouts.clone();
    let restored_terminal_tabs = state.tabs_service.restored_terminal_tabs.clone();
    let terminal_restore_locks = state.tabs_service.terminal_restore_locks.clone();
    let events = state.events.clone();
    tokio::spawn(async move {
        let _ = close_rx.recv().await;
        terminal_tabs.remove(&id);
        restored_terminal_tabs.remove(&id);
        terminal_restore_locks.remove(&id);
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
                        worktree_id: worktree_id.clone(),
                        state: Box::new(WorktreeTabLayoutState {
                            layout: next_layout,
                            tabs: remaining_tabs,
                        }),
                    });
                }
            }
            persist_worktree_snapshot(&state, &worktree_id);
        }
    });
}

async fn ensure_terminal_runtime_impl(
    state: &AppState,
    tab_id: &str,
) -> Result<Option<Arc<LiveTab>>, ApiError> {
    if let Some(runtime) = state.tabs_service.terminal_tabs.get(tab_id) {
        return Ok(Some(runtime.value().clone()));
    }

    let restore_lock = state.tabs_service.terminal_restore_lock(tab_id);
    let _guard = restore_lock.lock().await;

    if let Some(runtime) = state.tabs_service.terminal_tabs.get(tab_id) {
        return Ok(Some(runtime.value().clone()));
    }

    let Some(restored) = state
        .tabs_service
        .restored_terminal_tabs
        .get(tab_id)
        .map(|entry| entry.value().clone())
    else {
        return Ok(None);
    };

    let info = state
        .tabs_service
        .tabs
        .get(tab_id)
        .map(|entry| entry.value().clone())
        .ok_or_else(|| ApiError::not_found("Tab or worktree not found."))?;
    let resolved = resolve_worktree(state, info.worktree_id())
        .await?
        .ok_or_else(|| ApiError::not_found("Tab or worktree not found."))?;
    let payload = state
        .persistence
        .clone()
        .load_terminal_restore_payload(
            tab_id.to_string(),
            state
                .settings
                .get()
                .await
                .settings
                .terminal
                .server_scrollback_bytes as usize,
        )
        .await
        .map_err(|error| {
            tracing::error!(tab_id, "failed to load terminal restore payload: {error}");
            ApiError::internal("Internal server error.")
        })?;
    let (runtime, close_rx, initial_worker_state) = spawn_terminal_runtime(
        &resolved.worktree.path,
        info.clone(),
        Some(payload),
        state
            .settings
            .get()
            .await
            .settings
            .terminal
            .server_scrollback_bytes as usize,
    )?;

    state.remember_worktree_project(info.worktree_id(), &restored.project_id);
    register_terminal_runtime(
        state,
        restored.project_id,
        restored.worktree_id,
        tab_id.to_string(),
        runtime.clone(),
        initial_worker_state,
        close_rx,
    );

    Ok(Some(runtime))
}

async fn create_tab_impl(
    state: &AppState,
    mut req: CreateTabRequest,
) -> Result<(StatusCode, TabInfo), ApiError> {
    validate_create_tab_request(&mut req)?;

    if matches!(req, CreateTabRequest::AgentChat { .. })
        && !state
            .settings
            .get()
            .await
            .settings
            .experimental
            .chat_enabled
    {
        return Err(ApiError::with_status(
            StatusCode::FORBIDDEN,
            "Chat is disabled in Experimental settings.",
        ));
    }

    let worktree_id = worktree_id_for_create(&req).to_string();
    let resolved = resolve_worktree(state, &worktree_id)
        .await
        .map_err(map_worktree_api_error)?
        .ok_or_else(|| map_status_to_tab_error(StatusCode::NOT_FOUND))?;
    state.remember_worktree_project(&worktree_id, &resolved.project_id);
    let server_scrollback_bytes = state
        .settings
        .get()
        .await
        .settings
        .terminal
        .server_scrollback_bytes as usize;

    let terminal_number = if matches!(req, CreateTabRequest::Terminal { .. }) {
        next_terminal_number(state, &worktree_id)
    } else {
        0
    };
    let mut response_status = StatusCode::CREATED;
    if let CreateTabRequest::AgentChat {
        conversation_id, ..
    } = &mut req
    {
        let resolved_conversation_id = if let Some(existing_id) = conversation_id.as_deref() {
            let summary = state
                .chats
                .get_conversation_summary(existing_id)
                .await
                .map_err(ApiError::from)?
                .ok_or_else(|| {
                    ApiError::with_status(StatusCode::NOT_FOUND, "Chat conversation not found.")
                })?;
            let same_branch =
                summary.branch_name.as_deref() == Some(resolved.worktree.branch.as_str());
            let legacy_same_worktree = summary.branch_name.is_none()
                && summary.worktree_id == worktree_id
                && summary.project_id == resolved.project_id;
            if summary.project_id != resolved.project_id || (!same_branch && !legacy_same_worktree)
            {
                return Err(ApiError::with_status(
                    StatusCode::BAD_REQUEST,
                    "Chat conversation does not belong to this branch.",
                ));
            }
            if legacy_same_worktree {
                state
                    .chats
                    .backfill_conversation_branch(&summary.id, &resolved.worktree.branch)
                    .await
                    .map_err(ApiError::from)?;
            }
            summary.id
        } else {
            state
                .chats
                .create_conversation(ChatCreateOptions {
                    session_id: "default".to_string(),
                    project_id: resolved.project_id.clone(),
                    worktree_id: worktree_id.clone(),
                    branch_name: resolved.worktree.branch.clone(),
                })
                .await
                .map_err(ApiError::from)?
                .id
        };

        if let Some(existing_tab_id) = state
            .chats
            .open_tab_id_for_conversation(&resolved_conversation_id)
            .await
            .map_err(ApiError::from)?
        {
            // Clone the tab out of the DashMap so the shard guard is
            // dropped before awaiting touch_runtime below.
            let existing_tab = state
                .tabs_service
                .tabs
                .get(&existing_tab_id)
                .map(|entry| entry.value().clone());
            if let Some(existing_tab) = existing_tab
                && existing_tab.session_id() == "default"
                && existing_tab.worktree_id() == worktree_id
            {
                response_status = StatusCode::OK;
                state.chats.touch_runtime(&resolved_conversation_id).await;
                return Ok((response_status, existing_tab));
            }
        }

        *conversation_id = Some(resolved_conversation_id);
    }
    let requested_pane_id = pane_id_for_create(&req).map(str::to_string);
    let existing_layout = state
        .tabs_service
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
        state.tabs_service.tab_layouts.insert(
            worktree_id.clone(),
            default_worktree_layout(pane_id.clone()),
        );
        pane_id
    };

    let max_pos = state
        .tabs_service
        .tabs
        .iter()
        .filter(|entry| {
            let tab = entry.value();
            tab.worktree_id() == worktree_id && tab.pane_id() == pane_id
        })
        .map(|entry| entry.value().position())
        .fold(0.0_f64, f64::max);
    let mut info = build_tab_info(
        req,
        uuid::Uuid::new_v4().to_string(),
        pane_id,
        max_pos + 1.0,
        now_ms(),
        terminal_number,
    );
    if let Some(conversation_id) = info.conversation_id()
        && let Some(summary) = state
            .chats
            .get_conversation_summary(conversation_id)
            .await
            .map_err(ApiError::from)?
    {
        info.set_label(summary.title);
    }

    if let Some(conversation_id) = info.conversation_id() {
        let claimed_tab_id = state
            .chats
            .claim_open_tab_id_for_conversation(conversation_id, info.id())
            .await
            .map_err(ApiError::from)?;
        if claimed_tab_id != info.id() {
            for _ in 0..5 {
                // Clone the tab out of the DashMap so the shard guard is
                // dropped before awaiting touch_runtime below.
                let existing_tab = state
                    .tabs_service
                    .tabs
                    .get(&claimed_tab_id)
                    .map(|entry| entry.value().clone());
                if let Some(existing_tab) = existing_tab
                    && existing_tab.session_id() == info.session_id()
                    && existing_tab.worktree_id() == info.worktree_id()
                {
                    state.chats.touch_runtime(conversation_id).await;
                    return Ok((StatusCode::OK, existing_tab));
                }
                time::sleep(Duration::from_millis(20)).await;
            }
            return Err(ApiError::with_status(
                StatusCode::CONFLICT,
                "Chat tab is already opening.",
            ));
        }
    }

    let terminal_runtime = if info.is_terminal() {
        Some(spawn_terminal_runtime(
            &resolved.worktree.path,
            info.clone(),
            None,
            server_scrollback_bytes,
        )?)
    } else {
        None
    };
    state
        .tabs_service
        .tabs
        .insert(info.id().to_string(), info.clone());
    if let Some(conversation_id) = info.conversation_id() {
        state.chats.touch_runtime(conversation_id).await;
    }
    persist_worktree_snapshot(state, &worktree_id);
    state.events.emit(EventKind::TabCreated {
        session_id: info.session_id().to_string(),
        tab: info.clone(),
    });
    if existing_layout.is_none()
        && let Some(layout) = state
            .tabs_service
            .tab_layouts
            .get(&worktree_id)
            .map(|entry| entry.clone())
    {
        emit_layout_updated(
            state,
            &worktree_id,
            &layout,
            worktree_tabs(state, &worktree_id),
        );
    }
    if let Some((runtime, close_rx, initial_worker_state)) = terminal_runtime {
        register_terminal_runtime(
            state,
            resolved.project_id,
            worktree_id,
            info.id().to_string(),
            runtime,
            initial_worker_state,
            close_rx,
        );
    }

    Ok((response_status, info))
}

async fn close_tab_by_id_impl(state: &AppState, id: &str) -> Result<StatusCode, ApiError> {
    let Some(removed_tab) = state
        .tabs_service
        .tabs
        .get(id)
        .map(|entry| entry.value().clone())
    else {
        return Err(ApiError::not_found("Tab not found."));
    };
    if removed_tab.is_agent_chat()
        && let Err(error) = state.chats.clear_open_tab_id_for_tab(id).await
    {
        tracing::warn!(error = %error, "failed to clear closed chat tab id");
        return Err(ApiError::internal("Internal server error."));
    }
    let Some((_, removed_tab)) = state.tabs_service.tabs.remove(id) else {
        return Err(ApiError::not_found("Tab not found."));
    };

    if let Some((_, runtime)) = state.tabs_service.terminal_tabs.remove(id) {
        runtime.notify_close();
    }
    state.tabs_service.restored_terminal_tabs.remove(id);
    state.tabs_service.terminal_restore_locks.remove(id);
    state
        .persistence
        .delete_tab_state(id.to_string(), removed_tab.worktree_id().to_string());

    state.events.emit(EventKind::TabClosed {
        session_id: removed_tab.session_id().to_string(),
        tab_id: id.to_string(),
    });
    reconcile_worktree_layout(state, removed_tab.worktree_id());
    persist_worktree_snapshot(state, removed_tab.worktree_id());
    Ok(StatusCode::NO_CONTENT)
}

async fn update_tab_impl(
    state: &AppState,
    id: &str,
    req: UpdateTabRequest,
) -> Result<TabInfo, ApiError> {
    let updated = {
        let mut tab = state
            .tabs_service
            .tabs
            .get_mut(id)
            .ok_or_else(|| ApiError::with_status(StatusCode::NOT_FOUND, "Tab not found."))?;

        if has_browser_update_fields(&req) && !tab.is_browser() {
            return Err(ApiError::with_status(
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
        && let Some(lt) = state.tabs_service.terminal_tabs.get(id)
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
        && let Some(lt) = state.tabs_service.terminal_tabs.get(id)
    {
        lt.update_info(|info| {
            info.set_custom_label(updated.custom_label().map(str::to_string));
            info.clone()
        });
    }

    let requires_full_snapshot =
        req.position.is_some() || req.preview.is_some() || has_browser_update_fields(&req);
    if requires_full_snapshot {
        persist_worktree_snapshot(state, updated.worktree_id());
    } else if req.custom_label.is_some() && updated.is_terminal() {
        persist_terminal_labels(state, &updated);
    }
    state.events.emit(EventKind::TabUpdated {
        session_id: updated.session_id().to_string(),
        tab: updated.clone(),
    });
    Ok(updated)
}

async fn update_worktree_tab_layout_impl(
    state: &AppState,
    project_id: &str,
    worktree_id: &str,
    request: UpdateWorktreeTabLayoutRequest,
) -> Result<WorktreeTabLayoutState, ApiError> {
    let resolved = resolve_worktree(state, worktree_id)
        .await
        .map_err(map_worktree_api_error)?
        .ok_or_else(|| map_status_to_tab_error(StatusCode::NOT_FOUND))?;
    if resolved.project_id != project_id {
        return Err(map_status_to_tab_error(StatusCode::NOT_FOUND));
    }
    state.remember_worktree_project(worktree_id, project_id);

    let next_state = update_worktree_layout_state(state, worktree_id, request)?;
    persist_worktree_snapshot(state, worktree_id);
    emit_layout_updated(
        state,
        worktree_id,
        &next_state.layout,
        next_state.tabs.clone(),
    );
    Ok(next_state)
}

fn reorder_tabs_impl(state: &AppState, req: ReorderTabsRequest) -> Result<Vec<TabInfo>, ApiError> {
    let tabs_in_worktree: Vec<TabInfo> = state
        .tabs_service
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
        return Err(ApiError::with_status(
            StatusCode::BAD_REQUEST,
            INVALID_LAYOUT_MESSAGE,
        ));
    }

    let received: HashSet<String> = req.tab_ids.iter().cloned().collect();
    if pane_tab_ids != received {
        return Err(ApiError::with_status(
            StatusCode::BAD_REQUEST,
            INVALID_LAYOUT_MESSAGE,
        ));
    }

    let Some(first_tab) = tabs_in_worktree.first() else {
        return Ok(vec![]);
    };
    let session_id = first_tab.session_id().to_string();
    if tabs_in_worktree
        .iter()
        .any(|tab| tab.session_id() != session_id)
    {
        return Err(ApiError::with_status(
            StatusCode::BAD_REQUEST,
            INVALID_LAYOUT_MESSAGE,
        ));
    }

    for (index, id) in req.tab_ids.iter().enumerate() {
        if let Some(mut tab) = state.tabs_service.tabs.get_mut(id) {
            tab.set_position((index + 1) as f64);
        }
    }

    let reordered = worktree_tabs(state, &req.worktree_id);

    state.events.emit(EventKind::TabsReordered {
        session_id,
        worktree_id: req.worktree_id.clone(),
        tabs: reordered.clone(),
    });
    persist_worktree_snapshot(state, &req.worktree_id);

    Ok(reordered)
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;
    use crate::tab::TerminalTabLabels;

    #[tokio::test]
    async fn clear_worktree_runtime_state_removes_restore_locks_for_worktree() {
        let tmp = TempDir::new().unwrap();
        let state = AppState::new(tmp.path().to_path_buf()).await;
        state.tabs_service.restored_terminal_tabs.insert(
            "tab-1".to_string(),
            RestoredTerminalTab {
                project_id: "project-1".to_string(),
                worktree_id: "worktree-1".to_string(),
            },
        );
        state.tabs_service.restored_terminal_tabs.insert(
            "tab-2".to_string(),
            RestoredTerminalTab {
                project_id: "project-1".to_string(),
                worktree_id: "worktree-2".to_string(),
            },
        );
        state
            .tabs_service
            .terminal_restore_locks
            .insert("tab-1".to_string(), Arc::new(Mutex::new(())));
        state
            .tabs_service
            .terminal_restore_locks
            .insert("tab-2".to_string(), Arc::new(Mutex::new(())));

        state
            .tabs_service
            .clear_worktree_runtime_state("worktree-1");

        assert!(
            !state
                .tabs_service
                .restored_terminal_tabs
                .contains_key("tab-1")
        );
        assert!(
            !state
                .tabs_service
                .terminal_restore_locks
                .contains_key("tab-1")
        );
        assert!(
            state
                .tabs_service
                .restored_terminal_tabs
                .contains_key("tab-2")
        );
        assert!(
            state
                .tabs_service
                .terminal_restore_locks
                .contains_key("tab-2")
        );
    }

    #[test]
    fn initial_terminal_size_uses_restore_payload_size() {
        let restore_payload = TerminalRestorePayload {
            size: TerminalSize::new(132, 47),
            history: Vec::new(),
        };

        assert_eq!(
            initial_terminal_size(Some(&restore_payload)),
            TerminalSize::new(132, 47)
        );
        assert_eq!(initial_terminal_size(None), TerminalSize::default_pty());
    }

    #[test]
    fn restored_terminal_worker_state_starts_from_restored_history() {
        let restore_payload = TerminalRestorePayload {
            size: TerminalSize::new(132, 47),
            history: b"restored output".to_vec(),
        };
        let state = initial_terminal_persistence_worker_state(
            Some(()),
            TerminalPersistenceSeed {
                total_bytes: restore_payload.history.len() as u64,
                replay_epoch: 3,
                replay_filter: ReplayFilter::default(),
            },
        );

        assert_eq!(state.source_bytes_end, restore_payload.history.len() as u64);
        assert_eq!(
            state.replay_total_bytes,
            restore_payload.history.len() as u64
        );
        assert_eq!(state.replay_epoch, 3);
    }

    #[test]
    fn fresh_terminal_worker_state_starts_empty() {
        let state = initial_terminal_persistence_worker_state(
            None,
            TerminalPersistenceSeed {
                total_bytes: 128,
                replay_epoch: 7,
                replay_filter: ReplayFilter::default(),
            },
        );

        assert_eq!(state.source_bytes_end, 0);
        assert_eq!(state.replay_total_bytes, 0);
        assert_eq!(state.replay_epoch, 0);
    }

    #[tokio::test]
    async fn no_op_flush_marks_restored_tab_clean() {
        let tmp = TempDir::new().unwrap();
        let info = TabInfo::Terminal {
            id: "terminal-1".to_string(),
            session_id: "default".to_string(),
            worktree_id: "worktree-1".to_string(),
            pane_id: "pane-1".to_string(),
            label: "Terminal 1".to_string(),
            position: 1.0,
            created_at: 1,
            preview: false,
            has_notification: false,
            labels: TerminalTabLabels {
                custom_label: None,
                smart_label: None,
                title_label: None,
            },
        };
        let restore_payload = TerminalRestorePayload {
            size: TerminalSize::default_pty(),
            history: b"restored output".to_vec(),
        };
        let (runtime, _close_rx, worker_state) = spawn_terminal_runtime(
            tmp.path().to_str().unwrap(),
            info,
            Some(restore_payload),
            4096,
        )
        .unwrap();

        let mut dirty = true;
        let mut pending_bytes = 128;
        let mut in_flight = None;
        queue_terminal_persistence_flush(
            &runtime,
            &mut dirty,
            &mut pending_bytes,
            &mut in_flight,
            &worker_state,
        );

        assert!(!dirty);
        assert_eq!(pending_bytes, 0);
        assert!(in_flight.is_none());
        runtime.kill();
    }
}
