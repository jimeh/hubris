use std::path::PathBuf;
use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::Mutex;

use crate::api::projects::Project;
use crate::events::EventBus;
use crate::process_manager::ManagedProcessService;
use crate::pty::live_tab::LiveTab;
use crate::settings_manager::SettingsManager;
use crate::tab::{TabInfo, WorktreeTabLayout};
use crate::task_manager::TaskService;
use crate::vscode::{CodeServerManager, VscodeCliManager, VscodeManager, register_vscode_tasks};
use crate::worktree_files::WorktreeFilesService;
use crate::worktree_state::{WorktreeRestoreState, WorktreeStateService};

pub type TabId = String;

#[derive(Debug, Clone)]
pub struct RestoredTerminalTab {
    pub project_id: String,
    pub worktree_id: String,
}

#[derive(Clone)]
pub struct AppState {
    pub tabs: Arc<DashMap<TabId, TabInfo>>,
    pub tab_layouts: Arc<DashMap<String, WorktreeTabLayout>>,
    pub terminal_tabs: Arc<DashMap<TabId, Arc<LiveTab>>>,
    pub restored_terminal_tabs: Arc<DashMap<TabId, RestoredTerminalTab>>,
    pub terminal_restore_locks: Arc<DashMap<TabId, Arc<Mutex<()>>>>,
    pub restore_state_by_worktree: Arc<DashMap<String, WorktreeRestoreState>>,
    pub project_id_by_worktree: Arc<DashMap<String, String>>,
    pub events: Arc<EventBus>,
    pub next_terminal_num_by_worktree: Arc<DashMap<String, u32>>,
    pub data_dir: PathBuf,
    pub persistence: Arc<WorktreeStateService>,
    pub processes: Arc<ManagedProcessService>,
    pub tasks: Arc<TaskService>,
    pub vscode: Arc<VscodeManager>,
    pub settings: Arc<SettingsManager>,
    pub worktree_files: Arc<WorktreeFilesService>,
}

impl AppState {
    pub async fn try_new(data_dir: PathBuf) -> std::io::Result<Self> {
        let events = Arc::new(EventBus::new());
        let persistence =
            Arc::new(WorktreeStateService::new(data_dir.join("state.sqlite3")).await?);
        let settings = Arc::new(
            SettingsManager::new(data_dir.join("settings.toml"))
                .await
                .map_err(std::io::Error::other)?,
        );
        settings.start_sync(events.clone());
        let processes = Arc::new(ManagedProcessService::new(events.clone()));
        let tasks = Arc::new(TaskService::new(events.clone()));
        let code_server = Arc::new(CodeServerManager::new(
            data_dir.join("code-server"),
            events.clone(),
            processes.clone(),
        ));
        let vscode_cli = Arc::new(VscodeCliManager::new(
            data_dir.join("vscode-cli"),
            events.clone(),
            processes.clone(),
        ));
        let vscode = Arc::new(VscodeManager::new(
            settings.clone(),
            events.clone(),
            tasks.clone(),
            code_server.clone(),
            vscode_cli.clone(),
        ));
        register_vscode_tasks(&tasks, code_server.clone(), vscode_cli.clone());
        processes.register_controller(code_server.clone());
        processes.register_controller(vscode_cli.clone());
        code_server.clone().register_process_callback().await;
        vscode_cli.clone().register_process_callback().await;
        vscode.clone().register_status_callbacks().await;

        Ok(Self {
            tabs: Arc::new(DashMap::new()),
            tab_layouts: Arc::new(DashMap::new()),
            terminal_tabs: Arc::new(DashMap::new()),
            restored_terminal_tabs: Arc::new(DashMap::new()),
            terminal_restore_locks: Arc::new(DashMap::new()),
            restore_state_by_worktree: Arc::new(DashMap::new()),
            project_id_by_worktree: Arc::new(DashMap::new()),
            events: events.clone(),
            next_terminal_num_by_worktree: Arc::new(DashMap::new()),
            data_dir,
            persistence,
            processes,
            tasks,
            vscode,
            settings,
            worktree_files: Arc::new(WorktreeFilesService::new(events.clone())),
        })
    }

    pub async fn new(data_dir: PathBuf) -> Self {
        Self::try_new(data_dir)
            .await
            .unwrap_or_else(|error| panic!("failed to initialize app state: {error}"))
    }

    pub fn projects_file(&self) -> PathBuf {
        self.data_dir.join("projects.json")
    }

    pub fn project_meta_dir(&self) -> PathBuf {
        self.data_dir.join("project-meta")
    }

    pub fn project_meta_file(&self, project_id: &str) -> PathBuf {
        self.project_meta_dir().join(format!("{project_id}.json"))
    }

    /// Load projects from disk. Single source of truth
    /// (eliminates the duplicated load_projects in
    /// terminal.rs and projects.rs).
    pub fn load_projects(
        &self,
    ) -> impl std::future::Future<Output = Result<Vec<Project>, std::io::Error>> + Send + 'static
    {
        let path = self.projects_file();
        async move {
            match tokio::fs::read_to_string(&path).await {
                Ok(contents) => {
                    let projects: Vec<Project> =
                        serde_json::from_str(&contents).unwrap_or_default();
                    Ok(projects)
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
                Err(e) => Err(e),
            }
        }
    }

    pub fn remember_worktree_project(&self, worktree_id: &str, project_id: &str) {
        self.project_id_by_worktree
            .insert(worktree_id.to_string(), project_id.to_string());
    }

    pub fn project_id_for_worktree(&self, worktree_id: &str) -> Option<String> {
        self.project_id_by_worktree
            .get(worktree_id)
            .map(|entry| entry.value().clone())
    }

    pub fn restore_state_for_worktree(&self, worktree_id: &str) -> WorktreeRestoreState {
        self.restore_state_by_worktree
            .get(worktree_id)
            .map(|entry| entry.value().clone())
            .unwrap_or_default()
    }

    pub fn terminal_restore_lock(&self, tab_id: &str) -> Arc<Mutex<()>> {
        self.terminal_restore_locks
            .entry(tab_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub fn clear_worktree_runtime_state(&self, worktree_id: &str) {
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
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    #[tokio::test]
    async fn clear_worktree_runtime_state_removes_restore_locks_for_worktree() {
        let tmp = TempDir::new().unwrap();
        let state = AppState::new(tmp.path().to_path_buf()).await;
        state.restored_terminal_tabs.insert(
            "tab-1".to_string(),
            RestoredTerminalTab {
                project_id: "project-1".to_string(),
                worktree_id: "worktree-1".to_string(),
            },
        );
        state.restored_terminal_tabs.insert(
            "tab-2".to_string(),
            RestoredTerminalTab {
                project_id: "project-1".to_string(),
                worktree_id: "worktree-2".to_string(),
            },
        );
        state
            .terminal_restore_locks
            .insert("tab-1".to_string(), Arc::new(Mutex::new(())));
        state
            .terminal_restore_locks
            .insert("tab-2".to_string(), Arc::new(Mutex::new(())));

        state.clear_worktree_runtime_state("worktree-1");

        assert!(!state.restored_terminal_tabs.contains_key("tab-1"));
        assert!(!state.terminal_restore_locks.contains_key("tab-1"));
        assert!(state.restored_terminal_tabs.contains_key("tab-2"));
        assert!(state.terminal_restore_locks.contains_key("tab-2"));
    }
}
