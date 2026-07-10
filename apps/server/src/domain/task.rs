use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utoipa::ToSchema;

use crate::task_manager::{
    TaskInvocationSnapshot as ManagerTaskInvocationSnapshot,
    TaskRemovedEvent as ManagerTaskRemovedEvent, TaskStateValue, TaskStepStateValue,
    TaskUpdatedEvent as ManagerTaskUpdatedEvent,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum TaskState {
    Pending,
    Running,
    Succeeded,
    Failed,
    RollingBack,
    RolledBack,
    RollbackFailed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum TaskStepState {
    Pending,
    Running,
    Skipped,
    Succeeded,
    Failed,
    RollingBack,
    RolledBack,
    RollbackFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskStepStatus {
    pub id: String,
    pub name: String,
    pub state: TaskStepState,
    pub progress_percent: u8,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub rollback_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskInvocationStatus {
    pub id: String,
    pub definition_name: String,
    pub title: String,
    pub status: TaskState,
    #[serde(default)]
    pub status_text: Option<String>,
    pub progress_percent: u8,
    pub created_at: String,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
    #[serde(default)]
    pub scope_key: Option<String>,
    #[serde(default)]
    pub failure_message: Option<String>,
    pub broadcast_updates: bool,
    pub steps: Vec<TaskStepStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdated {
    pub task: TaskInvocationStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskRemoved {
    pub id: String,
}

impl From<TaskStateValue> for TaskState {
    fn from(value: TaskStateValue) -> Self {
        match value {
            TaskStateValue::Pending => Self::Pending,
            TaskStateValue::Running => Self::Running,
            TaskStateValue::Succeeded => Self::Succeeded,
            TaskStateValue::Failed => Self::Failed,
            TaskStateValue::RollingBack => Self::RollingBack,
            TaskStateValue::RolledBack => Self::RolledBack,
            TaskStateValue::RollbackFailed => Self::RollbackFailed,
        }
    }
}

impl From<TaskStepStateValue> for TaskStepState {
    fn from(value: TaskStepStateValue) -> Self {
        match value {
            TaskStepStateValue::Pending => Self::Pending,
            TaskStepStateValue::Running => Self::Running,
            TaskStepStateValue::Skipped => Self::Skipped,
            TaskStepStateValue::Succeeded => Self::Succeeded,
            TaskStepStateValue::Failed => Self::Failed,
            TaskStepStateValue::RollingBack => Self::RollingBack,
            TaskStepStateValue::RolledBack => Self::RolledBack,
            TaskStepStateValue::RollbackFailed => Self::RollbackFailed,
        }
    }
}

impl From<ManagerTaskInvocationSnapshot> for TaskInvocationStatus {
    fn from(value: ManagerTaskInvocationSnapshot) -> Self {
        Self {
            id: value.id,
            definition_name: value.definition_name,
            title: value.title,
            status: value.status.into(),
            status_text: value.status_text,
            progress_percent: value.progress_percent,
            created_at: value.created_at,
            started_at: value.started_at,
            finished_at: value.finished_at,
            scope_key: value.scope_key,
            failure_message: value.failure_message,
            broadcast_updates: value.broadcast_updates,
            steps: value
                .steps
                .into_iter()
                .map(|step| TaskStepStatus {
                    id: step.id,
                    name: step.name,
                    state: step.state.into(),
                    progress_percent: step.progress_percent,
                    error: step.error,
                    rollback_error: step.rollback_error,
                })
                .collect(),
        }
    }
}

impl From<ManagerTaskUpdatedEvent> for TaskUpdated {
    fn from(value: ManagerTaskUpdatedEvent) -> Self {
        Self {
            task: value.task.into(),
        }
    }
}

impl From<ManagerTaskRemovedEvent> for TaskRemoved {
    fn from(value: ManagerTaskRemovedEvent) -> Self {
        Self { id: value.id }
    }
}
