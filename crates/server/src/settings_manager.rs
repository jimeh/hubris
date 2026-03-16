use std::fmt;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::fs;
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;
use toml_edit::{DocumentMut, Item, Table, value};

use crate::api::settings::{
    AppearanceSettingsPatch, Settings, SettingsPatch, SettingsState, SettingsStatus,
    TerminalSettingsPatch, WorktreeSettingsPatch,
};
use crate::events::{EventBus, EventKind};

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub enum SettingsManagerError {
    Io(std::io::Error),
    TomlDecode(toml::de::Error),
    TomlParse(toml_edit::TomlError),
    WritesBlocked,
}

impl fmt::Display for SettingsManagerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::TomlDecode(error) => write!(f, "{error}"),
            Self::TomlParse(error) => write!(f, "{error}"),
            Self::WritesBlocked => write!(f, "settings writes are blocked"),
        }
    }
}

impl std::error::Error for SettingsManagerError {}

impl From<std::io::Error> for SettingsManagerError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<toml::de::Error> for SettingsManagerError {
    fn from(value: toml::de::Error) -> Self {
        Self::TomlDecode(value)
    }
}

impl From<toml_edit::TomlError> for SettingsManagerError {
    fn from(value: toml_edit::TomlError) -> Self {
        Self::TomlParse(value)
    }
}

#[derive(Debug)]
struct StoredSettings {
    settings: Settings,
    document: DocumentMut,
    generation: String,
    status: SettingsStatus,
}

