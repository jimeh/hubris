use std::collections::HashMap;
use std::path::{Path as StdPath, PathBuf};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::state::AppState;

// ── Built-in theme data ──────────────────────────────────────────────

// Hubris themes
const HUBRIS_DARK: &str = include_str!("../../data/editor-themes/hubris-dark.json");
const HUBRIS_LIGHT: &str = include_str!("../../data/editor-themes/hubris-light.json");

// VS Code built-in themes
const VSCODE_ABYSS: &str = include_str!("../../data/editor-themes/vscode/abyss.json");
const VSCODE_DARK: &str = include_str!("../../data/editor-themes/vscode/dark.json");
const VSCODE_DARK_MODERN: &str = include_str!("../../data/editor-themes/vscode/dark-modern.json");
const VSCODE_DEFAULT_HC: &str =
    include_str!("../../data/editor-themes/vscode/default-high-contrast.json");
const VSCODE_DEFAULT_HC_LIGHT: &str =
    include_str!("../../data/editor-themes/vscode/default-high-contrast-light.json");
const VSCODE_KIMBIE_DARK: &str = include_str!("../../data/editor-themes/vscode/kimbie-dark.json");
const VSCODE_LIGHT: &str = include_str!("../../data/editor-themes/vscode/light.json");
const VSCODE_LIGHT_MODERN: &str = include_str!("../../data/editor-themes/vscode/light-modern.json");
const VSCODE_MONOKAI: &str = include_str!("../../data/editor-themes/vscode/monokai.json");
const VSCODE_MONOKAI_DIMMED: &str =
    include_str!("../../data/editor-themes/vscode/monokai-dimmed.json");
const VSCODE_QUIET_LIGHT: &str = include_str!("../../data/editor-themes/vscode/quiet-light.json");
const VSCODE_RED: &str = include_str!("../../data/editor-themes/vscode/red.json");
const VSCODE_SOLARIZED_DARK: &str =
    include_str!("../../data/editor-themes/vscode/solarized-dark.json");
const VSCODE_SOLARIZED_LIGHT: &str =
    include_str!("../../data/editor-themes/vscode/solarized-light.json");
const VSCODE_TOMORROW_NIGHT_BLUE: &str =
    include_str!("../../data/editor-themes/vscode/tomorrow-night-blue.json");
const VSCODE_VS_DARK: &str =
    include_str!("../../data/editor-themes/vscode/visual-studio-dark.json");
const VSCODE_VS_LIGHT: &str =
    include_str!("../../data/editor-themes/vscode/visual-studio-light.json");
const VSCODE_2026_DARK: &str = include_str!("../../data/editor-themes/vscode/vs-code-dark.json");
const VSCODE_2026_LIGHT: &str = include_str!("../../data/editor-themes/vscode/vs-code-light.json");

