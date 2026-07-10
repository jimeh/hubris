use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utoipa::ToSchema;

use crate::chat::{ChatUiStyle, CopilotKitThemeMode};
pub use crate::domain::settings::*;
use crate::events::EventKind;
use crate::settings_manager::SettingsManagerError;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_scheme: Option<ColorScheme>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light_theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dark_theme: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_source: Option<TerminalFontSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_font_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundled_font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smart_tab_naming: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub escape_sequence_titles: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_keybindings_to_shell: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_scrollback_rows: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_scrollback_bytes: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditorSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light_editor_theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dark_editor_theme: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location_mode: Option<WorktreeLocationMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentalSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct VscodeSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<VscodeRuntimeKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_timeout_minutes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_style: Option<ChatUiStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copilotkit_theme_mode: Option<CopilotKitThemeMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
pub struct SettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<AppearanceSettingsPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<TerminalSettingsPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editor: Option<EditorSettingsPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeSettingsPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub experimental: Option<ExperimentalSettingsPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vscode: Option<VscodeSettingsPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat: Option<ChatSettingsPatch>,
}

fn map_settings_write_error(error: SettingsManagerError) -> StatusCode {
    match error {
        SettingsManagerError::WritesBlocked => StatusCode::CONFLICT,
        other => {
            tracing::error!("failed to save settings: {other}");
            StatusCode::INTERNAL_SERVER_ERROR
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
pub async fn get_settings(
    State(state): State<AppState>,
) -> Result<Json<SettingsState>, StatusCode> {
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
) -> Result<Json<SettingsState>, StatusCode> {
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
) -> Result<Json<SettingsState>, StatusCode> {
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
