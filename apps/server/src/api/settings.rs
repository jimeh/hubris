use axum::Json;
use axum::extract::State;

pub use crate::domain::settings::*;
use crate::error::ApiError;
use crate::events::EventKind;
use crate::settings_manager::SettingsManagerError;
use crate::state::AppState;

fn map_settings_write_error(error: SettingsManagerError) -> ApiError {
    match error {
        SettingsManagerError::WritesBlocked => ApiError::conflict("settings writes are blocked"),
        other => {
            tracing::error!("failed to save settings: {other}");
            ApiError::internal("Internal server error.")
        }
    }
}

/// GET /api/settings
#[utoipa::path(
    get,
    path = "/api/settings",
    responses(
        (status = 200, description = "Current settings", body = SettingsState),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn get_settings(State(state): State<AppState>) -> Result<Json<SettingsState>, ApiError> {
    Ok(Json(state.settings.get().await))
}

/// PUT /api/settings — full replace
#[utoipa::path(
    put,
    path = "/api/settings",
    request_body = Settings,
    responses(
        (status = 200, description = "Settings saved", body = SettingsState),
        (status = 409, description = "Settings file is invalid on disk"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn put_settings(
    State(state): State<AppState>,
    Json(value): Json<Settings>,
) -> Result<Json<SettingsState>, ApiError> {
    let settings = state
        .settings
        .replace(value)
        .await
        .map_err(map_settings_write_error)?;
    state
        .events
        .emit(EventKind::SettingsUpdated(settings.clone()));
    Ok(Json(settings))
}

/// PATCH /api/settings — partial update
#[utoipa::path(
    patch,
    path = "/api/settings",
    request_body = SettingsPatch,
    responses(
        (status = 200, description = "Settings patched", body = SettingsState),
        (status = 409, description = "Settings file is invalid on disk"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn patch_settings(
    State(state): State<AppState>,
    Json(value): Json<SettingsPatch>,
) -> Result<Json<SettingsState>, ApiError> {
    let settings = state
        .settings
        .patch(value)
        .await
        .map_err(map_settings_write_error)?;
    state
        .events
        .emit(EventKind::SettingsUpdated(settings.clone()));
    Ok(Json(settings))
}
