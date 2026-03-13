use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;
use utoipa::ToSchema;

use crate::events::EventKind;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, TS, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    "hubris-light".to_string()
}

fn default_dark_theme() -> String {
    "hubris-dark".to_string()
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            color_scheme: default_color_scheme(),
            light_theme: default_light_theme(),
            dark_theme: default_dark_theme(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, TS, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSettings {
    #[serde(default = "default_font_source")]
    pub font_source: String,
    #[serde(default)]
    pub system_font_family: String,
    #[serde(default = "default_bundled_font")]
    pub bundled_font: String,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
}

fn default_font_source() -> String {
    "default".to_string()
}

fn default_bundled_font() -> String {
    "jetbrainsmono-nf".to_string()
}

fn default_font_size() -> u32 {
    14
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            font_source: default_font_source(),
            system_font_family: String::new(),
            bundled_font: default_bundled_font(),
            font_size: default_font_size(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, TS, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeSettings {
    #[serde(default = "default_worktree_location_mode")]
    pub location_mode: String,
}

fn default_worktree_location_mode() -> String {
    "dataDir".to_string()
}

impl Default for WorktreeSettings {
    fn default() -> Self {
        Self {
            location_mode: default_worktree_location_mode(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, TS, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    #[serde(default)]
    pub appearance: AppearanceSettings,
    #[serde(default)]
    pub terminal: TerminalSettings,
    #[serde(default)]
    pub worktree: WorktreeSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppearanceSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_scheme: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light_theme: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dark_theme: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_source: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_font_family: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundled_font: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<Option<u32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location_mode: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<AppearanceSettingsPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<TerminalSettingsPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeSettingsPatch>,
}

fn strip_defaults(current: Value, defaults: &Value) -> Option<Value> {
    match (current, defaults) {
        (Value::Object(current), Value::Object(defaults)) => {
            let mut out = Map::new();

            for (key, value) in current {
                let default_value = defaults.get(&key).unwrap_or(&Value::Null);
                if let Some(diff) = strip_defaults(value, default_value) {
                    out.insert(key, diff);
                }
            }

            (!out.is_empty()).then_some(Value::Object(out))
        }
        (current, defaults) => (current != *defaults).then_some(current),
    }
}

fn merge_patch(target: &mut Value, patch: Value) {
    match patch {
        Value::Object(patch_obj) => {
            if !target.is_object() {
                *target = Value::Object(Map::new());
            }

            let target_obj = target
                .as_object_mut()
                .expect("target forced to object before merge");

            for (key, patch_value) in patch_obj {
                if patch_value.is_null() {
                    target_obj.remove(&key);
                    continue;
                }

                let entry = target_obj.entry(key).or_insert(Value::Null);
                merge_patch(entry, patch_value);
            }
        }
        patch => {
            *target = patch;
        }
    }
}

fn settings_to_storage_value(settings: &Settings) -> Result<Value, StatusCode> {
    let current = serde_json::to_value(settings).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let defaults =
        serde_json::to_value(Settings::default()).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(strip_defaults(current, &defaults).unwrap_or_else(|| Value::Object(Map::new())))
}

fn parse_settings(value: Value) -> Result<Settings, StatusCode> {
    serde_json::from_value(value).map_err(|_| StatusCode::BAD_REQUEST)
}

async fn read_settings_file(state: &AppState) -> Result<Value, StatusCode> {
    let path = state.settings_file();
    match tokio::fs::read_to_string(&path).await {
        Ok(contents) => {
            let raw = serde_json::from_str::<Value>(&contents)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            Ok(match raw {
                Value::Object(_) => raw,
                _ => return Err(StatusCode::INTERNAL_SERVER_ERROR),
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Object(Map::new())),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

pub async fn load_settings(state: &AppState) -> Result<Settings, StatusCode> {
    parse_settings(read_settings_file(state).await?)
}

async fn write_settings_file(
    state: &AppState,
    settings: &Settings,
) -> Result<Settings, StatusCode> {
    let path = state.settings_file();
    let contents = serde_json::to_string_pretty(&settings_to_storage_value(settings)?)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tokio::fs::write(&path, contents)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(settings.clone())
}

fn apply_settings_patch(current: &Settings, patch: Value) -> Result<Settings, StatusCode> {
    let mut merged =
        serde_json::to_value(current).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    merge_patch(&mut merged, patch);
    parse_settings(merged)
}

/// GET /api/settings
#[utoipa::path(
    get,
    path = "/api/settings",
    responses(
        (status = 200, description = "Current settings", body = Settings),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn get_settings(State(state): State<AppState>) -> Result<Json<Settings>, StatusCode> {
    Ok(Json(load_settings(&state).await?))
}

/// PUT /api/settings — full replace
#[utoipa::path(
    put,
    path = "/api/settings",
    request_body = Settings,
    responses(
        (status = 200, description = "Settings saved", body = Settings),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn save_settings(
    State(state): State<AppState>,
    Json(value): Json<Settings>,
) -> Result<Json<Settings>, StatusCode> {
    let settings = write_settings_file(&state, &value).await?;
    state
        .events
        .emit(EventKind::SettingsUpdated(settings.clone()));
    Ok(Json(settings))
}

/// PATCH /api/settings — merge partial update
#[utoipa::path(
    patch,
    path = "/api/settings",
    request_body = SettingsPatch,
    responses(
        (status = 200, description = "Settings saved", body = Settings),
        (status = 400, description = "Invalid settings patch"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn patch_settings(
    State(state): State<AppState>,
    Json(patch): Json<Value>,
) -> Result<Json<Settings>, StatusCode> {
    let current = load_settings(&state).await?;
    let merged = apply_settings_patch(&current, patch)?;
    let settings = write_settings_file(&state, &merged).await?;
    state
        .events
        .emit(EventKind::SettingsUpdated(settings.clone()));
    Ok(Json(settings))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_patch_deletes_nested_keys() {
        let current = Settings::default();
        let merged = apply_settings_patch(
            &Settings {
                appearance: AppearanceSettings {
                    color_scheme: "dark".into(),
                    ..current.appearance.clone()
                },
                ..current
            },
            serde_json::to_value(SettingsPatch {
                appearance: Some(AppearanceSettingsPatch {
                    color_scheme: Some(None),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .unwrap(),
        )
        .unwrap();

        assert_eq!(merged.appearance.color_scheme, "auto");
    }

    #[test]
    fn storage_value_omits_default_fields() {
        let value = settings_to_storage_value(&Settings::default()).unwrap();
        assert_eq!(value, Value::Object(Map::new()));
    }
}
