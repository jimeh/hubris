use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeFileKind {
    Directory,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeFileEntry {
    pub name: String,
    pub path: String,
    pub kind: WorktreeFileKind,
    pub is_symlink: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListWorktreeFilesResponse {
    pub generation: u32,
    /// Relative path from the worktree root.
    pub path: String,
    pub entries: Vec<WorktreeFileEntry>,
}
