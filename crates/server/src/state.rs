use std::path::PathBuf;
use std::sync::atomic::AtomicU32;
use std::sync::Arc;

use dashmap::DashMap;
use serde::Serialize;
use tokio::sync::broadcast;

use crate::api::projects::Project;
use crate::pty::live_tab::{LiveTab, TabInfo};

pub type TabId = String;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum StateEvent {
    #[serde(rename = "tab_created")]
    TabCreated(TabInfo),
    #[serde(rename = "tab_closed")]
    TabClosed { id: String },
}

#[derive(Clone)]
pub struct AppState {
    pub tabs: Arc<DashMap<TabId, Arc<LiveTab>>>,
    pub next_tab_num: Arc<AtomicU32>,
    pub events_tx: broadcast::Sender<StateEvent>,
    pub data_dir: PathBuf,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        let (events_tx, _) =
            broadcast::channel::<StateEvent>(64);
        Self {
            tabs: Arc::new(DashMap::new()),
            next_tab_num: Arc::new(AtomicU32::new(1)),
            events_tx,
            data_dir,
        }
    }

    /// Emit a state event to all SSE subscribers.
    pub fn emit(&self, event: StateEvent) {
        let _ = self.events_tx.send(event);
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
