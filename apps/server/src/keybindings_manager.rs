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
use toml_edit::{Array, ArrayOfTables, DocumentMut, InlineTable, Item, Table, Value, value};

use crate::api::keybindings::{KeybindingEntry, Keybindings, KeybindingsState, KeybindingsStatus};
use crate::events::{EventBus, EventKind};
use crate::fs_sync::sync_parent_directory;

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub enum KeybindingsManagerError {
    Io(std::io::Error),
    TomlDecode(toml::de::Error),
    TomlParse(toml_edit::TomlError),
    WritesBlocked,
}

impl fmt::Display for KeybindingsManagerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::TomlDecode(error) => write!(f, "{error}"),
            Self::TomlParse(error) => write!(f, "{error}"),
            Self::WritesBlocked => write!(f, "keybindings writes are blocked"),
        }
    }
}

impl std::error::Error for KeybindingsManagerError {}

impl From<std::io::Error> for KeybindingsManagerError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<toml::de::Error> for KeybindingsManagerError {
    fn from(value: toml::de::Error) -> Self {
        Self::TomlDecode(value)
    }
}

impl From<toml_edit::TomlError> for KeybindingsManagerError {
    fn from(value: toml_edit::TomlError) -> Self {
        Self::TomlParse(value)
    }
}

#[derive(Debug)]
struct StoredKeybindings {
    keybindings: Vec<KeybindingEntry>,
    document: DocumentMut,
    generation: String,
    status: KeybindingsStatus,
}

pub struct KeybindingsManager {
    path: PathBuf,
    state: RwLock<StoredKeybindings>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    last_processed_modified: Mutex<Option<Option<SystemTime>>>,
}

impl KeybindingsManager {
    pub async fn new(path: PathBuf) -> Result<Self, KeybindingsManagerError> {
        let state = match load_keybindings_document(&path).await {
            Ok((document, keybindings)) => StoredKeybindings {
                keybindings,
                document,
                generation: next_generation(None)?,
                status: KeybindingsStatus::ok(),
            },
            Err(error @ KeybindingsManagerError::TomlDecode(_))
            | Err(error @ KeybindingsManagerError::TomlParse(_)) => {
                tracing::warn!(
                    "failed to load keybindings from {} at startup: {error}",
                    path.display()
                );
                StoredKeybindings {
                    keybindings: vec![],
                    document: DocumentMut::new(),
                    generation: next_generation(None)?,
                    status: KeybindingsStatus::invalid_file(error.to_string()),
                }
            }
            Err(error) => return Err(error),
        };

        Ok(Self {
            path,
            state: RwLock::new(state),
            watcher: Mutex::new(None),
            last_processed_modified: Mutex::new(None),
        })
    }

    pub async fn get(&self) -> KeybindingsState {
        let state = self.state.read().await;
        KeybindingsState {
            keybindings: state.keybindings.clone(),
            generation: state.generation.clone(),
            status: state.status.clone(),
        }
    }

    pub async fn replace(
        &self,
        keybindings: Vec<KeybindingEntry>,
    ) -> Result<KeybindingsState, KeybindingsManagerError> {
        let mut state = self.state.write().await;
        if state.status.writes_blocked {
            return Err(KeybindingsManagerError::WritesBlocked);
        }

        let mut document = state.document.clone();
        apply_keybindings_to_document(&mut document, &keybindings)?;
        let generation = persist_document(&self.path, &document, Some(&state.generation)).await?;
        state.document = document;
        state.keybindings = keybindings.clone();
        state.generation = generation.clone();

        Ok(KeybindingsState {
            keybindings,
            generation,
            status: state.status.clone(),
        })
    }