fn builtin_themes() -> &'static [(&'static str, &'static str)] {
    &[
        // Hubris
        ("hubris-dark", HUBRIS_DARK),
        ("hubris-light", HUBRIS_LIGHT),
        // VS Code defaults
        ("dark-modern", VSCODE_DARK_MODERN),
        ("dark-plus", VSCODE_DARK),
        ("light-modern", VSCODE_LIGHT_MODERN),
        ("light-plus", VSCODE_LIGHT),
        ("visual-studio-dark", VSCODE_VS_DARK),
        ("visual-studio-light", VSCODE_VS_LIGHT),
        ("vs-code-dark", VSCODE_2026_DARK),
        ("vs-code-light", VSCODE_2026_LIGHT),
        ("high-contrast", VSCODE_DEFAULT_HC),
        ("high-contrast-light", VSCODE_DEFAULT_HC_LIGHT),
        // VS Code community
        ("abyss", VSCODE_ABYSS),
        ("kimbie-dark", VSCODE_KIMBIE_DARK),
        ("monokai", VSCODE_MONOKAI),
        ("monokai-dimmed", VSCODE_MONOKAI_DIMMED),
        ("quiet-light", VSCODE_QUIET_LIGHT),
        ("red", VSCODE_RED),
        ("solarized-dark", VSCODE_SOLARIZED_DARK),
        ("solarized-light", VSCODE_SOLARIZED_LIGHT),
        ("tomorrow-night-blue", VSCODE_TOMORROW_NIGHT_BLUE),
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
    #[serde(default)]
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

// ── Discovery types ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredTheme {
    pub label: String,
    #[serde(rename = "type")]
    pub theme_type: String,
    pub installed_id: Option<String>,
    pub differs: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredExtension {
    pub extension_id: String,
    pub display_name: String,
    pub version: String,
    pub source_editor: String,
    pub themes: Vec<DiscoveredTheme>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportThemeRequest {
    pub extension_id: String,
    pub theme_index: usize,
    pub source_editor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overwrite_id: Option<String>,
}

// Internal types for parsing extension package.json.

#[derive(Debug, Deserialize)]
struct ExtensionPackageJson {
    #[serde(default)]
    name: String,
    #[serde(default)]
    publisher: String,
    #[serde(default, rename = "displayName")]
    display_name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    contributes: ExtensionContributes,
}

#[derive(Debug, Default, Deserialize)]
struct ExtensionContributes {
    #[serde(default)]
    themes: Vec<ExtensionThemeContribution>,
}

#[derive(Debug, Deserialize)]
struct ExtensionThemeContribution {
    #[serde(default)]
    label: String,
    #[serde(default, rename = "uiTheme")]
    ui_theme: String,
    #[serde(default)]
    path: String,
}

// ── JSONC support ───────────────────────────────────────────────────

/// Default JSONC parse options: comments, trailing commas, etc.
fn jsonc_options() -> jsonc_parser::ParseOptions {
    Default::default()
}

/// Parse a JSONC string into any deserializable type.
fn parse_jsonc<T: serde::de::DeserializeOwned>(
    contents: &str,
) -> Result<T, jsonc_parser::errors::ParseError> {
    jsonc_parser::parse_to_serde_value(contents, &jsonc_options())
}

/// Parse a VS Code theme JSON file that may contain JSONC comments.
fn parse_theme_jsonc(contents: &str) -> Result<VscodeThemeJson, jsonc_parser::errors::ParseError> {
    parse_jsonc(contents)
}

/// Parse a VS Code theme file into a generic JSON Value (JSONC-aware).
fn parse_jsonc_value(
    contents: &str,
) -> Result<serde_json::Value, jsonc_parser::errors::ParseError> {
    parse_jsonc(contents)
}

// ── Helpers ──────────────────────────────────────────────────────────

fn editor_themes_dir(state: &AppState) -> std::path::PathBuf {
    state.data_dir.join("editor-themes")
}

/// Reject IDs containing path separators or traversal components.
fn validate_theme_id(id: &str) -> Result<(), StatusCode> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") || id == "." {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(())
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
        let Ok(theme) = parse_theme_jsonc(&contents) else {
            continue;
        };
        entries.push(entry_from_json(&stem, &theme, false));
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}

// ── Extension discovery helpers ──────────────────────────────────────

fn known_editors() -> &'static [(&'static str, &'static str)] {
    &[
        ("VS Code", ".vscode"),
        ("VS Code Insiders", ".vscode-insiders"),
        ("VSCodium", ".vscode-oss"),
        ("Cursor", ".cursor"),
        ("Windsurf", ".windsurf"),
    ]
}

fn ui_theme_to_type(ui_theme: &str) -> &'static str {
    match ui_theme {
        "vs" | "hc-light" => "light",
        _ => "dark",
    }
}

/// Parse a version string like "3.17.2" into a comparable tuple.
fn parse_version(v: &str) -> (u64, u64, u64) {
    let mut parts = v.split('.');
    let major = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let patch = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (major, minor, patch)
}

struct ScannedExtension {
    extension_id: String,
    pkg: ExtensionPackageJson,
    root: PathBuf,
    editor_name: String,
}

async fn scan_editor_extensions(
    home: &StdPath,
    editor_name: &str,
    dot_dir: &str,
) -> Vec<ScannedExtension> {
    let ext_dir = home.join(dot_dir).join("extensions");
    let mut results = Vec::new();
    let Ok(mut read_dir) = tokio::fs::read_dir(&ext_dir).await else {
        return results;
    };
    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        let path = entry.path();
        let pkg_path = path.join("package.json");
        let Ok(contents) = tokio::fs::read_to_string(&pkg_path).await else {
            continue;
        };
        let Ok(pkg) = serde_json::from_str::<ExtensionPackageJson>(&contents) else {
            continue;
        };
        if pkg.contributes.themes.is_empty() || pkg.publisher.is_empty() {
            continue;
        }
        let extension_id = format!("{}.{}", pkg.publisher, pkg.name);
        results.push(ScannedExtension {
            extension_id,
            pkg,
            root: path,
            editor_name: editor_name.to_string(),
        });
    }
    results
}

