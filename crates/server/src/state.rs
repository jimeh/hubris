use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU32;

use dashmap::DashMap;

use crate::api::projects::Project;
use crate::events::EventBus;
use crate::pty::live_tab::LiveTab;
use crate::settings_manager::SettingsManager;

pub type TabId = String;

#[derive(Clone)]
pub struct AppState {
    pub tabs: Arc<DashMap<TabId, Arc<LiveTab>>>,
    pub events: Arc<EventBus>,
    pub next_tab_num: Arc<AtomicU32>,
    pub data_dir: PathBuf,
    pub settings: Arc<SettingsManager>,
}

impl AppState {
    pub async fn new(data_dir: PathBuf) -> Self {
        let events = Arc::new(EventBus::new());
        let settings = Arc::new(
            SettingsManager::new(data_dir.join("settings.toml"))
                .await
                .unwrap_or_else(|error| panic!("failed to initialize settings manager: {error}")),
        );
        if let Err(error) = settings.start_watcher(events.clone()) {
            tracing::warn!(
                "failed to watch settings file {}: {error}",
                settings.path().display()
            );
        }

        Self {
            tabs: Arc::new(DashMap::new()),
            events,
            next_tab_num: Arc::new(AtomicU32::new(1)),
            data_dir,
            settings,
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

    pub fn settings_file(&self) -> PathBuf {
        self.data_dir.join("settings.toml")
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
