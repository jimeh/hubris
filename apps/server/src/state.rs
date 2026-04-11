use std::path::PathBuf;
use std::sync::Arc;

use dashmap::DashMap;

use crate::api::projects::Project;
use crate::code_server::CodeServerManager;
use crate::events::EventBus;
use crate::process_manager::ManagedProcessService;
use crate::pty::live_tab::LiveTab;
use crate::settings_manager::SettingsManager;
use crate::tab::TabInfo;
use crate::worktree_files::WorktreeFilesService;

pub type TabId = String;

#[derive(Clone)]
pub struct AppState {
    pub tabs: Arc<DashMap<TabId, TabInfo>>,
    pub terminal_tabs: Arc<DashMap<TabId, Arc<LiveTab>>>,
    pub events: Arc<EventBus>,
    pub next_terminal_num_by_worktree: Arc<DashMap<String, u32>>,
    pub data_dir: PathBuf,
    pub processes: Arc<ManagedProcessService>,
    pub code_server: Arc<CodeServerManager>,
    pub settings: Arc<SettingsManager>,
    pub worktree_files: Arc<WorktreeFilesService>,
}

impl AppState {
    pub async fn new(data_dir: PathBuf) -> Self {
        let events = Arc::new(EventBus::new());
        let settings = Arc::new(
            SettingsManager::new(data_dir.join("settings.toml"))
                .await
                .unwrap_or_else(|error| panic!("failed to initialize settings manager: {error}")),
        );
        settings.start_sync(events.clone());
        let processes = Arc::new(ManagedProcessService::new(events.clone()));
        let code_server = Arc::new(CodeServerManager::new(
            data_dir.join("code-server"),
            events.clone(),
            processes.clone(),
        ));
        processes.register_controller(code_server.clone());
        code_server.register_process_callback().await;

        Self {
            tabs: Arc::new(DashMap::new()),
            terminal_tabs: Arc::new(DashMap::new()),
            events: events.clone(),
            next_terminal_num_by_worktree: Arc::new(DashMap::new()),
            data_dir,
            processes,
            code_server,
            settings,
            worktree_files: Arc::new(WorktreeFilesService::new(events.clone())),
        }
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
    pub async fn load_projects(&self) -> Result<Vec<Project>, std::io::Error> {
        let path = self.projects_file();
        match tokio::fs::read_to_string(&path).await {
            Ok(contents) => {
                let projects: Vec<Project> = serde_json::from_str(&contents).unwrap_or_default();
                Ok(projects)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(e) => Err(e),
        }
    }
}