    pub async fn reload_from_disk(
        &self,
    ) -> Result<Option<KeybindingsState>, KeybindingsManagerError> {
        let mut state = self.state.write().await;
        match load_keybindings_document(&self.path).await {
            Ok((document, keybindings)) => {
                let changed = state.keybindings != keybindings;
                let status_changed = state.status != KeybindingsStatus::ok();
                state.document = document;
                state.status = KeybindingsStatus::ok();
                if !changed && !status_changed {
                    return Ok(None);
                }

                if changed {
                    state.generation = next_generation(Some(&state.generation))?;
                }
                state.keybindings = keybindings.clone();

                Ok(Some(KeybindingsState {
                    keybindings,
                    generation: state.generation.clone(),
                    status: state.status.clone(),
                }))
            }
            Err(error @ KeybindingsManagerError::TomlDecode(_))
            | Err(error @ KeybindingsManagerError::TomlParse(_)) => {
                let next_status = KeybindingsStatus::invalid_file(error.to_string());
                if state.status == next_status {
                    return Ok(None);
                }
                state.status = next_status;

                Ok(Some(KeybindingsState {
                    keybindings: state.keybindings.clone(),
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
                "failed to watch keybindings file {}: {error}",
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
                        path_matches_keybindings_file(path, &watched_path, &watched_parent)
                    }),
                    Err(error) => {
                        tracing::warn!(
                            "keybindings watcher error for {}: {error}",
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
                            path_matches_keybindings_file(path, &watched_path, &watched_parent)
                        }),
                        Err(_) => false,
                    };
                    if should_skip {
                        continue;
                    }
                    tokio::time::sleep(Duration::from_millis(75)).await;
                }

                reload_and_emit_if_needed(&manager, &watcher_events, &watched_path).await;
            }
        });

        Ok(())
    }

    fn start_poller(self: &Arc<Self>, events: Arc<EventBus>) {
        let manager = Arc::clone(self);
        let watched_path = self.path.clone();
        tokio::spawn(async move {
            let mut last_modified = None;
            let mut interval = tokio::time::interval(Duration::from_millis(250));
            loop {
                interval.tick().await;
                let current_modified = read_last_modified(&watched_path).await;
                if current_modified == last_modified {
                    continue;
                }
                last_modified = current_modified;

                reload_and_emit_if_needed(&manager, &events, &watched_path).await;
            }
        });
    }
}

async fn reload_and_emit_if_needed(
    manager: &Arc<KeybindingsManager>,
    events: &Arc<EventBus>,
    path: &Path,
) {
    let modified = read_last_modified(path).await;
    if !mark_reload_needed(&manager.last_processed_modified, modified) {
        return;
    }

    match manager.reload_from_disk().await {
        Ok(Some(keybindings)) => {
            events.emit(EventKind::KeybindingsUpdated(keybindings));
        }
        Ok(None) => {}
        Err(error) => {
            tracing::warn!(
                "failed to reload keybindings from {}: {error}",
                path.display()
            );
        }
    }
}

fn mark_reload_needed(
    last_processed_modified: &Mutex<Option<Option<SystemTime>>>,
    modified: Option<SystemTime>,
) -> bool {
    let mut last_processed = last_processed_modified.lock().unwrap();
    if *last_processed == Some(modified) {
        return false;
    }
    *last_processed = Some(modified);
    true
}

async fn load_keybindings_document(
    path: &Path,
) -> Result<(DocumentMut, Vec<KeybindingEntry>), KeybindingsManagerError> {
    match tokio::fs::read_to_string(path).await {
        Ok(contents) => parse_keybindings_document(&contents),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok((DocumentMut::new(), vec![]))
        }
        Err(error) => Err(KeybindingsManagerError::Io(error)),
    }
}

fn parse_keybindings_document(
    contents: &str,
) -> Result<(DocumentMut, Vec<KeybindingEntry>), KeybindingsManagerError> {
    if contents.trim().is_empty() {
        return Ok((DocumentMut::new(), vec![]));
    }

    let document = DocumentMut::from_str(contents)?;
    let keybindings = toml::from_str::<Keybindings>(contents)?.keybindings;
    Ok((document, keybindings))
}

