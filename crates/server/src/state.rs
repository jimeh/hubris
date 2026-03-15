use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU32;

use dashmap::DashMap;
use tokio::sync::Mutex;

use crate::api::projects::Project;
use crate::events::EventBus;
use crate::pty::live_tab::LiveTab;

pub type TabId = String;

#[derive(Clone)]
pub struct AppState {
    pub tabs: Arc<DashMap<TabId, Arc<LiveTab>>>,
    pub events: Arc<EventBus>,
    pub next_tab_num: Arc<AtomicU32>,
    pub settings_lock: Arc<Mutex<()>>,
    pub data_dir: PathBuf,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            tabs: Arc::new(DashMap::new()),
            events: Arc::new(EventBus::new()),
            next_tab_num: Arc::new(AtomicU32::new(1)),
            settings_lock: Arc::new(Mutex::new(())),
            data_dir,
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
        self.data_dir.join("settings.json")
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
