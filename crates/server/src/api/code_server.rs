use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utoipa::ToSchema;

use crate::api::files::ApiErrorResponse;
use crate::code_server::{
    CodeServerProcessStatusValue, CodeServerStatusSnapshot, ManagerCodeServerLatestCheck,
};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum CodeServerProcessStatus {
    Running,
    Stopped,
    Starting,
    Stopping,
    Installing,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CodeServerLatestCheck {
    #[serde(default)]
    pub latest_version: Option<String>,
    pub update_available: bool,
    #[serde(default)]
    pub checked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CodeServerStatus {
    pub supported: bool,
    #[serde(default)]
    pub installed_version: Option<String>,
    pub process_status: CodeServerProcessStatus,
    #[serde(default)]
    pub latest: Option<CodeServerLatestCheck>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InstallCodeServerRequest {
    #[serde(default)]
    pub version: Option<String>,
}

impl From<CodeServerProcessStatusValue> for CodeServerProcessStatus {
    fn from(value: CodeServerProcessStatusValue) -> Self {
        match value {
            CodeServerProcessStatusValue::Running => Self::Running,
            CodeServerProcessStatusValue::Stopped => Self::Stopped,
            CodeServerProcessStatusValue::Starting => Self::Starting,
            CodeServerProcessStatusValue::Stopping => Self::Stopping,
            CodeServerProcessStatusValue::Installing => Self::Installing,
            CodeServerProcessStatusValue::Error => Self::Error,
        }
    }
}

impl From<ManagerCodeServerLatestCheck> for CodeServerLatestCheck {
    fn from(value: ManagerCodeServerLatestCheck) -> Self {
        Self {
            latest_version: value.latest_version,
            update_available: value.update_available,
            checked_at: value.checked_at,
        }
    }
}

impl From<CodeServerStatusSnapshot> for CodeServerStatus {
    fn from(value: CodeServerStatusSnapshot) -> Self {
        Self {
            supported: value.supported,
            installed_version: value.installed_version,
            process_status: value.process_status.into(),
            latest: value.latest.map(Into::into),
            message: value.message,
        }
    }
}

fn map_code_server_error(
    error: crate::code_server::CodeServerError,
) -> (StatusCode, ApiErrorResponse) {
    let status = match error {
        crate::code_server::CodeServerError::UnsupportedPlatform(_)
        | crate::code_server::CodeServerError::InvalidReleaseRedirect(_)
        | crate::code_server::CodeServerError::InvalidVersion(_)
        | crate::code_server::CodeServerError::NotInstalled => StatusCode::BAD_REQUEST,
        crate::code_server::CodeServerError::StartupTimeout => StatusCode::BAD_GATEWAY,
        crate::code_server::CodeServerError::Io(_)
        | crate::code_server::CodeServerError::Http(_)
        | crate::code_server::CodeServerError::Archive(_)
        | crate::code_server::CodeServerError::Spawn(_)
        | crate::code_server::CodeServerError::WebSocket(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (
        status,
        ApiErrorResponse {
            message: error.to_string(),
        },
    )
}

fn code_server_error_response(error: crate::code_server::CodeServerError) -> Response {
    let (status, body) = map_code_server_error(error);
    (status, Json(body)).into_response()
}

#[utoipa::path(
    get,
    path = "/api/code-server",
    responses(
        (status = 200, description = "Current code-server status", body = CodeServerStatus),
    ),
)]
pub async fn get_code_server_status(State(state): State<AppState>) -> Json<CodeServerStatus> {
    Json(state.code_server.status().await.into())
}

#[utoipa::path(
    post,
    path = "/api/code-server/check-update",
    responses(
        (status = 200, description = "Latest release checked", body = CodeServerStatus),
        (status = 400, description = "Unsupported platform or invalid release metadata", body = ApiErrorResponse),
        (status = 500, description = "Internal server error", body = ApiErrorResponse),
    ),
)]
pub async fn check_code_server_update(State(state): State<AppState>) -> Response {
    match state.code_server.check_for_update().await {
        Ok(status) => Json(CodeServerStatus::from(status)).into_response(),
        Err(error) => code_server_error_response(error),
    }
}

#[utoipa::path(
    post,
    path = "/api/code-server/install",
    request_body = InstallCodeServerRequest,
    responses(
        (status = 200, description = "Installed or upgraded code-server", body = CodeServerStatus),
        (status = 400, description = "Unsupported platform or invalid request", body = ApiErrorResponse),
        (status = 500, description = "Internal server error", body = ApiErrorResponse),
    ),
)]
pub async fn install_code_server(
    State(state): State<AppState>,
    payload: Option<Json<InstallCodeServerRequest>>,
) -> Response {
    let version = payload.and_then(|body| body.version.clone());
    match state.code_server.install(version).await {
        Ok(status) => Json(CodeServerStatus::from(status)).into_response(),
        Err(error) => code_server_error_response(error),
    }
}

#[utoipa::path(
    post,
    path = "/api/code-server/start",
    responses(
        (status = 200, description = "Started code-server", body = CodeServerStatus),
        (status = 400, description = "code-server is not installed or unsupported", body = ApiErrorResponse),
        (status = 500, description = "Internal server error", body = ApiErrorResponse),
    ),
)]
pub async fn start_code_server(State(state): State<AppState>) -> Response {
    match state.code_server.start().await {
        Ok(status) => Json(CodeServerStatus::from(status)).into_response(),
        Err(error) => code_server_error_response(error),
    }
}

#[utoipa::path(
    post,
    path = "/api/code-server/stop",
    responses(
        (status = 200, description = "Stopped code-server", body = CodeServerStatus),
        (status = 500, description = "Internal server error", body = ApiErrorResponse),
    ),
)]
pub async fn stop_code_server(State(state): State<AppState>) -> Response {
    match state.code_server.stop().await {
        Ok(status) => Json(CodeServerStatus::from(status)).into_response(),
        Err(error) => code_server_error_response(error),
    }
}

#[utoipa::path(
    post,
    path = "/api/code-server/restart",
    responses(
        (status = 200, description = "Restarted code-server", body = CodeServerStatus),
        (status = 400, description = "code-server is not installed or unsupported", body = ApiErrorResponse),
        (status = 500, description = "Internal server error", body = ApiErrorResponse),
    ),
)]
pub async fn restart_code_server(State(state): State<AppState>) -> Response {
    match state.code_server.restart().await {
        Ok(status) => Json(CodeServerStatus::from(status)).into_response(),
        Err(error) => code_server_error_response(error),
    }
}
