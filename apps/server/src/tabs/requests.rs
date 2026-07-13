use serde::Deserialize;
use utoipa::ToSchema;

use crate::tab::{GitDiffScope, WorktreePaneNode, WorktreePaneTabs};

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CreateTabRequest {
    #[serde(rename_all = "camelCase")]
    Terminal {
        worktree_id: String,
        #[serde(default)]
        pane_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    File {
        worktree_id: String,
        path: String,
        #[serde(default)]
        pane_id: Option<String>,
        #[serde(default)]
        preview: bool,
    },
    #[serde(rename_all = "camelCase")]
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
    #[serde(rename_all = "camelCase")]
    Browser {
        worktree_id: String,
        #[serde(default)]
        pane_id: Option<String>,
        url: String,
    },
    #[serde(rename_all = "camelCase")]
    AgentChat {
        worktree_id: String,
        #[serde(default)]
        pane_id: Option<String>,
        #[serde(default)]
        conversation_id: Option<String>,
    },
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
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
