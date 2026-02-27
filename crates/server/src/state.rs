use std::path::PathBuf;
use std::sync::atomic::AtomicU32;
use std::sync::Arc;

use dashmap::DashMap;

use crate::api::projects::Project;
use crate::pty::live_tab::LiveTab;

pub type TabId = String;

#[derive(Clone)]
pub struct AppState {
    pub tabs: Arc<DashMap<TabId, Arc<LiveTab>>>,
    pub next_tab_num: Arc<AtomicU32>,
    pub data_dir: PathBuf,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            tabs: Arc::new(DashMap::new()),
            next_tab_num: Arc::new(AtomicU32::new(1)),
            data_dir,
        }
    }

    pub fn projects_file(&self) -> PathBuf {
        self.data_dir.join("projects.json")
    }

    pub async fn load_projects(
        &self,
    ) -> Result<Vec<Project>, std::io::Error> {
        let path = self.projects_file();
        match tokio::fs::read_to_string(&path).await {
            Ok(contents) => {
                let projects: Vec<Project> =
                    serde_json::from_str(&contents)
                        .unwrap_or_default();
                Ok(projects)
            }
            Err(e)
                if e.kind()
                    == std::io::ErrorKind::NotFound =>
            {
                Ok(vec![])
            }
            Err(e) => Err(e),
        }
    }
}
