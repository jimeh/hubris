use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    #[serde(default = "default_color_scheme")]
    pub color_scheme: String,
    #[serde(default = "default_light_theme")]
    pub light_theme: String,
    #[serde(default = "default_dark_theme")]
    pub dark_theme: String,
}

fn default_color_scheme() -> String {
    "auto".to_string()
}
fn default_light_theme() -> String {
    "catppuccin-latte".to_string()
}
fn default_dark_theme() -> String {
    "catppuccin-mocha".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    #[serde(default = "default_font_source")]
    pub font_source: String,
    #[serde(default)]
    pub system_font_family: String,
    #[serde(default)]
    pub bundled_font: String,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
}

fn default_font_source() -> String {
    "default".to_string()
}
fn default_font_size() -> u32 {
    14
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSettings {
    #[serde(default = "default_worktree_location_mode")]
    pub location_mode: String,
}

fn default_worktree_location_mode() -> String {
    "dataDir".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    #[serde(default)]
    pub appearance: Option<AppearanceSettings>,
    #[serde(default)]
    pub terminal: Option<TerminalSettings>,
    #[serde(default)]
    pub worktree: Option<WorktreeSettings>,
}

/// GET /api/settings
pub async fn get_settings(State(state): State<AppState>) -> Result<Json<Settings>, StatusCode> {
    let path = state.settings_file();
    match tokio::fs::read_to_string(&path).await {
        Ok(contents) => {
            let v: Settings = serde_json::from_str(&contents).unwrap_or_default();
            Ok(Json(v))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Json(Settings::default())),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// PUT /api/settings — full replace
pub async fn save_settings(
    State(state): State<AppState>,
    Json(value): Json<Settings>,
) -> Result<StatusCode, StatusCode> {
    let path = state.settings_file();
    let contents =
        serde_json::to_string_pretty(&value).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tokio::fs::write(&path, contents)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::OK)
}