pub struct SettingsManager {
    path: PathBuf,
    state: RwLock<StoredSettings>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl SettingsManager {
    pub async fn new(path: PathBuf) -> Result<Self, SettingsManagerError> {
        let state = match load_settings_document(&path).await {
            Ok((document, settings)) => StoredSettings {
                settings,
                document,
                generation: next_generation(None)?,
                status: SettingsStatus::ok(),
            },
            Err(error @ SettingsManagerError::TomlDecode(_))
            | Err(error @ SettingsManagerError::TomlParse(_)) => {
                tracing::warn!(
                    "failed to load settings from {} at startup: {error}",
                    path.display()
                );
                StoredSettings {
                    settings: Settings::default(),
                    document: DocumentMut::new(),
                    generation: next_generation(None)?,
                    status: SettingsStatus::invalid_file(error.to_string()),
                }
            }
            Err(error) => return Err(error),
        };
        Ok(Self {
            path,
            state: RwLock::new(state),
            watcher: Mutex::new(None),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn get(&self) -> SettingsState {
        let state = self.state.read().await;
        SettingsState {
            settings: state.settings.clone(),
            generation: state.generation.clone(),
            status: state.status.clone(),
        }
    }

    pub async fn patch(&self, patch: SettingsPatch) -> Result<SettingsState, SettingsManagerError> {
        let mut state = self.state.write().await;
        if state.status.writes_blocked {
            return Err(SettingsManagerError::WritesBlocked);
        }
        let mut next = state.settings.clone();
        let mut document = state.document.clone();
        apply_patch_to_settings(&mut next, &patch);
        apply_patch_to_document(&mut document, &patch);
        let generation = persist_document(&self.path, &document, Some(&state.generation)).await?;
        state.document = document;
        state.settings = next.clone();
        state.generation = generation.clone();
        Ok(SettingsState {
            settings: next,
            generation,
            status: state.status.clone(),
        })
    }

    pub async fn replace(&self, settings: Settings) -> Result<SettingsState, SettingsManagerError> {
        let mut state = self.state.write().await;
        if state.status.writes_blocked {
            return Err(SettingsManagerError::WritesBlocked);
        }
        let mut document = state.document.clone();
        apply_settings_to_document(&mut document, &settings);
        let generation = persist_document(&self.path, &document, Some(&state.generation)).await?;
        state.document = document;
        state.settings = settings.clone();
        state.generation = generation.clone();
        Ok(SettingsState {
            settings,
            generation,
            status: state.status.clone(),
        })
    }

    pub async fn reload_from_disk(&self) -> Result<Option<SettingsState>, SettingsManagerError> {
        match load_settings_document(&self.path).await {
            Ok((document, settings)) => {
                let mut state = self.state.write().await;
                let changed = state.settings != settings;
                let status_changed = state.status != SettingsStatus::ok();
                state.document = document;
                state.status = SettingsStatus::ok();
                if !changed && !status_changed {
                    return Ok(None);
                }

                if changed {
                    state.generation = next_generation(Some(&state.generation))?;
                }
                state.settings = settings.clone();

                Ok(Some(SettingsState {
                    settings,
                    generation: state.generation.clone(),
                    status: state.status.clone(),
                }))
            }
            Err(error @ SettingsManagerError::TomlDecode(_))
            | Err(error @ SettingsManagerError::TomlParse(_)) => {
                let mut state = self.state.write().await;
                let next_status = SettingsStatus::invalid_file(error.to_string());
                if state.status == next_status {
                    return Ok(None);
                }
                state.status = next_status;

                Ok(Some(SettingsState {
                    settings: state.settings.clone(),
                    generation: state.generation.clone(),
                    status: state.status.clone(),
                }))
            }
            Err(error) => Err(error),
        }
    }

    pub fn start_sync(self: &Arc<Self>, events: Arc<EventBus>) {
        self.start_poller(Arc::clone(&events));
        if let Err(error) = self.start_watcher(events) {
            tracing::warn!(
                "failed to watch settings file {}: {error}",
                self.path.display()
            );
        }
    }

    fn start_watcher(self: &Arc<Self>, events: Arc<EventBus>) -> Result<(), notify::Error> {
        let watched_path = self.path.clone();
        let watched_parent = watched_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        let mut watcher = notify::recommended_watcher(move |result| {
            let _ = tx.send(result);
        })?;
        watcher.watch(&watched_parent, RecursiveMode::NonRecursive)?;
        if watched_path.exists() {
            watcher.watch(&watched_path, RecursiveMode::NonRecursive)?;
        }

        {
            let mut slot = self.watcher.lock().unwrap();
            *slot = Some(watcher);
        }

        let manager = Arc::clone(self);
        let watcher_events = Arc::clone(&events);
        tokio::spawn(async move {
            while let Some(result) = rx.recv().await {
                let should_reload = match result {
                    Ok(event) => event.paths.iter().any(|path| {
                        path_matches_settings_file(path, &watched_path, &watched_parent)
                    }),
                    Err(error) => {
                        tracing::warn!(
                            "settings watcher error for {}: {error}",
                            watched_path.display()
                        );
                        true
                    }
                };
                if !should_reload {
                    continue;
                }

                tokio::time::sleep(Duration::from_millis(75)).await;
                while let Ok(next) = rx.try_recv() {
                    let should_skip = match next {
                        Ok(event) => !event.paths.iter().any(|path| {
                            path_matches_settings_file(path, &watched_path, &watched_parent)
                        }),
                        Err(_) => false,
                    };
                    if should_skip {
                        continue;
                    }
                    tokio::time::sleep(Duration::from_millis(75)).await;
                }

                reload_and_emit(&manager, &watcher_events, &watched_path).await;
            }
        });

        Ok(())
    }

    fn start_poller(self: &Arc<Self>, events: Arc<EventBus>) {
        let manager = Arc::clone(self);
        let watched_path = self.path.clone();
        tokio::spawn(async move {
            let mut last_modified = read_last_modified(&watched_path).await;
            let mut interval = tokio::time::interval(Duration::from_millis(250));
            loop {
                interval.tick().await;
                let current_modified = read_last_modified(&watched_path).await;
                if current_modified == last_modified {
                    continue;
                }
                last_modified = current_modified;

                reload_and_emit(&manager, &events, &watched_path).await;
            }
        });
    }
}

async fn reload_and_emit(manager: &Arc<SettingsManager>, events: &Arc<EventBus>, path: &Path) {
    match manager.reload_from_disk().await {
        Ok(Some(settings)) => {
            events.emit(EventKind::SettingsUpdated(settings));
        }
        Ok(None) => {}
        Err(error) => {
            tracing::warn!("failed to reload settings from {}: {error}", path.display());
        }
    }
}

async fn load_settings_document(
    path: &Path,
) -> Result<(DocumentMut, Settings), SettingsManagerError> {
    match tokio::fs::read_to_string(path).await {
        Ok(contents) => parse_settings_document(&contents),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok((DocumentMut::new(), Settings::default()))
        }
        Err(error) => Err(SettingsManagerError::Io(error)),
    }
}

fn parse_settings_document(
    contents: &str,
) -> Result<(DocumentMut, Settings), SettingsManagerError> {
    if contents.trim().is_empty() {
        return Ok((DocumentMut::new(), Settings::default()));
    }

    let document = DocumentMut::from_str(contents)?;
    let settings = toml::from_str(contents)?;
    Ok((document, settings))
}

fn path_matches_settings_file(path: &Path, watched_path: &Path, watched_parent: &Path) -> bool {
    path == watched_path || path == watched_parent || path.parent() == Some(watched_parent)
}

async fn read_last_modified(path: &Path) -> Option<SystemTime> {
    tokio::fs::metadata(path)
        .await
        .ok()
        .and_then(|metadata| metadata.modified().ok())
}

fn apply_patch_to_settings(settings: &mut Settings, patch: &SettingsPatch) {
    if let Some(appearance) = &patch.appearance {
        apply_appearance_patch(&mut settings.appearance, appearance);
    }
    if let Some(terminal) = &patch.terminal {
        apply_terminal_patch(&mut settings.terminal, terminal);
    }
    if let Some(worktree) = &patch.worktree {
        apply_worktree_patch(&mut settings.worktree, worktree);
    }
}

fn apply_appearance_patch(
    settings: &mut crate::api::settings::AppearanceSettings,
    patch: &AppearanceSettingsPatch,
) {
    if let Some(color_scheme) = patch.color_scheme {
        settings.color_scheme = color_scheme;
    }
    if let Some(light_theme) = &patch.light_theme {
        settings.light_theme = light_theme.clone();
    }
    if let Some(dark_theme) = &patch.dark_theme {
        settings.dark_theme = dark_theme.clone();
    }
}

fn apply_terminal_patch(
    settings: &mut crate::api::settings::TerminalSettings,
    patch: &TerminalSettingsPatch,
) {
    if let Some(font_source) = patch.font_source {
        settings.font_source = font_source;
    }
    if let Some(system_font_family) = &patch.system_font_family {
        settings.system_font_family = system_font_family.clone();
    }
    if let Some(bundled_font) = &patch.bundled_font {
        settings.bundled_font = bundled_font.clone();
    }
    if let Some(font_size) = patch.font_size {
        settings.font_size = font_size;
    }
}

fn apply_worktree_patch(
    settings: &mut crate::api::settings::WorktreeSettings,
    patch: &WorktreeSettingsPatch,
) {
    if let Some(location_mode) = patch.location_mode {
        settings.location_mode = location_mode;
    }
}

fn ensure_table<'a>(document: &'a mut DocumentMut, key: &str) -> &'a mut Table {
    let item = document
        .as_table_mut()
        .entry(key)
        .or_insert(Item::Table(Table::new()));
    if !item.is_table() {
        *item = Item::Table(Table::new());
    }
    item.as_table_mut().expect("settings table should exist")
}

fn apply_patch_to_document(document: &mut DocumentMut, patch: &SettingsPatch) {
    if let Some(appearance) = &patch.appearance {
        let table = ensure_table(document, "appearance");
        if let Some(color_scheme) = appearance.color_scheme {
            table["colorScheme"] = value(color_scheme.as_str());
        }
        if let Some(light_theme) = &appearance.light_theme {
            table["lightTheme"] = value(light_theme.as_str());
        }
        if let Some(dark_theme) = &appearance.dark_theme {
            table["darkTheme"] = value(dark_theme.as_str());
        }
    }

    if let Some(terminal) = &patch.terminal {
        let table = ensure_table(document, "terminal");
        if let Some(font_source) = terminal.font_source {
            table["fontSource"] = value(font_source.as_str());
        }
        if let Some(system_font_family) = &terminal.system_font_family {
            table["systemFontFamily"] = value(system_font_family.as_str());
        }
        if let Some(bundled_font) = &terminal.bundled_font {
            table["bundledFont"] = value(bundled_font.as_str());
        }
        if let Some(font_size) = terminal.font_size {
            table["fontSize"] = value(i64::from(font_size));
        }
    }

    if let Some(worktree) = &patch.worktree {
        let table = ensure_table(document, "worktree");
        if let Some(location_mode) = worktree.location_mode {
            table["locationMode"] = value(location_mode.as_str());
        }
    }
}

fn apply_settings_to_document(document: &mut DocumentMut, settings: &Settings) {
    let appearance = ensure_table(document, "appearance");
    appearance["colorScheme"] = value(settings.appearance.color_scheme.as_str());
    appearance["lightTheme"] = value(settings.appearance.light_theme.as_str());
    appearance["darkTheme"] = value(settings.appearance.dark_theme.as_str());

    let terminal = ensure_table(document, "terminal");
    terminal["fontSource"] = value(settings.terminal.font_source.as_str());
    terminal["systemFontFamily"] = value(settings.terminal.system_font_family.as_str());
    terminal["bundledFont"] = value(settings.terminal.bundled_font.as_str());
    terminal["fontSize"] = value(i64::from(settings.terminal.font_size));

    let worktree = ensure_table(document, "worktree");
    worktree["locationMode"] = value(settings.worktree.location_mode.as_str());
}

async fn persist_document(
    path: &Path,
    document: &DocumentMut,
    previous_generation: Option<&str>,
) -> Result<String, SettingsManagerError> {
    let temp_path = temp_settings_path(path);
    let contents = document.to_string();
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&temp_path)
        .await
        .map_err(|error| cleanup_temp_file_on_error(&temp_path, error))?;

