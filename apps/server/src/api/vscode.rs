use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utoipa::ToSchema;

use crate::api::files::ApiErrorResponse;
use crate::api::settings::VscodeRuntimeKind;
use crate::state::AppState;
use crate::vscode::{
    CodeServerInstallPhaseValue, CodeServerProcessStatusValue, ManagerCodeServerInstallProgress,
    ManagerCodeServerLatestCheck, VscodeConnection, VscodeError, VscodePathModeValue,
    VscodeRuntimeStatusSnapshot, VscodeStatusSnapshot,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum VscodeInstallPhase {
    Preparing,
    Downloading,
    Extracting,
    Cleaning,
    Starting,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VscodeInstallProgress {
    pub phase: VscodeInstallPhase,
    pub percent: u8,
    #[serde(default)]
    pub downloaded_bytes: Option<u64>,
    #[serde(default)]
    pub total_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum VscodeProcessStatus {
    Running,
    Stopped,
    Starting,
    Stopping,
    Installing,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VscodeLatestCheck {
    #[serde(default)]
    pub latest_version: Option<String>,
    pub update_available: bool,
    #[serde(default)]
    pub checked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VscodeRuntimeStatus {
    pub supported: bool,
    #[serde(default)]
    pub installed_version: Option<String>,
    pub process_status: VscodeProcessStatus,
    #[serde(default)]
    pub latest: Option<VscodeLatestCheck>,
    #[serde(default)]
    pub install_progress: Option<VscodeInstallProgress>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VscodeStatus {
    pub selected_runtime: VscodeRuntimeKind,
    pub code_server: VscodeRuntimeStatus,
    pub vscode_cli: VscodeRuntimeStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum VscodePathMode {
    StripPublicBasePath,
    PreservePublicBasePath,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VscodeConnectionInfo {
    pub runtime: VscodeRuntimeKind,
    pub base_url: String,
    pub ws_base_url: String,
    pub path_mode: VscodePathMode,
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

impl From<CodeServerProcessStatusValue> for VscodeProcessStatus {
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

impl From<CodeServerInstallPhaseValue> for VscodeInstallPhase {
    fn from(value: CodeServerInstallPhaseValue) -> Self {
        match value {
            CodeServerInstallPhaseValue::Preparing => Self::Preparing,
            CodeServerInstallPhaseValue::Downloading => Self::Downloading,
            CodeServerInstallPhaseValue::Extracting => Self::Extracting,
            CodeServerInstallPhaseValue::Cleaning => Self::Cleaning,
            CodeServerInstallPhaseValue::Starting => Self::Starting,
        }
    }
}

impl From<ManagerCodeServerInstallProgress> for VscodeInstallProgress {
    fn from(value: ManagerCodeServerInstallProgress) -> Self {
        Self {
            phase: value.phase.into(),
            percent: value.percent,
            downloaded_bytes: value.downloaded_bytes,
            total_bytes: value.total_bytes,
        }
    }
}

impl From<ManagerCodeServerLatestCheck> for VscodeLatestCheck {
    fn from(value: ManagerCodeServerLatestCheck) -> Self {
        Self {
            latest_version: value.latest_version,
            update_available: value.update_available,
            checked_at: value.checked_at,
        }
    }
}

impl From<VscodeRuntimeStatusSnapshot> for VscodeRuntimeStatus {
    fn from(value: VscodeRuntimeStatusSnapshot) -> Self {
        Self {
            supported: value.supported,
            installed_version: value.installed_version,
            process_status: value.process_status.into(),
            latest: value.latest.map(Into::into),
            install_progress: value.install_progress.map(Into::into),
            message: value.message,
        }
    }
}

impl From<VscodeStatusSnapshot> for VscodeStatus {
    fn from(value: VscodeStatusSnapshot) -> Self {
        Self {
            selected_runtime: value.selected_runtime,
            code_server: value.code_server.into(),
            vscode_cli: value.vscode_cli.into(),
        }
    }
}

impl From<VscodePathModeValue> for VscodePathMode {
    fn from(value: VscodePathModeValue) -> Self {
        match value {
            VscodePathModeValue::StripPublicBasePath => Self::StripPublicBasePath,
            VscodePathModeValue::PreservePublicBasePath => Self::PreservePublicBasePath,
        }
    }
}

impl From<VscodeConnection> for VscodeConnectionInfo {
    fn from(value: VscodeConnection) -> Self {
        let ws_base_url = value.ws_base_url();
        Self {
            runtime: value.runtime,
            base_url: value.base_url,
            ws_base_url,
            path_mode: value.path_mode.into(),
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

pub async fn get_desktop_vscode_connection(State(state): State<AppState>) -> Response {
    match state.vscode.ensure_ready().await {
        Ok(connection) => Json(VscodeConnectionInfo::from(connection)).into_response(),
        Err(error) => vscode_error_response(error),
    }
}