/// Deduplicate extensions by extension_id, keeping the highest version.
fn dedup_extensions(all: Vec<ScannedExtension>) -> Vec<ScannedExtension> {
    let mut best: HashMap<String, ScannedExtension> = HashMap::new();
    for ext in all {
        let key = ext.extension_id.clone();
        if let Some(existing) = best.get(&key) {
            let existing_ver = parse_version(&existing.pkg.version);
            let new_ver = parse_version(&ext.pkg.version);
            if new_ver > existing_ver {
                best.insert(key, ext);
            }
        } else {
            best.insert(key, ext);
        }
    }
    let mut result: Vec<_> = best.into_values().collect();
    result.sort_by(|a, b| a.extension_id.cmp(&b.extension_id));
    result
}

/// Read installed custom themes as parsed JSON values keyed by slug.
async fn read_installed_themes(state: &AppState) -> HashMap<String, serde_json::Value> {
    let dir = editor_themes_dir(state);
    let mut map = HashMap::new();
    let Ok(mut read_dir) = tokio::fs::read_dir(&dir).await else {
        return map;
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
        let Ok(value) = parse_jsonc_value(&contents) else {
            continue;
        };
        map.insert(stem, value);
    }
    map
}

/// Find an extension in a specific editor's extensions directory.
///
/// When multiple versions of the same extension are installed (common
/// during editor updates), returns the highest semver to stay
/// consistent with `dedup_extensions` in the discovery flow.
async fn find_extension_in_editor(
    home: &StdPath,
    dot_dir: &str,
    extension_id: &str,
) -> Option<(ExtensionPackageJson, PathBuf)> {
    let ext_dir = home.join(dot_dir).join("extensions");
    let Ok(mut read_dir) = tokio::fs::read_dir(&ext_dir).await else {
        return None;
    };
    let mut best: Option<(ExtensionPackageJson, PathBuf)> = None;
    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        let path = entry.path();
        let pkg_path = path.join("package.json");
        let Ok(contents) = tokio::fs::read_to_string(&pkg_path).await else {
            continue;
        };
        let Ok(pkg) = serde_json::from_str::<ExtensionPackageJson>(&contents) else {
            continue;
        };
        if pkg.publisher.is_empty() {
            continue;
        }
        let id = format!("{}.{}", pkg.publisher, pkg.name);
        if id == extension_id {
            let dominated = best
                .as_ref()
                .is_some_and(|(b, _)| parse_version(&b.version) >= parse_version(&pkg.version));
            if !dominated {
                best = Some((pkg, path));
            }
        }
    }
    best
}

// ── Shared write logic ──────────────────────────────────────────────

/// Slugs that would shadow static API routes.
fn is_reserved_slug(slug: &str) -> bool {
    matches!(slug, "discover" | "import")
}

async fn resolve_slug(dir: &StdPath, name: &str) -> Result<String, StatusCode> {
    let base_slug = slugify(name);
    if base_slug.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut slug = base_slug.clone();
    let mut counter = 1u32;
    loop {
        if is_builtin(&slug) || is_reserved_slug(&slug) {
            slug = format!("{base_slug}-{counter}");
            counter += 1;
            continue;
        }
        let path = dir.join(format!("{slug}.json"));
        if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
            break;
        }
        slug = format!("{base_slug}-{counter}");
        counter += 1;
    }
    Ok(slug)
}