    if let Ok(metadata) = fs::metadata(path).await
        && let Err(error) = fs::set_permissions(&temp_path, metadata.permissions()).await
    {
        return Err(cleanup_temp_file_on_error(&temp_path, error));
    }

    if let Err(error) = file.write_all(contents.as_bytes()).await {
        return Err(cleanup_temp_file_on_error(&temp_path, error));
    }
    if let Err(error) = file.flush().await {
        return Err(cleanup_temp_file_on_error(&temp_path, error));
    }
    if let Err(error) = file.sync_all().await {
        return Err(cleanup_temp_file_on_error(&temp_path, error));
    }
    drop(file);

    if let Err(error) = fs::rename(&temp_path, path).await {
        return Err(cleanup_temp_file_on_error(&temp_path, error));
    }
    if let Err(error) = sync_parent_directory(path).await {
        return Err(SettingsManagerError::Io(error));
    }
    next_generation(previous_generation)
}

fn temp_settings_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("settings.toml");
    let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(
        "{file_name}.tmp.{}.{}",
        std::process::id(),
        counter
    ))
}

fn cleanup_temp_file_on_error(path: &Path, error: std::io::Error) -> SettingsManagerError {
    let _ = std::fs::remove_file(path);
    SettingsManagerError::Io(error)
}

