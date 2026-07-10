use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utoipa::ToSchema;

use crate::process_manager::{
    ManagedProcessExit, ManagedProcessLifecycleState, ManagedProcessStatusSnapshot,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ManagedProcessLifecycleStateValue {
    Stopped,
    Starting,
    Running,
    Stopping,
    Exited,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ManagedProcessExitInfo {
    #[serde(default)]
    pub code: Option<i32>,
    #[serde(default)]
    pub signal: Option<i32>,
    pub finished_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ManagedProcessStatus {
    pub id: String,
    pub kind: String,
    pub lifecycle_state: ManagedProcessLifecycleStateValue,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub last_exit: Option<ManagedProcessExitInfo>,
    #[serde(default)]
    pub last_error: Option<String>,
}

impl From<ManagedProcessLifecycleState> for ManagedProcessLifecycleStateValue {
    fn from(value: ManagedProcessLifecycleState) -> Self {
        match value {
            ManagedProcessLifecycleState::Stopped => Self::Stopped,
            ManagedProcessLifecycleState::Starting => Self::Starting,
            ManagedProcessLifecycleState::Running => Self::Running,
            ManagedProcessLifecycleState::Stopping => Self::Stopping,
            ManagedProcessLifecycleState::Exited => Self::Exited,
            ManagedProcessLifecycleState::Error => Self::Error,
        }
    }
}

impl From<ManagedProcessExit> for ManagedProcessExitInfo {
    fn from(value: ManagedProcessExit) -> Self {
        Self {
            code: value.code,
            signal: value.signal,
            finished_at: value.finished_at,
        }
    }
}

impl From<ManagedProcessStatusSnapshot> for ManagedProcessStatus {
    fn from(value: ManagedProcessStatusSnapshot) -> Self {
        Self {
            id: value.id,
            kind: value.kind,
            lifecycle_state: value.lifecycle_state.into(),
            pid: value.pid,
            started_at: value.started_at,
            last_exit: value.last_exit.map(Into::into),
            last_error: value.last_error,
        }
    }
}
