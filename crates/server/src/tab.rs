use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utoipa::ToSchema;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum GitDiffScope {
    Staged,
    Unstaged,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TabInfo {
    Terminal {
        id: String,
        session_id: String,
        worktree_id: String,
        label: String,
        position: f64,
        #[ts(type = "number")]
        created_at: u64,
        preview: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        has_notification: bool,
    },
    File {
        id: String,
        session_id: String,
        worktree_id: String,
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
        label: String,
        position: f64,
        #[ts(type = "number")]
        created_at: u64,
        preview: bool,
        path: String,
        scope: GitDiffScope,
        #[serde(skip_serializing_if = "Option::is_none")]
        original_path: Option<String>,
    },
}

impl TabInfo {
    pub fn id(&self) -> &str {
        match self {
            Self::Terminal { id, .. } | Self::File { id, .. } | Self::GitDiff { id, .. } => id,
        }
    }

    pub fn session_id(&self) -> &str {
        match self {
            Self::Terminal { session_id, .. }
            | Self::File { session_id, .. }
            | Self::GitDiff { session_id, .. } => session_id,
        }
    }

    pub fn worktree_id(&self) -> &str {
        match self {
            Self::Terminal { worktree_id, .. }
            | Self::File { worktree_id, .. }
            | Self::GitDiff { worktree_id, .. } => worktree_id,
        }
    }

    pub fn label(&self) -> &str {
        match self {
            Self::Terminal { label, .. }
            | Self::File { label, .. }
            | Self::GitDiff { label, .. } => label,
        }
    }

    pub fn position(&self) -> f64 {
        match self {
            Self::Terminal { position, .. }
            | Self::File { position, .. }
            | Self::GitDiff { position, .. } => *position,
        }
    }

    pub fn created_at(&self) -> u64 {
        match self {
            Self::Terminal { created_at, .. }
            | Self::File { created_at, .. }
            | Self::GitDiff { created_at, .. } => *created_at,
        }
    }

    pub fn preview(&self) -> bool {
        match self {
            Self::Terminal { preview, .. }
            | Self::File { preview, .. }
            | Self::GitDiff { preview, .. } => *preview,
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Terminal { .. })
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

    pub fn set_position(&mut self, next: f64) {
        match self {
            Self::Terminal { position, .. }
            | Self::File { position, .. }
            | Self::GitDiff { position, .. } => *position = next,
        }
    }

    pub fn set_preview(&mut self, next: bool) {
        match self {
            Self::Terminal { preview, .. }
            | Self::File { preview, .. }
            | Self::GitDiff { preview, .. } => *preview = next,
        }
    }

    pub fn set_label(&mut self, next: String) {
        match self {
            Self::Terminal { label, .. }
            | Self::File { label, .. }
            | Self::GitDiff { label, .. } => *label = next,
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
}
