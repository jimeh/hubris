use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use ts_rs::TS;
use utoipa::ToSchema;

use crate::api::files::ApiErrorResponse;
pub use crate::domain::task::*;
use crate::state::AppState;
use crate::task_manager::{
    TaskActionError, TaskActionErrorKind,
    TaskDefinitionInputField as ManagerTaskDefinitionInputField,
    TaskDefinitionSnapshot as ManagerTaskDefinitionSnapshot,
    TaskInputFieldKind as ManagerTaskInputFieldKind,
    TaskStepDefinitionSnapshot as ManagerTaskStepDefinitionSnapshot,
};

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

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartTaskRequest {
    pub definition_name: String,
    #[serde(default)]
    pub input: Option<JsonValue>,
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
