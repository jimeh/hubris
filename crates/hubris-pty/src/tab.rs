use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utoipa::ToSchema;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum GitDiffScope {
    Staged,
    Unstaged,
    Commit,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, ToSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum TabPaneSplitAxis {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorktreePaneNode {
    Leaf {
        id: String,
        pane_id: String,
    },
    Split {
        id: String,
        axis: TabPaneSplitAxis,
        ratio: f64,
        first_id: String,
        second_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeTabLayout {
    pub root_id: String,
    pub nodes: Vec<WorktreePaneNode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePaneTabs {
    pub pane_id: String,
    pub tab_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeTabLayoutState {
    pub layout: WorktreeTabLayout,
    pub tabs: Vec<TabInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTabLabels {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smart_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TabInfo {
    Terminal {
        id: String,
        session_id: String,
        worktree_id: String,
        pane_id: String,
        label: String,
        position: f64,
        #[ts(type = "number")]
        created_at: u64,
        preview: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        has_notification: bool,
        #[serde(flatten)]
        labels: TerminalTabLabels,
    },
    File {
        id: String,
        session_id: String,
        worktree_id: String,
        pane_id: String,
        label: String,
        position: f64,
        #[ts(type = "number")]
        created_at: u64,
        preview: bool,
        path: String,
    },
    GitDiff {
        id: String,
        session_id: String,
        worktree_id: String,
        pane_id: String,
        label: String,
        position: f64,
        #[ts(type = "number")]
        created_at: u64,
        preview: bool,
        path: String,
        scope: GitDiffScope,
        #[serde(skip_serializing_if = "Option::is_none")]
        original_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        commit_id: Option<String>,
    },
    Browser {
        id: String,
        session_id: String,
        worktree_id: String,
        pane_id: String,
        label: String,
        position: f64,
        #[ts(type = "number")]
        created_at: u64,
        preview: bool,
        url: String,
        history: Vec<String>,
        history_index: usize,
    },
    AgentChat {
        id: String,
        session_id: String,
        worktree_id: String,
        pane_id: String,
        label: String,
        position: f64,
        #[ts(type = "number")]
        created_at: u64,
        preview: bool,
        conversation_id: String,
    },
}

impl TabInfo {
    pub fn id(&self) -> &str {
        match self {
            Self::Terminal { id, .. }
            | Self::File { id, .. }
            | Self::GitDiff { id, .. }
            | Self::Browser { id, .. }
            | Self::AgentChat { id, .. } => id,
        }
    }

    pub fn session_id(&self) -> &str {
        match self {
            Self::Terminal { session_id, .. }
            | Self::File { session_id, .. }
            | Self::GitDiff { session_id, .. }
            | Self::Browser { session_id, .. }
            | Self::AgentChat { session_id, .. } => session_id,
        }
    }

    pub fn worktree_id(&self) -> &str {
        match self {
            Self::Terminal { worktree_id, .. }
            | Self::File { worktree_id, .. }
            | Self::GitDiff { worktree_id, .. }
            | Self::Browser { worktree_id, .. }
            | Self::AgentChat { worktree_id, .. } => worktree_id,
        }
    }

    pub fn pane_id(&self) -> &str {
        match self {
            Self::Terminal { pane_id, .. }
            | Self::File { pane_id, .. }
            | Self::GitDiff { pane_id, .. }
            | Self::Browser { pane_id, .. }
            | Self::AgentChat { pane_id, .. } => pane_id,
        }
    }

    pub fn label(&self) -> &str {
        match self {
            Self::Terminal { label, .. }
            | Self::File { label, .. }
            | Self::GitDiff { label, .. }
            | Self::Browser { label, .. }
            | Self::AgentChat { label, .. } => label,
        }
    }

    pub fn position(&self) -> f64 {
        match self {
            Self::Terminal { position, .. }
            | Self::File { position, .. }
            | Self::GitDiff { position, .. }
            | Self::Browser { position, .. }
            | Self::AgentChat { position, .. } => *position,
        }
    }

    pub fn created_at(&self) -> u64 {
        match self {
            Self::Terminal { created_at, .. }
            | Self::File { created_at, .. }
            | Self::GitDiff { created_at, .. }
            | Self::Browser { created_at, .. }
            | Self::AgentChat { created_at, .. } => *created_at,
        }
    }

    pub fn preview(&self) -> bool {
        match self {
            Self::Terminal { preview, .. }
            | Self::File { preview, .. }
            | Self::GitDiff { preview, .. }
            | Self::Browser { preview, .. }
            | Self::AgentChat { preview, .. } => *preview,
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Terminal { .. })
    }

    pub fn is_browser(&self) -> bool {
        matches!(self, Self::Browser { .. })
    }

    pub fn is_agent_chat(&self) -> bool {
        matches!(self, Self::AgentChat { .. })
    }

    pub fn has_notification(&self) -> bool {
        matches!(
            self,
            Self::Terminal {
                has_notification: true,
                ..
            }
        )
    }

    pub fn custom_label(&self) -> Option<&str> {
        match self {
            Self::Terminal { labels, .. } => labels.custom_label.as_deref(),
            _ => None,
        }
    }

    pub fn smart_label(&self) -> Option<&str> {
        match self {
            Self::Terminal { labels, .. } => labels.smart_label.as_deref(),
            _ => None,
        }
    }

    pub fn title_label(&self) -> Option<&str> {
        match self {
            Self::Terminal { labels, .. } => labels.title_label.as_deref(),
            _ => None,
        }
    }

    pub fn url(&self) -> Option<&str> {
        match self {
            Self::Browser { url, .. } => Some(url),
            _ => None,
        }
    }

    pub fn history(&self) -> Option<&[String]> {
        match self {
            Self::Browser { history, .. } => Some(history),
            _ => None,
        }
    }

    pub fn history_index(&self) -> Option<usize> {
        match self {
            Self::Browser { history_index, .. } => Some(*history_index),
            _ => None,
        }
    }

    pub fn conversation_id(&self) -> Option<&str> {
        match self {
            Self::AgentChat {
                conversation_id, ..
            } => Some(conversation_id),
            _ => None,
        }
    }

    pub fn set_position(&mut self, next: f64) {
        match self {
            Self::Terminal { position, .. }
            | Self::File { position, .. }
            | Self::GitDiff { position, .. }
            | Self::Browser { position, .. }
            | Self::AgentChat { position, .. } => *position = next,
        }
    }

    pub fn set_pane_id(&mut self, next: String) {
        match self {
            Self::Terminal { pane_id, .. }
            | Self::File { pane_id, .. }
            | Self::GitDiff { pane_id, .. }
            | Self::Browser { pane_id, .. }
            | Self::AgentChat { pane_id, .. } => *pane_id = next,
        }
    }

    pub fn set_preview(&mut self, next: bool) {
        match self {
            Self::Terminal { preview, .. }
            | Self::File { preview, .. }
            | Self::GitDiff { preview, .. }
            | Self::Browser { preview, .. }
            | Self::AgentChat { preview, .. } => *preview = next,
        }
    }

    pub fn set_label(&mut self, next: String) {
        match self {
            Self::Terminal { label, .. }
            | Self::File { label, .. }
            | Self::GitDiff { label, .. }
            | Self::Browser { label, .. }
            | Self::AgentChat { label, .. } => *label = next,
        }
    }

    pub fn set_has_notification(&mut self, next: bool) {
        if let Self::Terminal {
            has_notification, ..
        } = self
        {
            *has_notification = next;
        }
    }

    pub fn set_custom_label(&mut self, next: Option<String>) {
        if let Self::Terminal { labels, .. } = self {
            labels.custom_label = next;
        }
    }

    pub fn set_smart_label(&mut self, next: Option<String>) {
        if let Self::Terminal { labels, .. } = self {
            labels.smart_label = next;
        }
    }

    pub fn set_title_label(&mut self, next: Option<String>) {
        if let Self::Terminal { labels, .. } = self {
            labels.title_label = next;
        }
    }

    pub fn set_url(&mut self, next: String) {
        if let Self::Browser { url, .. } = self {
            *url = next;
        }
    }

    pub fn set_history(&mut self, next: Vec<String>) {
        if let Self::Browser { history, .. } = self {
            *history = next;
        }
    }

    pub fn set_history_index(&mut self, next: usize) {
        if let Self::Browser { history_index, .. } = self {
            *history_index = next;
        }
    }
}
