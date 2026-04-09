use axum::Json;
use serde::Serialize;
use ts_rs::TS;
use utoipa::ToSchema;

/// Static system information that does not change at runtime.
#[derive(Debug, Clone, Serialize, TS, ToSchema)]
pub struct SystemInfo {
    /// The current user's home directory, if available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub home_dir: Option<String>,
}

/// Return static system information.
#[utoipa::path(
    get,
    path = "/api/system",
    responses(
        (status = 200, description = "System information", body = SystemInfo),
    ),
)]
pub async fn get_system_info() -> Json<SystemInfo> {
    let home_dir = dirs::home_dir().and_then(|p| p.to_str().map(String::from));
    Json(SystemInfo { home_dir })
}
