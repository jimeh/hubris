use std::path::PathBuf;
use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::chat::ChatService;
use crate::events::EventBus;
use crate::keybindings_manager::KeybindingsManager;
use crate::process_manager::ManagedProcessService;
use crate::project_store::ProjectStore;
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
    pub projects: Arc<ProjectStore>,
    pub persistence: Arc<WorktreeStateService>,
    pub processes: Arc<ManagedProcessService>,
    pub tasks: Arc<TaskService>,
    pub vscode: Arc<VscodeManager>,
    pub settings: Arc<SettingsManager>,
    pub keybindings: Arc<KeybindingsManager>,
    pub worktree_files: Arc<WorktreeFilesService>,
    pub chats: Arc<ChatService>,
    pub cancellation_token: CancellationToken,
}

impl AppState {
    pub async fn try_new(data_dir: PathBuf) -> std::io::Result<Self> {
        let events = Arc::new(EventBus::new());
        let cancellation_token = CancellationToken::new();
        let state_db_path = data_dir.join("state.sqlite3");
        let projects = Arc::new(
            ProjectStore::load(data_dir.join("projects.json"))
                .await
                .map_err(std::io::Error::other)?,
        );
        let settings = Arc::new(
            SettingsManager::new(data_dir.join("settings.toml"))
                .await
                .map_err(std::io::Error::other)?,
        );
        settings.start_sync(events.clone());
        let chats = Arc::new(
            ChatService::new(
                &data_dir.join("chat-history.sqlite3"),
                &state_db_path,
                events.clone(),
                settings.clone(),
                cancellation_token.child_token(),
            )
            .await?,
        );
        let persistence = Arc::new(WorktreeStateService::new(state_db_path).await?);
        let keybindings = Arc::new(
            KeybindingsManager::new(data_dir.join("keybindings.toml"))
                .await
                .map_err(std::io::Error::other)?,
        );
        keybindings.start_sync(events.clone());
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
            projects,
            persistence,
            processes,
            tasks,
            vscode,
            settings,
            keybindings,
            worktree_files: Arc::new(WorktreeFilesService::new(
                events.clone(),
                cancellation_token.child_token(),
            )),
            chats,
            cancellation_token,
        })
    }

    pub async fn new(data_dir: PathBuf) -> Self {
        Self::try_new(data_dir)
            .await
            .unwrap_or_else(|error| panic!("failed to initialize app state: {error}"))
    }

    pub fn project_meta_dir(&self) -> PathBuf {
        self.data_dir.join("project-meta")
    }

    pub fn project_meta_file(&self, project_id: &str) -> PathBuf {
        self.project_meta_dir().join(format!("{project_id}.json"))
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

    #[tokio::test]
    async fn try_new_fails_loudly_on_corrupt_projects_file() {
        let tmp = TempDir::new().unwrap();
        let projects_path = tmp.path().join("projects.json");
        let garbage = "{ definitely not a project list";
        std::fs::write(&projects_path, garbage).unwrap();

        let result = AppState::try_new(tmp.path().to_path_buf()).await;
        assert!(result.is_err());

        // The corrupt file must be preserved for recovery.
        let contents = std::fs::read_to_string(&projects_path).unwrap();
        assert_eq!(contents, garbage);
    }
}
