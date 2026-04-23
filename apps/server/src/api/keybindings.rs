use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use utoipa::ToSchema;

use crate::events::EventKind;
use crate::keybindings_manager::KeybindingsManagerError;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingEntry {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct Keybindings {
    #[serde(default)]
    pub keybindings: Vec<KeybindingEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, ToSchema)]
pub struct KeybindingsState {
    pub keybindings: Vec<KeybindingEntry>,
    pub generation: String,
    pub status: KeybindingsStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub enum KeybindingsStatusKind {
    #[default]
    Ok,
    InvalidFile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingsStatus {
    pub kind: KeybindingsStatusKind,
    pub writes_blocked: bool,
    #[serde(default)]
    pub message: Option<String>,
}

impl Default for KeybindingsStatus {
    fn default() -> Self {
        Self::ok()
    }
}

impl KeybindingsStatus {
    pub fn ok() -> Self {
        Self {
            kind: KeybindingsStatusKind::Ok,
            writes_blocked: false,
            message: None,
        }
    }

    pub fn invalid_file(message: impl Into<String>) -> Self {
        Self {
            kind: KeybindingsStatusKind::InvalidFile,
            writes_blocked: true,
            message: Some(message.into()),
        }
    }
}

fn map_keybindings_write_error(error: KeybindingsManagerError) -> StatusCode {
    match error {
        KeybindingsManagerError::WritesBlocked => StatusCode::CONFLICT,
        other => {
            tracing::error!("failed to save keybindings: {other}");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

/// GET /api/keybindings
#[utoipa::path(
    get,
    path = "/api/keybindings",
    responses(
        (status = 200, description = "Current keybindings", body = KeybindingsState),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn get_keybindings(
    State(state): State<AppState>,
) -> Result<Json<KeybindingsState>, StatusCode> {
    Ok(Json(state.keybindings.get().await))
}

/// PUT /api/keybindings
#[utoipa::path(
    put,
    path = "/api/keybindings",
    request_body = Vec<KeybindingEntry>,
    responses(
        (status = 200, description = "Keybindings saved", body = KeybindingsState),
        (status = 409, description = "Keybindings file is invalid on disk"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn put_keybindings(
    State(state): State<AppState>,
    Json(value): Json<Vec<KeybindingEntry>>,
) -> Result<Json<KeybindingsState>, StatusCode> {
    let keybindings = state
        .keybindings
        .replace(value)
        .await
        .map_err(map_keybindings_write_error)?;
    state
        .events
        .emit(EventKind::KeybindingsUpdated(keybindings.clone()));
    Ok(Json(keybindings))
}
