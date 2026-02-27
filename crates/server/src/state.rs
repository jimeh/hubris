use std::path::PathBuf;
use std::sync::Arc;

use dashmap::DashMap;

use crate::pty::session::PtySession;

pub type SessionId = String;

#[derive(Clone)]
pub struct AppState {
    pub sessions: Arc<DashMap<SessionId, PtySession>>,
    pub data_dir: PathBuf,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
            data_dir,
        }
    }

    pub fn projects_file(&self) -> PathBuf {
        self.data_dir.join("projects.json")
    }
}
