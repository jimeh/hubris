use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::state::AppState;

// ── Built-in theme data ──────────────────────────────────────────────

const BUILTIN_DARK: &str = include_str!("../../data/editor-themes/hubris-dark.json");
const BUILTIN_LIGHT: &str = include_str!("../../data/editor-themes/hubris-light.json");

fn builtin_themes() -> &'static [(&'static str, &'static str)] {
    &[
        ("hubris-dark", BUILTIN_DARK),
        ("hubris-light", BUILTIN_LIGHT),
    ]
}

fn is_builtin(id: &str) -> bool {
    builtin_themes().iter().any(|(bid, _)| *bid == id)
}

fn builtin_json(id: &str) -> Option<&'static str> {
    builtin_themes()
        .iter()
        .find(|(bid, _)| *bid == id)
        .map(|(_, json)| *json)
}

// ── Types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VscodeTokenColorSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "fontStyle")]
    pub font_style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VscodeTokenColor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<VscodeTokenScope>,
    pub settings: VscodeTokenColorSettings,
}

/// A scope can be a single string or an array of strings.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(untagged)]
pub enum VscodeTokenScope {
    One(String),
    Many(Vec<String>),
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VscodeThemeJson {
    pub name: String,
    #[serde(
        default = "default_theme_type",
        rename = "type",
        skip_serializing_if = "Option::is_none"
    )]
    pub theme_type: Option<String>,
    #[serde(default)]
    pub colors: HashMap<String, String>,
    #[serde(default, rename = "tokenColors")]
    pub token_colors: Vec<VscodeTokenColor>,
}

fn default_theme_type() -> Option<String> {
    Some("dark".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EditorThemeEntry {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub theme_type: String,
    pub builtin: bool,
}

// ── Helpers ──────────────────────────────────────────────────────────

fn editor_themes_dir(state: &AppState) -> std::path::PathBuf {
    state.data_dir.join("editor-themes")
}

fn slugify(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn entry_from_json(id: &str, theme: &VscodeThemeJson, builtin: bool) -> EditorThemeEntry {
    EditorThemeEntry {
        id: id.to_string(),
        name: theme.name.clone(),
        theme_type: theme
            .theme_type
            .clone()
            .unwrap_or_else(|| "dark".to_string()),
        builtin,
    }
}

async fn read_custom_entries(state: &AppState) -> Vec<EditorThemeEntry> {
    let dir = editor_themes_dir(state);
    let mut entries = Vec::new();
    let Ok(mut read_dir) = tokio::fs::read_dir(&dir).await else {
        return entries;
    };
    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
            continue;
        };
        if is_builtin(&stem) {
            continue;
        }
        let Ok(contents) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        let Ok(theme) = serde_json::from_str::<VscodeThemeJson>(&contents) else {
            continue;
        };
        entries.push(entry_from_json(&stem, &theme, false));
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}

// ── Endpoints ────────────────────────────────────────────────────────

/// GET /api/editor-themes — list all available editor themes.
#[utoipa::path(
    get,
    path = "/api/editor-themes",
    responses(
        (status = 200, description = "Editor theme list",
         body = Vec<EditorThemeEntry>),
    ),
)]
pub async fn list_editor_themes(State(state): State<AppState>) -> Json<Vec<EditorThemeEntry>> {
    let mut all = Vec::new();

    // Built-in themes first.
    for (id, json_str) in builtin_themes() {
        if let Ok(theme) = serde_json::from_str::<VscodeThemeJson>(json_str) {
            all.push(entry_from_json(id, &theme, true));
        }
    }

    // Custom themes from disk.
    all.extend(read_custom_entries(&state).await);

    Json(all)
}

/// GET /api/editor-themes/{id} — full theme data.
#[utoipa::path(
    get,
    path = "/api/editor-themes/{id}",
    params(("id" = String, Path, description = "Theme ID")),
    responses(
        (status = 200, description = "Theme data",
         body = VscodeThemeJson),
        (status = 404, description = "Theme not found"),
    ),
)]
pub async fn get_editor_theme(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<VscodeThemeJson>, StatusCode> {
    // Check built-in first.
    if let Some(json_str) = builtin_json(&id) {
        let theme: VscodeThemeJson = serde_json::from_str(json_str).map_err(|e| {
            tracing::error!("built-in theme parse error: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
        return Ok(Json(theme));
    }

    // Check custom on disk.
    let path = editor_themes_dir(&state).join(format!("{id}.json"));
    let contents = tokio::fs::read_to_string(&path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let theme: VscodeThemeJson =
        serde_json::from_str(&contents).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(theme))
}

/// POST /api/editor-themes — upload a custom VS Code theme.
#[utoipa::path(
    post,
    path = "/api/editor-themes",
    request_body = VscodeThemeJson,
    responses(
        (status = 201, description = "Theme created",
         body = EditorThemeEntry),
        (status = 400, description = "Invalid theme JSON"),
    ),
)]
pub async fn upload_editor_theme(
    State(state): State<AppState>,
    Json(theme): Json<VscodeThemeJson>,
) -> Result<(StatusCode, Json<EditorThemeEntry>), StatusCode> {
    if theme.token_colors.is_empty() && theme.colors.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let base_slug = slugify(&theme.name);
    if base_slug.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let dir = editor_themes_dir(&state);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| {
        tracing::error!("create editor-themes dir: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    // Find a unique slug (avoid collisions with built-in and existing).
    let mut slug = base_slug.clone();
    let mut counter = 1u32;
    loop {
        if is_builtin(&slug) {
            slug = format!("{base_slug}-{counter}");
            counter += 1;
            continue;
        }
        let path = dir.join(format!("{slug}.json"));
        if !path.exists() {
            break;
        }
        slug = format!("{base_slug}-{counter}");
        counter += 1;
    }

    let path = dir.join(format!("{slug}.json"));
    let json_bytes =
        serde_json::to_string_pretty(&theme).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tokio::fs::write(&path, json_bytes.as_bytes())
        .await
        .map_err(|e| {
            tracing::error!("write editor theme: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    let entry = entry_from_json(&slug, &theme, false);
    Ok((StatusCode::CREATED, Json(entry)))
}

/// DELETE /api/editor-themes/{id} — delete a custom theme.
#[utoipa::path(
    delete,
    path = "/api/editor-themes/{id}",
    params(("id" = String, Path, description = "Theme ID")),
    responses(
        (status = 204, description = "Theme deleted"),
        (status = 403, description = "Cannot delete built-in theme"),
        (status = 404, description = "Theme not found"),
    ),
)]
pub async fn delete_editor_theme(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    if is_builtin(&id) {
        return Err(StatusCode::FORBIDDEN);
    }

    let path = editor_themes_dir(&state).join(format!("{id}.json"));
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(StatusCode::NOT_FOUND),
        Err(e) => {
            tracing::error!("delete editor theme: {e}");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}
