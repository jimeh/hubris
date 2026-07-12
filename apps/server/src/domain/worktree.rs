use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utoipa::ToSchema;

use crate::domain::project::Project;
use crate::git;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, TS)]
pub struct Worktree {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub path: String,
    pub branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
    pub ui_mode: WorktreeUiMode,
    pub is_local: bool,
    #[serde(default)]
    pub is_imported: bool,
    #[serde(default)]
    pub missing_on_disk: bool,
    pub position: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeUiMode {
    #[default]
    Hubris,
    Vscode,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct ManagedWorktree {
    pub(crate) id: String,
    pub(crate) path: String,
    pub(crate) branch: String,
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) source_ref: Option<String>,
    #[serde(default)]
    pub(crate) imported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct ProjectMeta {
    #[serde(default)]
    pub(crate) worktree_order: Vec<String>,
    #[serde(default)]
    pub(crate) managed_worktrees: Vec<ManagedWorktree>,
    #[serde(default)]
    pub(crate) worktree_ui_modes: HashMap<String, WorktreeUiMode>,
}

pub(crate) async fn load_meta(path: PathBuf) -> ProjectMeta {
    match tokio::fs::read_to_string(path).await {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => ProjectMeta::default(),
    }
}

fn sort_non_local(mut non_local: Vec<Worktree>, order: &[String]) -> Vec<Worktree> {
    let mut by_id: HashMap<String, Worktree> =
        non_local.drain(..).map(|wt| (wt.id.clone(), wt)).collect();

    let mut ordered = Vec::new();
    for id in order {
        if let Some(wt) = by_id.remove(id) {
            ordered.push(wt);
        }
    }

    let mut remaining: Vec<Worktree> = by_id.into_values().collect();
    remaining.sort_by_key(|worktree| worktree.name.to_lowercase());
    ordered.extend(remaining);
    ordered
}

pub(crate) fn local_worktree_id(project: &Project) -> String {
    git::worktree_id(PathBuf::from(&project.path).as_path())
}

pub(crate) fn normalize_meta(meta: &mut ProjectMeta, local_worktree_id: &str) {
    let managed_ids: HashSet<String> = meta
        .managed_worktrees
        .iter()
        .map(|wt| wt.id.clone())
        .collect();
    meta.worktree_order.retain(|id| managed_ids.contains(id));

    let mut valid_ui_mode_ids = managed_ids;
    valid_ui_mode_ids.insert(local_worktree_id.to_string());
    meta.worktree_ui_modes
        .retain(|id, _| valid_ui_mode_ids.contains(id));
}

fn worktree_ui_mode(meta: &ProjectMeta, worktree_id: &str) -> WorktreeUiMode {
    meta.worktree_ui_modes
        .get(worktree_id)
        .copied()
        .unwrap_or_default()
}

pub async fn list_worktrees_for_project(state: &AppState, project: &Project) -> Vec<Worktree> {
    let mut meta = load_meta(state.project_meta_file(&project.id)).await;
    let local_id = local_worktree_id(project);
    normalize_meta(&mut meta, &local_id);

    let local_path_buf = PathBuf::from(&project.path);
    let local_path = local_path_buf.to_string_lossy().to_string();
    let local = Worktree {
        id: local_id.clone(),
        project_id: project.id.clone(),
        name: "local".to_string(),
        path: local_path,
        branch: "local".to_string(),
        source_ref: None,
        ui_mode: worktree_ui_mode(&meta, &local_id),
        is_local: true,
        is_imported: false,
        missing_on_disk: tokio::fs::metadata(&local_path_buf).await.is_err(),
        position: 0.0,
    };

    let managed_worktrees = meta.managed_worktrees.clone();
    let mut non_local = Vec::with_capacity(managed_worktrees.len());
    for managed in managed_worktrees {
        let managed_id = managed.id.clone();
        let branch = managed.branch;
        let name = managed.name.unwrap_or_else(|| branch.clone());
        let path_buf = PathBuf::from(&managed.path);
        non_local.push(Worktree {
            id: managed_id.clone(),
            project_id: project.id.clone(),
            name,
            path: managed.path,
            branch,
            source_ref: managed.source_ref,
            ui_mode: worktree_ui_mode(&meta, &managed_id),
            is_local: false,
            is_imported: managed.imported,
            missing_on_disk: tokio::fs::metadata(&path_buf).await.is_err(),
            position: 0.0,
        });
    }

    let mut ordered = vec![local];
    ordered.extend(sort_non_local(non_local, &meta.worktree_order));

    for (idx, wt) in ordered.iter_mut().enumerate() {
        wt.position = (idx + 1) as f64;
    }

    ordered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_meta_serializes_with_internal_snake_case_keys() {
        let meta = ProjectMeta {
            worktree_order: vec!["managed-1".to_string()],
            managed_worktrees: vec![ManagedWorktree {
                id: "managed-1".to_string(),
                path: "/repos/project/.worktrees/managed-1".to_string(),
                branch: "feature/internal-format".to_string(),
                name: Some("Internal format".to_string()),
                source_ref: Some("origin/main".to_string()),
                imported: true,
            }],
            worktree_ui_modes: HashMap::from([("managed-1".to_string(), WorktreeUiMode::Vscode)]),
        };

        let serialized = serde_json::to_value(meta).unwrap();

        assert_eq!(
            serialized,
            serde_json::json!({
                "worktree_order": ["managed-1"],
                "managed_worktrees": [{
                    "id": "managed-1",
                    "path": "/repos/project/.worktrees/managed-1",
                    "branch": "feature/internal-format",
                    "name": "Internal format",
                    "source_ref": "origin/main",
                    "imported": true
                }],
                "worktree_ui_modes": {
                    "managed-1": "vscode"
                }
            })
        );
    }
}
