use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use ts_rs::TS;
use utoipa::ToSchema;

use crate::api::files::ApiErrorResponse;
use crate::state::AppState;
use crate::task_manager::{
    TaskActionError, TaskActionErrorKind,
    TaskDefinitionInputField as ManagerTaskDefinitionInputField,
    TaskDefinitionSnapshot as ManagerTaskDefinitionSnapshot,
    TaskInputFieldKind as ManagerTaskInputFieldKind,
    TaskInvocationSnapshot as ManagerTaskInvocationSnapshot,
    TaskRemovedEvent as ManagerTaskRemovedEvent, TaskStateValue,
    TaskStepDefinitionSnapshot as ManagerTaskStepDefinitionSnapshot, TaskStepStateValue,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum TaskInputFieldKind {
    String,
    Boolean,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskDefinitionInputField {
    pub name: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub required: bool,
    pub kind: TaskInputFieldKind,
    #[serde(default)]
    pub enum_values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskDefinition {
    pub name: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub broadcast_updates: bool,
    #[serde(default)]
    pub input_fields: Vec<TaskDefinitionInputField>,
    #[serde(default)]
    pub steps: Vec<TaskStepDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskStepDefinition {
    pub id: String,
    pub title: String,
    pub weight: u8,
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

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartTaskRequest {
    pub definition_name: String,
    #[serde(default)]
    pub input: Option<JsonValue>,
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

impl From<ManagerTaskInputFieldKind> for TaskInputFieldKind {
    fn from(value: ManagerTaskInputFieldKind) -> Self {
        match value {
            ManagerTaskInputFieldKind::String => Self::String,
            ManagerTaskInputFieldKind::Boolean => Self::Boolean,
        }
    }
}

impl From<ManagerTaskDefinitionInputField> for TaskDefinitionInputField {
    fn from(value: ManagerTaskDefinitionInputField) -> Self {
        Self {
            name: value.name,
            title: value.title,
            description: value.description,
            required: value.required,
            kind: value.kind.into(),
            enum_values: value.enum_values,
        }
    }
}

impl From<ManagerTaskStepDefinitionSnapshot> for TaskStepDefinition {
    fn from(value: ManagerTaskStepDefinitionSnapshot) -> Self {
        Self {
            id: value.id,
            title: value.title,
            weight: value.weight,
        }
    }
}

impl From<ManagerTaskDefinitionSnapshot> for TaskDefinition {
    fn from(value: ManagerTaskDefinitionSnapshot) -> Self {
        Self {
            name: value.name,
            title: value.title,
            description: value.description,
            broadcast_updates: value.broadcast_updates,
            input_fields: value.input_fields.into_iter().map(Into::into).collect(),
            steps: value.steps.into_iter().map(Into::into).collect(),
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

fn map_task_error(error: TaskActionError) -> (StatusCode, ApiErrorResponse) {
    let status = match error.kind() {
        TaskActionErrorKind::NotFound => StatusCode::NOT_FOUND,
        TaskActionErrorKind::InvalidRequest => StatusCode::BAD_REQUEST,
        TaskActionErrorKind::Conflict => StatusCode::CONFLICT,
        TaskActionErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (
        status,
        ApiErrorResponse {
            message: error.message().to_string(),
        },
    )
}

fn task_error_response(error: TaskActionError) -> Response {
    let (status, body) = map_task_error(error);
    (status, Json(body)).into_response()
}

#[utoipa::path(
    get,
    path = "/api/tasks/definitions",
    responses(
        (status = 200, description = "Task definitions", body = [TaskDefinition]),
    ),
)]
pub async fn list_task_definitions(State(state): State<AppState>) -> Json<Vec<TaskDefinition>> {
    Json(
        state
            .tasks
            .list_definitions()
            .into_iter()
            .map(Into::into)
            .collect(),
    )
}

#[utoipa::path(
    get,
    path = "/api/tasks",
    responses(
        (status = 200, description = "Task invocations", body = [TaskInvocationStatus]),
    ),
)]
pub async fn list_tasks(State(state): State<AppState>) -> Json<Vec<TaskInvocationStatus>> {
    Json(
        state
            .tasks
            .list()
            .await
            .into_iter()
            .map(Into::into)
            .collect(),
    )
}

#[utoipa::path(
    get,
    path = "/api/tasks/{id}",
    params(
        ("id" = String, Path, description = "Task invocation id"),
    ),
    responses(
        (status = 200, description = "Task invocation", body = TaskInvocationStatus),
        (status = 404, description = "Unknown task invocation", body = ApiErrorResponse),
    ),
)]
pub async fn get_task(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.tasks.get(&id).await {
        Ok(task) => Json(TaskInvocationStatus::from(task)).into_response(),
        Err(error) => task_error_response(error),
    }
}

#[utoipa::path(
    post,
    path = "/api/tasks",
    request_body = StartTaskRequest,
    responses(
        (status = 202, description = "Started or reused task invocation", body = TaskInvocationStatus),
        (status = 400, description = "Invalid task request", body = ApiErrorResponse),
        (status = 404, description = "Unknown task definition", body = ApiErrorResponse),
        (status = 409, description = "Conflicting active task scope", body = ApiErrorResponse),
    ),
)]
pub async fn start_task(
    State(state): State<AppState>,
    Json(payload): Json<StartTaskRequest>,
) -> Response {
    let input = match payload.input {
        None => Default::default(),
        Some(JsonValue::Object(input)) => input,
        Some(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiErrorResponse {
                    message: "task input must be a JSON object".to_string(),
                }),
            )
                .into_response();
        }
    };
    match state.tasks.start(&payload.definition_name, input).await {
        Ok(task) => (StatusCode::ACCEPTED, Json(TaskInvocationStatus::from(task))).into_response(),
        Err(error) => task_error_response(error),
    }
}
