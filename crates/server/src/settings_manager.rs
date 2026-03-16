use std::fmt;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;
use toml_edit::{DocumentMut, Item, Table, value};

use crate::api::settings::{
    AppearanceSettingsPatch, Settings, SettingsPatch, SettingsState, TerminalSettingsPatch,
    WorktreeSettingsPatch,
};
use crate::events::{EventBus, EventKind};

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
    writes_blocked: bool,
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
                writes_blocked: false,
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
                    writes_blocked: true,
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
        }
    }

    pub async fn patch(&self, patch: SettingsPatch) -> Result<SettingsState, SettingsManagerError> {
        let mut state = self.state.write().await;
        if state.writes_blocked {
            return Err(SettingsManagerError::WritesBlocked);
        }
        let mut next = state.settings.clone();
        apply_patch_to_settings(&mut next, &patch);
        apply_patch_to_document(&mut state.document, &patch);
        let generation =
            persist_document(&self.path, &state.document, Some(&state.generation)).await?;
        state.settings = next.clone();
        state.generation = generation.clone();
        Ok(SettingsState {
            settings: next,
            generation,
        })
    }

    pub async fn replace(&self, settings: Settings) -> Result<SettingsState, SettingsManagerError> {
        let mut state = self.state.write().await;
        if state.writes_blocked {
            return Err(SettingsManagerError::WritesBlocked);
        }
        apply_settings_to_document(&mut state.document, &settings);
        let generation =
            persist_document(&self.path, &state.document, Some(&state.generation)).await?;
        state.settings = settings.clone();
        state.generation = generation.clone();
        Ok(SettingsState {
            settings,
            generation,
        })
    }

    pub async fn reload_from_disk(&self) -> Result<Option<SettingsState>, SettingsManagerError> {
        let (document, settings) = load_settings_document(&self.path).await?;
        let mut state = self.state.write().await;
        let changed = state.settings != settings;
        let recovered = state.writes_blocked;
        state.document = document;
        state.writes_blocked = false;
        if !changed && !recovered {
            return Ok(None);
        }

        let generation = next_generation(Some(&state.generation))?;
        state.settings = settings.clone();
        state.generation = generation.clone();
        Ok(Some(SettingsState {
            settings,
            generation,
        }))
    }

    pub fn start_watcher(self: &Arc<Self>, events: Arc<EventBus>) -> Result<(), notify::Error> {
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

                match manager.reload_from_disk().await {
                    Ok(Some(settings)) => {
                        watcher_events.emit(EventKind::SettingsUpdated(settings));
                    }
                    Ok(None) => {}
                    Err(error) => {
                        tracing::warn!(
                            "failed to reload settings from {}: {error}",
                            watched_path.display()
                        );
                    }
                }
            }
        });

        let manager = Arc::clone(self);
        let watched_path = self.path.clone();
        let poll_events = Arc::clone(&events);
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

                match manager.reload_from_disk().await {
                    Ok(Some(settings)) => {
                        poll_events.emit(EventKind::SettingsUpdated(settings));
                    }
                    Ok(None) => {}
                    Err(error) => {
                        tracing::warn!(
                            "failed to reload settings from {}: {error}",
                            watched_path.display()
                        );
                    }
                }
            }
        });

        Ok(())
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
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .await?;
    file.write_all(document.to_string().as_bytes()).await?;
    file.flush().await?;
    file.sync_all().await?;
    next_generation(previous_generation)
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