fn path_matches_keybindings_file(path: &Path, watched_path: &Path, watched_parent: &Path) -> bool {
    path == watched_path
        || path == watched_parent
        || path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| {
                path.parent() == Some(watched_parent)
                    && name.starts_with(&keybindings_temp_file_prefix(watched_path))
            })
}

async fn read_last_modified(path: &Path) -> Option<SystemTime> {
    tokio::fs::metadata(path)
        .await
        .ok()
        .and_then(|metadata| metadata.modified().ok())
}

fn apply_keybindings_to_document(
    document: &mut DocumentMut,
    keybindings: &[KeybindingEntry],
) -> Result<(), KeybindingsManagerError> {
    if !document
        .get("keybindings")
        .is_some_and(|item| item.is_array_of_tables())
    {
        document["keybindings"] = Item::ArrayOfTables(ArrayOfTables::new());
    }

    let array = document["keybindings"]
        .as_array_of_tables_mut()
        .expect("keybindings array should exist");
    while array.len() < keybindings.len() {
        array.push(Table::new());
    }
    while array.len() > keybindings.len() {
        array.remove(array.len() - 1);
    }

    for (table, binding) in array.iter_mut().zip(keybindings) {
        insert_item_preserving_key(table, "key", value(binding.key.as_str()));
        if let Some(command) = &binding.command {
            insert_item_preserving_key(table, "command", value(command.as_str()));
        } else {
            table.remove("command");
        }
        if let Some(args) = &binding.args {
            insert_item_preserving_key(table, "args", json_to_toml_item(args)?);
        } else {
            table.remove("args");
        }
        if let Some(when) = &binding.when {
            insert_item_preserving_key(table, "when", value(when.as_str()));
        } else {
            table.remove("when");
        }
        if binding.disabled {
            insert_item_preserving_key(table, "disabled", value(true));
        } else {
            table.remove("disabled");
        }
    }

    Ok(())
}

fn insert_item_preserving_key(table: &mut Table, key: &str, item: Item) {
    if let Some(existing) = table.get_mut(key) {
        match (existing, item) {
            (Item::Value(existing), Item::Value(value)) => {
                *existing = value;
            }
            (existing, item) => {
                *existing = item;
            }
        }
    } else {
        table.insert(key, item);
    }
}

fn json_to_toml_item(value: &serde_json::Value) -> Result<Item, KeybindingsManagerError> {
    Ok(Item::Value(json_to_toml_value(value)?))
}

fn json_to_toml_value(value: &serde_json::Value) -> Result<Value, KeybindingsManagerError> {
    match value {
        serde_json::Value::Bool(value) => Ok(Value::from(*value)),
        serde_json::Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                Ok(Value::from(value))
            } else if let Some(value) = value.as_f64() {
                Ok(Value::from(value))
            } else {
                Err(KeybindingsManagerError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "TOML keybinding args do not support this number",
                )))
            }
        }
        serde_json::Value::String(value) => Ok(Value::from(value.clone())),
        serde_json::Value::Array(values) => {
            let mut array = Array::new();
            for value in values {
                array.push_formatted(json_to_toml_value(value)?);
            }
            Ok(Value::from(array))
        }
        serde_json::Value::Object(values) => {
            let mut table = InlineTable::new();
            for (key, value) in values {
                table.insert(key, json_to_toml_value(value)?);
            }
            table.fmt();
            Ok(Value::from(table))
        }
        serde_json::Value::Null => Err(KeybindingsManagerError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "TOML keybinding args do not support null",
        ))),
    }
}

async fn persist_document(
    path: &Path,
    document: &DocumentMut,
    previous_generation: Option<&str>,
) -> Result<String, KeybindingsManagerError> {
    let temp_path = temp_keybindings_path(path);
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
        return Err(KeybindingsManagerError::Io(error));
    }
    next_generation(previous_generation)
}