async fn ensure_themes_dir(state: &AppState) -> Result<std::path::PathBuf, StatusCode> {
    let dir = editor_themes_dir(state);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| {
        tracing::error!("create editor-themes dir: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    Ok(dir)
}

/// Write theme JSON to disk, preserving unknown fields from the
/// source but patching `name` and `type` to match the resolved values.
async fn write_raw_theme_to_disk(
    state: &AppState,
    raw_json: &str,
    theme: &VscodeThemeJson,
    overwrite_id: Option<&str>,
) -> Result<EditorThemeEntry, StatusCode> {
    let dir = ensure_themes_dir(state).await?;
    let slug = match overwrite_id {
        Some(id) => {
            validate_theme_id(id)?;
            if is_builtin(id) || is_reserved_slug(id) {
                tracing::warn!(
                    overwrite_id = %id,
                    "write theme: overwrite_id is builtin or reserved"
                );
                return Err(StatusCode::BAD_REQUEST);
            }
            id.to_string()
        }
        None => resolve_slug(&dir, &theme.name).await?,
    };

    // Patch name/type in the parsed Value so they match the resolved
    // values while preserving all other fields and ordering.
    let mut value: serde_json::Value = serde_json::from_str(raw_json).map_err(|e| {
        tracing::error!(error = %e, "write theme: re-parse raw JSON");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "name".to_string(),
            serde_json::Value::String(theme.name.clone()),
        );
        if let Some(ref t) = theme.theme_type {
            obj.insert("type".to_string(), serde_json::Value::String(t.clone()));
        }
    }

    let path = dir.join(format!("{slug}.json"));
    let patched = serde_json::to_string_pretty(&value).map_err(|e| {
        tracing::error!(error = %e, "write theme: serialize patched JSON");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    tokio::fs::write(&path, patched.as_bytes())
        .await
        .map_err(|e| {
            tracing::error!("write editor theme: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    Ok(entry_from_json(&slug, theme, false))
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
) -> Result<Json<serde_json::Value>, StatusCode> {
    validate_theme_id(&id)?;

    // Check built-in first.
    if let Some(json_str) = builtin_json(&id) {
        let value: serde_json::Value = serde_json::from_str(json_str).map_err(|e| {
            tracing::error!("built-in theme parse error: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
        return Ok(Json(value));
    }

    // Custom themes: parse as generic Value to preserve all fields
    // (semanticHighlighting, semanticTokenColors, etc.) that
    // VscodeThemeJson would drop.
    let path = editor_themes_dir(&state).join(format!("{id}.json"));
    let contents = tokio::fs::read_to_string(&path).await.map_err(|e| {
        tracing::warn!(id = %id, error = %e, "get theme: file not found");
        StatusCode::NOT_FOUND
    })?;
    let value: serde_json::Value = parse_jsonc_value(&contents).map_err(|e| {
        tracing::error!(id = %id, error = %e, "get theme: parse error");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    Ok(Json(value))
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
    body: String,
) -> Result<(StatusCode, Json<EditorThemeEntry>), StatusCode> {
    // Parse through VscodeThemeJson for validation, but write the
    // raw JSON to preserve unknown fields like semanticHighlighting,
    // semanticTokenColors, and $schema.
    let value: serde_json::Value = parse_jsonc_value(&body).map_err(|e| {
        tracing::warn!(error = %e, "upload: failed to parse theme JSONC");
        StatusCode::BAD_REQUEST
    })?;
    let theme: VscodeThemeJson = serde_json::from_value(value.clone()).map_err(|e| {
        tracing::warn!(error = %e, "upload: failed to parse theme JSON");
        StatusCode::BAD_REQUEST
    })?;
    if theme.token_colors.is_empty() && theme.colors.is_empty() {
        tracing::warn!("upload: theme has no tokenColors and no colors");
        return Err(StatusCode::BAD_REQUEST);
    }
    let clean = serde_json::to_string(&value).map_err(|e| {
        tracing::error!(error = %e, "upload: serialize theme value");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let entry = write_raw_theme_to_disk(&state, &clean, &theme, None).await?;
    Ok((StatusCode::CREATED, Json(entry)))
}

/// GET /api/editor-themes/discover — scan local editors for theme extensions.
#[utoipa::path(
    get,
    path = "/api/editor-themes/discover",
    responses(
        (status = 200, description = "Discovered extension themes",
         body = Vec<DiscoveredExtension>),
    ),
)]
pub async fn discover_editor_themes(
    State(state): State<AppState>,
) -> Json<Vec<DiscoveredExtension>> {
    let Some(home) = dirs::home_dir() else {
        return Json(vec![]);
    };

    // Scan all known editors.
    let mut all_scanned = Vec::new();
    for (editor_name, dot_dir) in known_editors() {
        all_scanned.extend(scan_editor_extensions(&home, editor_name, dot_dir).await);
    }

    // Deduplicate by extension_id, keeping highest version.
    let winners = dedup_extensions(all_scanned);

    // Read installed custom themes for comparison.
    let installed = read_installed_themes(&state).await;

    // Build response.
    let mut result = Vec::new();
    for ext in winners {
        let display_name = if ext.pkg.display_name.is_empty() {
            ext.pkg.name.clone()
        } else {
            ext.pkg.display_name.clone()
        };

        let mut themes = Vec::new();
        for contrib in &ext.pkg.contributes.themes {
            if contrib.path.is_empty() {
                continue;
            }
            let theme_type = ui_theme_to_type(&contrib.ui_theme).to_string();
            let label = if contrib.label.is_empty() {
                display_name.clone()
            } else {
                contrib.label.clone()
            };

            // Check if this theme is already installed. Look up the
            // base slug first, then fall back to collision-suffixed
            // variants (`{slug}-1`, `{slug}-2`, ...) that resolve_slug
            // may have generated during import.
            let candidate_slug = slugify(&label);
            let matched_entry = installed.get_key_value(&candidate_slug).or_else(|| {
                installed.iter().find(|(k, _)| {
                    k.strip_prefix(&candidate_slug)
                        .and_then(|rest| rest.strip_prefix('-'))
                        .is_some_and(|n| n.parse::<u32>().is_ok())
                })
            });
            let (installed_id, differs) =
                if let Some((matched_slug, installed_value)) = matched_entry {
                    // Read the source theme file and compare via parsed JSON
                    // values. Patch name/type in the source to match what the
                    // import would write, so name corrections don't cause
                    // false diffs.
                    let theme_path = ext.root.join(&contrib.path);
                    let source_matches = match tokio::fs::read_to_string(&theme_path).await {
                        Ok(source_contents) => match parse_jsonc_value(&source_contents) {
                            Ok(mut source_value) => {
                                if let Some(obj) = source_value.as_object_mut() {
                                    obj.insert(
                                        "name".to_string(),
                                        serde_json::Value::String(label.clone()),
                                    );
                                    obj.insert(
                                        "type".to_string(),
                                        serde_json::Value::String(theme_type.clone()),
                                    );
                                }
                                &source_value == installed_value
                            }
                            Err(_) => false,
                        },
                        Err(_) => false,
                    };
                    (Some(matched_slug.clone()), !source_matches)
                } else {
                    (None, false)
                };

            themes.push(DiscoveredTheme {
                label,
                theme_type,
                installed_id,
                differs,
            });
        }

        if themes.is_empty() {
            continue;
        }

        result.push(DiscoveredExtension {
            extension_id: ext.extension_id,
            display_name,
            version: ext.pkg.version.clone(),
            source_editor: ext.editor_name,
            themes,
        });
    }

    Json(result)
}

/// POST /api/editor-themes/import — import a theme from an extension.
#[utoipa::path(
    post,
    path = "/api/editor-themes/import",
    request_body = ImportThemeRequest,
    responses(
        (status = 201, description = "Theme imported",
         body = EditorThemeEntry),
        (status = 400, description = "Invalid request"),
        (status = 404, description = "Extension or theme not found"),
    ),
)]
pub async fn import_extension_theme(
    State(state): State<AppState>,
    Json(req): Json<ImportThemeRequest>,
) -> Result<(StatusCode, Json<EditorThemeEntry>), StatusCode> {
    let Some(home) = dirs::home_dir() else {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    };

    // Find the editor's dot_dir from the source_editor name.
    let dot_dir = known_editors()
        .iter()
        .find(|(name, _)| *name == req.source_editor)
        .map(|(_, dir)| *dir)
        .ok_or_else(|| {
            tracing::warn!(
                source_editor = %req.source_editor,
                "import: unknown source editor"
            );
            StatusCode::BAD_REQUEST
        })?;

    // Find the extension.
    let (pkg, ext_root) = find_extension_in_editor(&home, dot_dir, &req.extension_id)
        .await
        .ok_or_else(|| {
            tracing::warn!(
                source_editor = %req.source_editor,
                extension_id = %req.extension_id,
                "import: extension not found"
            );
            StatusCode::NOT_FOUND
        })?;

    // Get the theme contribution.
    let contrib = pkg.contributes.themes.get(req.theme_index).ok_or_else(|| {
        tracing::warn!(
            extension_id = %req.extension_id,
            theme_index = req.theme_index,
            theme_count = pkg.contributes.themes.len(),
            "import: theme index out of range"
        );
        StatusCode::BAD_REQUEST
    })?;

    // Read the theme file.
    let theme_path = ext_root.join(&contrib.path);
    let raw_contents = tokio::fs::read_to_string(&theme_path).await.map_err(|e| {
        tracing::warn!(
            path = %theme_path.display(),
            error = %e,
            "import: cannot read theme file"
        );
        StatusCode::NOT_FOUND
    })?;

    // Parse JSONC into a generic Value (preserves all fields) and a
    // typed struct (for validation / name resolution).
    let value: serde_json::Value = parse_jsonc_value(&raw_contents).map_err(|e| {
        tracing::warn!(
            extension_id = %req.extension_id,
            theme_index = req.theme_index,
            path = %theme_path.display(),
            error = %e,
            "import: failed to parse theme JSONC"
        );
        StatusCode::BAD_REQUEST
    })?;
    let mut theme: VscodeThemeJson = serde_json::from_value(value.clone()).map_err(|e| {
        tracing::warn!(
            extension_id = %req.extension_id,
            theme_index = req.theme_index,
            path = %theme_path.display(),
            error = %e,
            "import: theme JSON does not match expected schema"
        );
        StatusCode::BAD_REQUEST
    })?;

    // Always prefer the contribution label as the theme name. Multiple
    // themes in the same extension often share the same internal `name`
    // field (e.g. all One Dark Pro variants are named "One Dark Pro"),
    // so the contribution label is the only unique identifier.
    let label = if contrib.label.is_empty() {
        if theme.name.is_empty() {
            pkg.display_name.clone()
        } else {
            theme.name.clone()
        }
    } else {
        contrib.label.clone()
    };
    theme.name = label;

    if theme.theme_type.is_none() {
        theme.theme_type = Some(ui_theme_to_type(&contrib.ui_theme).to_string());
    }

    // Serialize the parsed Value to clean JSON for storage (preserves
    // unknown fields like semanticHighlighting, semanticTokenColors).
    let clean_json = serde_json::to_string(&value).map_err(|e| {
        tracing::error!(error = %e, "import: serialize theme value");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let entry =
        write_raw_theme_to_disk(&state, &clean_json, &theme, req.overwrite_id.as_deref()).await?;
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
    validate_theme_id(&id)?;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_jsonc_trailing_comma_in_object() {
        let input = r#"{"a": 1, "b": 2,}"#;
        let _: serde_json::Value = parse_jsonc_value(input).unwrap();
    }

    #[test]
    fn parse_jsonc_trailing_comma_in_array() {
        let _: serde_json::Value = parse_jsonc_value("[1, 2, 3,]").unwrap();
    }

    #[test]
    fn parse_jsonc_comma_between_objects_in_array() {
        // This pattern broke with the old jsonc-to-json crate which
        // treated `{` as a closing delimiter and stripped commas before it.
        let input =
            r##"[{"settings": {"foreground": "#FFF"}}, {"settings": {"foreground": "#000"}}]"##;
        let v: serde_json::Value = parse_jsonc_value(input).unwrap();
        assert_eq!(v.as_array().unwrap().len(), 2);
    }

    #[test]
    fn parse_jsonc_line_comment() {
        let input = "{\n  // comment\n  \"a\": 1\n}";
        let _: serde_json::Value = parse_jsonc_value(input).unwrap();
    }

    #[test]
    fn parse_jsonc_block_comment() {
        let input = r#"{"a": /* comment */ 1}"#;
        let _: serde_json::Value = parse_jsonc_value(input).unwrap();
    }

    #[test]
    fn parse_jsonc_realistic_theme() {
        // Mimics the mermaid theme structure that was failing: objects
        // in a tokenColors array plus trailing commas in an object.
        let input = r##"{
  "name": "Test Theme",
  "tokenColors": [
    {"name": "Functions", "scope": ["entity.name"], "settings": {"foreground": "#DCDCAA"}},
    {"scope": "keyword", "settings": {"foreground": "#9650c8", "fontStyle": "bold"}}
  ],
  "semanticTokenColors": {
    "newOperator": "#C586C0",
    "numberLiteral": "#b5cea8",
  }
}"##;
        let v: serde_json::Value = parse_jsonc_value(input).unwrap();
        assert_eq!(v["tokenColors"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn parse_jsonc_as_theme_struct() {
        let input = r##"{
  "name": "My Theme",
  "type": "dark",
  "colors": {"editor.background": "#1e1e1e"},
  "tokenColors": [
    {"scope": "comment", "settings": {"foreground": "#6A9955"}}
  ]
}"##;
        let theme: VscodeThemeJson = parse_theme_jsonc(input).unwrap();
        assert_eq!(theme.name, "My Theme");
        assert_eq!(theme.token_colors.len(), 1);
    }
}
