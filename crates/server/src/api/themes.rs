use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ThemeMeta {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub theme_type: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ThemeFile {
    #[serde(flatten)]
    pub meta: ThemeMeta,
    pub colors: serde_json::Map<String, serde_json::Value>,
}

/// GET /api/themes — list user theme metadata
#[utoipa::path(
    get,
    path = "/api/themes",
    responses(
        (status = 200, description = "Theme metadata list", body = [ThemeMeta]),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn list_themes(
    State(state): State<AppState>,
) -> Result<Json<Vec<ThemeMeta>>, StatusCode> {
    let dir = state.themes_dir();
    let mut themes = Vec::new();

    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Json(themes));
        }
        Err(_) => {
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };

    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json")
            && let Ok(contents) = tokio::fs::read_to_string(&path).await
            && let Ok(theme) = serde_json::from_str::<ThemeFile>(&contents)
        {
            themes.push(theme.meta);
        }
    }

    Ok(Json(themes))
}

/// GET /api/themes/:id — get full theme
#[utoipa::path(
    get,
    path = "/api/themes/{id}",
    params(
        ("id" = String, Path, description = "Theme ID"),
    ),
    responses(
        (status = 200, description = "Theme payload", body = ThemeFile),
        (status = 404, description = "Theme not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn get_theme(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ThemeFile>, StatusCode> {
    let path = state.themes_dir().join(format!("{id}.json"));
    let contents = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        })?;
    let theme: ThemeFile =
        serde_json::from_str(&contents).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(theme))
}

/// POST /api/themes — upload a new theme
#[utoipa::path(
    post,
    path = "/api/themes",
    request_body = ThemeFile,
    responses(
        (status = 201, description = "Theme created", body = ThemeMeta),
        (status = 409, description = "Theme already exists"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn create_theme(
    State(state): State<AppState>,
    Json(theme): Json<ThemeFile>,
) -> Result<(StatusCode, Json<ThemeMeta>), StatusCode> {
    let dir = state.themes_dir();
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let path = dir.join(format!("{}.json", theme.meta.id));
    let contents =
        serde_json::to_string_pretty(&theme).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Atomic create — fails if file already exists
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => StatusCode::CONFLICT,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        })?;

    file.write_all(contents.as_bytes())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok((StatusCode::CREATED, Json(theme.meta)))
}

/// DELETE /api/themes/:id — remove a user theme
#[utoipa::path(
    delete,
    path = "/api/themes/{id}",
    params(
        ("id" = String, Path, description = "Theme ID"),
    ),
    responses(
        (status = 204, description = "Theme removed"),
        (status = 404, description = "Theme not found"),
        (status = 500, description = "Internal server error"),
    ),
)]
pub async fn delete_theme(State(state): State<AppState>, Path(id): Path<String>) -> StatusCode {
    let path = state.themes_dir().join(format!("{id}.json"));
    match tokio::fs::remove_file(&path).await {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