async fn sync_parent_directory(path: &Path) -> Result<(), std::io::Error> {
    let parent = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    tokio::task::spawn_blocking(move || {
        let dir = std::fs::File::open(parent)?;
        dir.sync_all()
    })
    .await
    .map_err(|join_error| std::io::Error::other(join_error.to_string()))?
}

fn next_generation(previous_generation: Option<&str>) -> Result<String, SettingsManagerError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| SettingsManagerError::Io(std::io::Error::other(error.to_string())))?
        .as_nanos();
    let previous = previous_generation
        .and_then(|value| value.parse::<u128>().ok())
        .unwrap_or(0);
    Ok(std::cmp::max(now, previous.saturating_add(1)).to_string())
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    fn assert_no_temp_files(dir: &Path) {
        let entries = std::fs::read_dir(dir).unwrap();
        let temp_files = entries
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("settings.toml.tmp.")
            })
            .count();
        assert_eq!(temp_files, 0);
    }

    async fn new_manager(tmp: &TempDir) -> SettingsManager {
        SettingsManager::new(tmp.path().join("settings.toml"))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn persist_document_cleans_up_temp_files_after_success() {
        let tmp = TempDir::new().unwrap();
        let manager = new_manager(&tmp).await;

        let updated = manager
            .patch(SettingsPatch {
                appearance: Some(AppearanceSettingsPatch {
                    color_scheme: Some(crate::api::settings::ColorScheme::Dark),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .await
            .unwrap();

        assert_eq!(updated.settings.appearance.color_scheme.as_str(), "dark");
        assert_no_temp_files(tmp.path());
    }

    #[tokio::test]
    async fn failed_persist_does_not_advance_generation_or_leave_temp_files() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("missing").join("settings.toml");
        let manager = SettingsManager::new(path).await.unwrap();
        let initial = manager.get().await;

        let result = manager
            .patch(SettingsPatch {
                terminal: Some(TerminalSettingsPatch {
                    font_size: Some(16),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .await;

        assert!(matches!(result, Err(SettingsManagerError::Io(_))));

        let current = manager.get().await;
        assert_eq!(current.generation, initial.generation);
        assert_eq!(current.settings, initial.settings);
        assert!(!tmp.path().join("missing").exists());
        assert_no_temp_files(tmp.path());
    }
}