fn temp_keybindings_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let prefix = keybindings_temp_file_prefix(path);
    let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    parent.join(format!("{prefix}{}.{}", std::process::id(), counter))
}

fn keybindings_temp_file_prefix(path: &Path) -> String {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("keybindings.toml");
    format!("{file_name}.tmp.")
}

fn cleanup_temp_file_on_error(path: &Path, error: std::io::Error) -> KeybindingsManagerError {
    let _ = std::fs::remove_file(path);
    KeybindingsManagerError::Io(error)
}

fn next_generation(previous_generation: Option<&str>) -> Result<String, KeybindingsManagerError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| KeybindingsManagerError::Io(std::io::Error::other(error.to_string())))?
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

    async fn new_manager(tmp: &TempDir) -> KeybindingsManager {
        KeybindingsManager::new(tmp.path().join("keybindings.toml"))
            .await
            .unwrap()
    }

    #[test]
    fn parses_keybindings_with_args_and_disabled_entries() {
        let (_, keybindings) = parse_keybindings_document(
            r#"
[[keybindings]]
key = "cmd+shift+p"
command = "app.openCommandPalette"

[[keybindings]]
key = "cmd+alt+b"
command = "tab.newBrowser"
args = { url = "http://localhost:5173" }
when = "selectedWorktree"

[[keybindings]]
key = "cmd+w"
disabled = true
"#,
        )
        .unwrap();

        assert_eq!(keybindings.len(), 3);
        assert_eq!(
            keybindings[1].args.as_ref().unwrap()["url"],
            "http://localhost:5173"
        );
        assert!(keybindings[2].disabled);
    }

    #[tokio::test]
    async fn replace_preserves_comments_and_unknown_keys() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("keybindings.toml");
        std::fs::write(
            &path,
            r#"# Top-level comment.
[[keybindings]]
# Palette comment.
key = "cmd+shift+p"
command = "app.openCommandPalette"
extra = "kept"
"#,
        )
        .unwrap();
        let manager = KeybindingsManager::new(path.clone()).await.unwrap();

        manager
            .replace(vec![KeybindingEntry {
                key: "cmd+p".to_string(),
                command: Some("app.openCommandPalette".to_string()),
                args: None,
                when: None,
                disabled: false,
            }])
            .await
            .unwrap();

        let written = std::fs::read_to_string(path).unwrap();
        assert!(written.contains("# Top-level comment."));
        assert!(written.contains("# Palette comment."));
        assert!(written.contains("extra = \"kept\""));
        assert!(written.contains("key = \"cmd+p\""));
    }

    #[tokio::test]
    async fn malformed_file_blocks_writes_and_keeps_last_good_snapshot() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("keybindings.toml");
        std::fs::write(
            &path,
            r#"[[keybindings]]
key = "cmd+shift+p"
command = "app.openCommandPalette"
"#,
        )
        .unwrap();
        let manager = KeybindingsManager::new(path.clone()).await.unwrap();
        let initial = manager.get().await;
        assert_eq!(initial.keybindings.len(), 1);

        std::fs::write(&path, "[keybindings\nkey = \"bad\"\n").unwrap();
        let reloaded = manager.reload_from_disk().await.unwrap().unwrap();
        assert_eq!(reloaded.keybindings, initial.keybindings);
        assert!(reloaded.status.writes_blocked);

        let result = manager.replace(vec![]).await;
        assert!(matches!(
            result,
            Err(KeybindingsManagerError::WritesBlocked)
        ));
    }

    #[tokio::test]
    async fn missing_file_uses_empty_user_keybindings() {
        let tmp = TempDir::new().unwrap();
        let manager = new_manager(&tmp).await;
        let state = manager.get().await;

        assert!(state.keybindings.is_empty());
        assert_eq!(state.status, KeybindingsStatus::ok());
    }
}
