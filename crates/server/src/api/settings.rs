use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utoipa::ToSchema;

use crate::events::EventKind;
use crate::settings_manager::SettingsManagerError;
use crate::state::AppState;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "lowercase")]
pub enum ColorScheme {
    #[default]
    Auto,
    Light,
    Dark,
}

impl ColorScheme {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "lowercase")]
pub enum TerminalFontSource {
    #[default]
    Default,
    System,
    Bundled,
}

impl TerminalFontSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::System => "system",
            Self::Bundled => "bundled",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
pub enum WorktreeLocationMode {
    #[default]
    #[serde(rename = "dataDir")]
    DataDir,
    #[serde(rename = "repoLocalDotHubris")]
    RepoLocalDotHubris,
}

impl WorktreeLocationMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DataDir => "dataDir",
            Self::RepoLocalDotHubris => "repoLocalDotHubris",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    #[serde(default)]
    pub color_scheme: ColorScheme,
    #[serde(default = "default_light_theme")]
    pub light_theme: String,
    #[serde(default = "default_dark_theme")]
    pub dark_theme: String,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            color_scheme: ColorScheme::Auto,
            light_theme: default_light_theme(),
            dark_theme: default_dark_theme(),
        }
    }
}

fn default_light_theme() -> String {
    "hubris-light".to_string()
}

fn default_dark_theme() -> String {
    "hubris-dark".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    #[serde(default)]
    pub font_source: TerminalFontSource,
    #[serde(default)]
    pub system_font_family: String,
    #[serde(default = "default_bundled_font")]
    pub bundled_font: String,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            font_source: TerminalFontSource::Default,
            system_font_family: String::new(),
            bundled_font: default_bundled_font(),
            font_size: default_font_size(),
        }
    }
}

fn default_bundled_font() -> String {
    "jetbrainsmono-nf".to_string()
}

fn default_font_size() -> u32 {
    14
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSettings {
    #[serde(default)]
    pub location_mode: WorktreeLocationMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
pub struct Settings {
    #[serde(default)]
    pub appearance: AppearanceSettings,
    #[serde(default)]
    pub terminal: TerminalSettings,
    #[serde(default)]
    pub worktree: WorktreeSettings,
}

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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location_mode: Option<WorktreeLocationMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
pub struct SettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<AppearanceSettingsPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<TerminalSettingsPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeSettingsPatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
pub struct SettingsState {
    pub settings: Settings,
    pub generation: String,
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
