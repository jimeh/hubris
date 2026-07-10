use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utoipa::ToSchema;

use crate::api::files::ApiErrorResponse;
use crate::api::settings::VscodeRuntimeKind;
pub use crate::domain::vscode::*;
use crate::state::AppState;
use crate::vscode::{VscodeConnection, VscodeError};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VscodeConnectionInfo {
    pub runtime: VscodeRuntimeKind,
    pub base_url: String,
    pub ws_base_url: String,
    pub upstream_base_path: String,
    #[serde(default)]
    pub connection_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InstallVscodeRequest {
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub force: bool,
}

impl From<VscodeConnection> for VscodeConnectionInfo {
    fn from(value: VscodeConnection) -> Self {
        Self {
            runtime: value.runtime,
            base_url: value.base_url,
            ws_base_url: value.ws_base_url,
            upstream_base_path: value.upstream_base_path,
            connection_token: value.connection_token,
        }
    }
}

fn map_vscode_error(error: &VscodeError) -> StatusCode {
    match error {
        VscodeError::CodeServer(error) => match error {
            crate::vscode::CodeServerError::UnsupportedPlatform(_)
            | crate::vscode::CodeServerError::InvalidReleaseRedirect(_)
            | crate::vscode::CodeServerError::InvalidVersion(_)
            | crate::vscode::CodeServerError::NotInstalled => StatusCode::BAD_REQUEST,
            crate::vscode::CodeServerError::StartupTimeout => StatusCode::BAD_GATEWAY,
            crate::vscode::CodeServerError::Io(_)
            | crate::vscode::CodeServerError::Http(_)
            | crate::vscode::CodeServerError::Archive(_)
            | crate::vscode::CodeServerError::Spawn(_)
            | crate::vscode::CodeServerError::WebSocket(_) => StatusCode::INTERNAL_SERVER_ERROR,
        },
        VscodeError::VscodeCli(error) => match error {
            crate::vscode::VscodeCliError::UnsupportedPlatform(_)
            | crate::vscode::VscodeCliError::InvalidVersion(_)
            | crate::vscode::VscodeCliError::NotInstalled => StatusCode::BAD_REQUEST,
            crate::vscode::VscodeCliError::StartupTimeout => StatusCode::BAD_GATEWAY,
            crate::vscode::VscodeCliError::Io(_)
            | crate::vscode::VscodeCliError::Http(_)
            | crate::vscode::VscodeCliError::Archive(_)
            | crate::vscode::VscodeCliError::Spawn(_) => StatusCode::INTERNAL_SERVER_ERROR,
        },
        VscodeError::Task(error) => match error.kind() {
            crate::task_manager::TaskActionErrorKind::NotFound => StatusCode::NOT_FOUND,
            crate::task_manager::TaskActionErrorKind::InvalidRequest => StatusCode::BAD_REQUEST,
            crate::task_manager::TaskActionErrorKind::Conflict => StatusCode::CONFLICT,
            crate::task_manager::TaskActionErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        },
    }
}

fn vscode_error_response(error: VscodeError) -> Response {
    (
        map_vscode_error(&error),
        Json(ApiErrorResponse {
            message: error.to_string(),
        }),
    )
        .into_response()
}

#[utoipa::path(
    get,
    path = "/api/vscode",
    responses(
        (status = 200, description = "Current VS Code runtime status", body = VscodeStatus),
    ),
)]
pub async fn get_vscode_status(State(state): State<AppState>) -> Json<VscodeStatus> {
    Json(state.vscode.status().await.into())
}

#[utoipa::path(
    post,
    path = "/api/vscode/check-update",
    responses(
        (status = 200, description = "Latest release checked", body = VscodeStatus),
        (status = 400, description = "Unsupported platform or invalid release metadata", body = ApiErrorResponse),
        (status = 500, description = "Internal server error", body = ApiErrorResponse),
    ),
)]
pub async fn check_vscode_update(State(state): State<AppState>) -> Response {
    match state.vscode.check_for_update().await {
        Ok(status) => Json(VscodeStatus::from(status)).into_response(),
        Err(error) => vscode_error_response(error),
    }
}

#[utoipa::path(
    post,
    path = "/api/vscode/install",
    request_body = InstallVscodeRequest,
    responses(
        (status = 202, description = "Started installing or upgrading the selected VS Code runtime", body = VscodeStatus),
        (status = 400, description = "Unsupported platform or invalid request", body = ApiErrorResponse),
        (status = 500, description = "Internal server error", body = ApiErrorResponse),
    ),
)]
pub async fn install_vscode(
    State(state): State<AppState>,
    payload: Option<Json<InstallVscodeRequest>>,
) -> Response {
    let (version, force) = payload
        .map(|body| (body.version.clone(), body.force))
        .unwrap_or((None, false));
    match state.vscode.install(version, force).await {
        Ok(status) => (StatusCode::ACCEPTED, Json(VscodeStatus::from(status))).into_response(),
        Err(error) => vscode_error_response(error),
    }
}

#[utoipa::path(
    post,
    path = "/api/vscode/start",
    responses(
        (status = 200, description = "Started the selected VS Code runtime", body = VscodeStatus),
        (status = 400, description = "Runtime is not installed or unsupported", body = ApiErrorResponse),
        (status = 500, description = "Internal server error", body = ApiErrorResponse),
    ),
)]
pub async fn start_vscode(State(state): State<AppState>) -> Response {
    match state.vscode.start().await {
        Ok(status) => Json(VscodeStatus::from(status)).into_response(),
        Err(error) => vscode_error_response(error),
    }
}

#[utoipa::path(
    post,
    path = "/api/vscode/stop",
    responses(
        (status = 200, description = "Stopped the selected VS Code runtime", body = VscodeStatus),
        (status = 500, description = "Internal server error", body = ApiErrorResponse),
    ),
)]
pub async fn stop_vscode(State(state): State<AppState>) -> Response {
    match state.vscode.stop().await {
        Ok(status) => Json(VscodeStatus::from(status)).into_response(),
        Err(error) => vscode_error_response(error),
    }
}

#[utoipa::path(
    post,
    path = "/api/vscode/restart",
    responses(
        (status = 200, description = "Restarted the selected VS Code runtime", body = VscodeStatus),
        (status = 400, description = "Runtime is not installed or unsupported", body = ApiErrorResponse),
        (status = 500, description = "Internal server error", body = ApiErrorResponse),
    ),
)]
pub async fn restart_vscode(State(state): State<AppState>) -> Response {
    match state.vscode.restart().await {
        Ok(status) => Json(VscodeStatus::from(status)).into_response(),
        Err(error) => vscode_error_response(error),
    }
}

async fn desktop_vscode_connection(state: &AppState, runtime: VscodeRuntimeKind) -> Response {
    match state.vscode.ensure_runtime_ready(runtime).await {
        Ok(connection) => Json(VscodeConnectionInfo::from(connection)).into_response(),
        Err(error) => vscode_error_response(error),
    }
}

pub async fn get_desktop_vscode_cli_connection(State(state): State<AppState>) -> Response {
    desktop_vscode_connection(&state, VscodeRuntimeKind::VscodeCli).await
}

pub async fn get_desktop_code_server_connection(State(state): State<AppState>) -> Response {
    desktop_vscode_connection(&state, VscodeRuntimeKind::CodeServer).await
}
