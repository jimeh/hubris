use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utoipa::ToSchema;

use crate::api::files::ApiErrorResponse;
use crate::process_manager::{
    ManagedProcessActionError, ManagedProcessActionErrorKind, ManagedProcessExit,
    ManagedProcessLifecycleState, ManagedProcessStatusSnapshot,
};
use crate::state::AppState;

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

fn map_managed_process_error(error: ManagedProcessActionError) -> (StatusCode, ApiErrorResponse) {
    let status = match error.kind() {
        ManagedProcessActionErrorKind::NotFound => StatusCode::NOT_FOUND,
        ManagedProcessActionErrorKind::InvalidRequest => StatusCode::BAD_REQUEST,
        ManagedProcessActionErrorKind::Conflict => StatusCode::CONFLICT,
        ManagedProcessActionErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (
        status,
        ApiErrorResponse {
            message: error.message().to_string(),
        },
    )
}

fn managed_process_error_response(error: ManagedProcessActionError) -> Response {
    let (status, body) = map_managed_process_error(error);
    (status, Json(body)).into_response()
}

#[utoipa::path(
    get,
    path = "/api/processes",
    responses(
        (status = 200, description = "Managed processes", body = [ManagedProcessStatus]),
    ),
)]
pub async fn list_managed_processes(State(state): State<AppState>) -> Response {
    match state.processes.list().await {
        Ok(processes) => Json(
            processes
                .into_iter()
                .map(ManagedProcessStatus::from)
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(error) => managed_process_error_response(error),
    }
}

#[utoipa::path(
    get,
    path = "/api/processes/{id}",
    params(
        ("id" = String, Path, description = "Managed process id"),
    ),
    responses(
        (status = 200, description = "Managed process status", body = ManagedProcessStatus),
        (status = 404, description = "Unknown managed process", body = ApiErrorResponse),
    ),
)]
pub async fn get_managed_process(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    match state.processes.get(&id).await {
        Ok(process) => Json(ManagedProcessStatus::from(process)).into_response(),
        Err(error) => managed_process_error_response(error),
    }
}

#[utoipa::path(
    post,
    path = "/api/processes/{id}/start",
    params(
        ("id" = String, Path, description = "Managed process id"),
    ),
    responses(
        (status = 200, description = "Started process", body = ManagedProcessStatus),
        (status = 404, description = "Unknown managed process", body = ApiErrorResponse),
    ),
)]
pub async fn start_managed_process(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    match state.processes.start(&id).await {
        Ok(process) => Json(ManagedProcessStatus::from(process)).into_response(),
        Err(error) => managed_process_error_response(error),
    }
}

#[utoipa::path(
    post,
    path = "/api/processes/{id}/stop",
    params(
        ("id" = String, Path, description = "Managed process id"),
    ),
    responses(
        (status = 200, description = "Stopped process", body = ManagedProcessStatus),
        (status = 404, description = "Unknown managed process", body = ApiErrorResponse),
    ),
)]
pub async fn stop_managed_process(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    match state.processes.stop(&id).await {
        Ok(process) => Json(ManagedProcessStatus::from(process)).into_response(),
        Err(error) => managed_process_error_response(error),
    }
}

#[utoipa::path(
    post,
    path = "/api/processes/{id}/restart",
    params(
        ("id" = String, Path, description = "Managed process id"),
    ),
    responses(
        (status = 200, description = "Restarted process", body = ManagedProcessStatus),
        (status = 404, description = "Unknown managed process", body = ApiErrorResponse),
    ),
)]
pub async fn restart_managed_process(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    match state.processes.restart(&id).await {
        Ok(process) => Json(ManagedProcessStatus::from(process)).into_response(),
        Err(error) => managed_process_error_response(error),
    }
}
