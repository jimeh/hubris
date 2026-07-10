use crate::api::files::ApiErrorResponse;
pub use crate::domain::process::*;
use crate::error::ApiError;
use crate::process_manager::{ManagedProcessActionError, ManagedProcessActionErrorKind};
use crate::state::AppState;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;

fn map_managed_process_error(error: ManagedProcessActionError) -> ApiError {
    let status = match error.kind() {
        ManagedProcessActionErrorKind::NotFound => StatusCode::NOT_FOUND,
        ManagedProcessActionErrorKind::InvalidRequest => StatusCode::BAD_REQUEST,
        ManagedProcessActionErrorKind::Conflict => StatusCode::CONFLICT,
        ManagedProcessActionErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    };
    ApiError::with_status(status, error.message())
}

#[utoipa::path(
    get,
    path = "/api/processes",
    responses(
        (status = 200, description = "Managed processes", body = [ManagedProcessStatus]),
    ),
)]
pub async fn list_managed_processes(
    State(state): State<AppState>,
) -> Result<Json<Vec<ManagedProcessStatus>>, ApiError> {
    let processes = state
        .processes
        .list()
        .await
        .map_err(map_managed_process_error)?;
    Ok(Json(processes.into_iter().map(Into::into).collect()))
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
) -> Result<Json<ManagedProcessStatus>, ApiError> {
    let process = state
        .processes
        .get(&id)
        .await
        .map_err(map_managed_process_error)?;
    Ok(Json(process.into()))
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
) -> Result<Json<ManagedProcessStatus>, ApiError> {
    let process = state
        .processes
        .start(&id)
        .await
        .map_err(map_managed_process_error)?;
    Ok(Json(process.into()))
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
) -> Result<Json<ManagedProcessStatus>, ApiError> {
    let process = state
        .processes
        .stop(&id)
        .await
        .map_err(map_managed_process_error)?;
    Ok(Json(process.into()))
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
) -> Result<Json<ManagedProcessStatus>, ApiError> {
    let process = state
        .processes
        .restart(&id)
        .await
        .map_err(map_managed_process_error)?;
    Ok(Json(process.into()))
}
