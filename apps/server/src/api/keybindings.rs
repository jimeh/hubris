pub use crate::domain::keybindings::*;
use crate::events::EventKind;
use crate::keybindings_manager::KeybindingsManagerError;
use crate::state::AppState;
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;

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
