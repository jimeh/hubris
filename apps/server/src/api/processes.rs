use crate::api::files::ApiErrorResponse;
pub use crate::domain::process::*;
use crate::process_manager::{ManagedProcessActionError, ManagedProcessActionErrorKind};
use crate::state::AppState;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

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
