use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use crate::api::files::{ListWorktreeFilesResponse, WorktreeFileEntry, WorktreeFileKind};
use crate::api::worktrees::ResolvedWorktree;
use crate::events::{EventBus, EventKind};
use crate::git;

const WATCH_DEBOUNCE: Duration = Duration::from_millis(175);
const IDLE_TTL: Duration = Duration::from_secs(300);
const IDLE_SWEEP_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeFileError {
    InvalidPath,
    InvalidName,
    NotFound,
    NotDirectory,
    Conflict,
    PermissionDenied,
    Internal,
}

#[derive(Debug, Clone)]
struct CachedDirectory {
    generation: u32,
    entries: Vec<WorktreeFileEntry>,
}

#[derive(Debug, Clone)]
struct CachedGitStatus {
    generation: u32,
    status: git::WorktreeGitStatus,
}

#[derive(Debug, Default)]
struct PendingWatchEvent {
    paths: Vec<PathBuf>,
    force_root: bool,
}

pub struct WorktreeFilesService {
    trackers: Arc<DashMap<String, Arc<WorktreeFileTracker>>>,
    events: Arc<EventBus>,
    cleanup_started: AtomicBool,
}

struct WorktreeFileTracker {
    project_id: String,
    worktree_id: String,
    root_path: PathBuf,
    source_ref: Option<String>,
    generation: AtomicU64,
    last_access_ms: AtomicU64,
    directory_cache: DashMap<String, CachedDirectory>,
    git_cache: std::sync::Mutex<Option<CachedGitStatus>>,
    watcher: std::sync::Mutex<Option<RecommendedWatcher>>,
}

impl WorktreeFilesService {
    pub fn new(events: Arc<EventBus>) -> Self {
        Self {
            trackers: Arc::new(DashMap::new()),
            events,
            cleanup_started: AtomicBool::new(false),
        }
    }

    pub async fn list_directory(
        &self,
        resolved: &ResolvedWorktree,
        relative_path: &str,
    ) -> Result<ListWorktreeFilesResponse, WorktreeFileError> {
        self.start_cleanup_loop();
        let tracker = self.ensure_tracker(resolved)?;
        tracker.list_directory(relative_path).await
    }

    pub async fn rename_entry(
        &self,
        resolved: &ResolvedWorktree,
        relative_path: &str,
        new_name: &str,
    ) -> Result<String, WorktreeFileError> {
        self.start_cleanup_loop();
        let tracker = self.ensure_tracker(resolved)?;
        tracker.rename_entry(relative_path, new_name).await
    }

    pub async fn read_git_status(
        &self,
        resolved: &ResolvedWorktree,
    ) -> Result<(u32, git::WorktreeGitStatus), WorktreeFileError> {
        self.start_cleanup_loop();
        let tracker = self.ensure_tracker(resolved)?;
        tracker.read_git_status().await
    }

    pub fn invalidate_relative_paths(
        &self,
        resolved: &ResolvedWorktree,
        paths: &[String],
    ) -> Result<(), WorktreeFileError> {
        self.start_cleanup_loop();
        let tracker = self.ensure_tracker(resolved)?;
        tracker.invalidate_relative_paths(&self.events, paths)
    }

    fn start_cleanup_loop(&self) {
        if self
            .cleanup_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }

        let trackers = Arc::clone(&self.trackers);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(IDLE_SWEEP_INTERVAL).await;
                let now = now_ms();
                let stale_keys: Vec<String> = trackers
                    .iter()
                    .filter_map(|entry| {
                        let last_access = entry.value().last_access_ms.load(Ordering::SeqCst);
                        if now.saturating_sub(last_access) > duration_ms(IDLE_TTL) {
                            Some(entry.key().clone())
                        } else {
                            None
                        }
                    })
                    .collect();
                for key in stale_keys {
                    trackers.remove(&key);
                }
            }
        });
    }

    fn ensure_tracker(
        &self,
        resolved: &ResolvedWorktree,
    ) -> Result<Arc<WorktreeFileTracker>, WorktreeFileError> {
        if let Some(existing) = self.trackers.get(&resolved.worktree.id) {
            let tracker = existing.clone();
            tracker.touch();
            return Ok(tracker);
        }

        let tracker = WorktreeFileTracker::new(resolved, Arc::clone(&self.events))?;

        match self.trackers.entry(resolved.worktree.id.clone()) {
            dashmap::mapref::entry::Entry::Occupied(existing) => {
                let tracker = existing.get().clone();
                tracker.touch();
                Ok(tracker)
            }
            dashmap::mapref::entry::Entry::Vacant(entry) => {
                entry.insert(Arc::clone(&tracker));
                Ok(tracker)
            }
        }
    }
}

impl WorktreeFileTracker {
    fn new(
        resolved: &ResolvedWorktree,
        events: Arc<EventBus>,
    ) -> Result<Arc<Self>, WorktreeFileError> {
        let root_path = std::fs::canonicalize(&resolved.worktree.path).map_err(map_io_error)?;
        if !root_path.is_dir() {
            return Err(WorktreeFileError::NotDirectory);
        }

        let tracker = Arc::new(Self {
            project_id: resolved.project_id.clone(),
            worktree_id: resolved.worktree.id.clone(),
            root_path,
            source_ref: resolved.worktree.source_ref.clone(),
            generation: AtomicU64::new(1),
            last_access_ms: AtomicU64::new(now_ms()),
            directory_cache: DashMap::new(),
            git_cache: std::sync::Mutex::new(None),
            watcher: std::sync::Mutex::new(None),
        });

        tracker.install_watcher(events)?;
        Ok(tracker)
    }

    fn install_watcher(self: &Arc<Self>, events: Arc<EventBus>) -> Result<(), WorktreeFileError> {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<PendingWatchEvent>();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    let _ = tx.send(PendingWatchEvent {
                        force_root: event.paths.is_empty(),
                        paths: event.paths,
                    });
                }
            })
            .map_err(|_| WorktreeFileError::Internal)?;
        watcher
            .watch(&self.root_path, RecursiveMode::Recursive)
            .map_err(|_| WorktreeFileError::Internal)?;

        {
            let mut slot = self.watcher.lock().unwrap();
            *slot = Some(watcher);
        }

        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            while let Some(first_event) = rx.recv().await {
                let mut pending = first_event;
                let sleep = tokio::time::sleep(WATCH_DEBOUNCE);
                tokio::pin!(sleep);

                loop {
                    tokio::select! {
                        _ = &mut sleep => break,
                        maybe = rx.recv() => {
                            let Some(next_event) = maybe else {
                                return;
                            };
                            pending.force_root |= next_event.force_root;
                            pending.paths.extend(next_event.paths);
                        }
                    }
                }

                let Some(tracker) = weak.upgrade() else {
                    return;
                };
                tracker.invalidate(&events, pending);
            }
        });
        Ok(())
    }

    fn touch(&self) {
        self.last_access_ms.store(now_ms(), Ordering::SeqCst);
    }

    fn invalidate(&self, events: &EventBus, pending: PendingWatchEvent) {
        self.touch();
        self.directory_cache.clear();
        *self.git_cache.lock().unwrap() = None;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        events.emit(EventKind::WorktreeFilesUpdated {
            project_id: self.project_id.clone(),
            worktree_id: self.worktree_id.clone(),
            generation: to_public_generation(generation),
            paths: collect_invalidated_paths(&self.root_path, pending),
        });
    }

    fn invalidate_relative_paths(
        &self,
        events: &EventBus,
        paths: &[String],
    ) -> Result<(), WorktreeFileError> {
        self.touch();
        let invalidated_paths = collect_relative_invalidated_paths(paths)?;
        self.directory_cache.clear();
        *self.git_cache.lock().unwrap() = None;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        events.emit(EventKind::WorktreeFilesUpdated {
            project_id: self.project_id.clone(),
            worktree_id: self.worktree_id.clone(),
            generation: to_public_generation(generation),
            paths: invalidated_paths,
        });
        Ok(())
    }

    async fn list_directory(
        &self,
        relative_path: &str,
    ) -> Result<ListWorktreeFilesResponse, WorktreeFileError> {
        self.touch();
        let relative_path = normalize_relative_path(relative_path)?;
        let generation = to_public_generation(self.generation.load(Ordering::SeqCst));

        if let Some(cached) = self.directory_cache.get(&relative_path)
            && cached.generation == generation
        {
            return Ok(ListWorktreeFilesResponse {
                generation,
                path: relative_path,
                entries: cached.entries.clone(),
            });
        }

        let directory_path = resolve_existing_path(&self.root_path, &relative_path)?;
        let metadata = tokio::fs::metadata(&directory_path)
            .await
            .map_err(map_io_error)?;
        if !metadata.is_dir() {
            return Err(WorktreeFileError::NotDirectory);
        }

        let mut read_dir = tokio::fs::read_dir(&directory_path)
            .await
            .map_err(map_io_error)?;
        let mut entries = Vec::new();

        while let Some(entry) = read_dir.next_entry().await.map_err(map_io_error)? {
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy().to_string();
            if should_skip_entry(&name) {
                continue;
            }

            let file_type = entry.file_type().await.map_err(map_io_error)?;
            let kind = if file_type.is_dir() {
                WorktreeFileKind::Directory
            } else {
                WorktreeFileKind::File
            };
            let relative_entry_path = if relative_path.is_empty() {
                name.clone()
            } else {
                format!("{relative_path}/{name}")
            };
            entries.push(WorktreeFileEntry {
                name,
                path: relative_entry_path,
                kind,
            });
        }

        entries.sort_by(|a, b| {
            a.kind
                .cmp(&b.kind)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                .then_with(|| a.name.cmp(&b.name))
        });

        let response = ListWorktreeFilesResponse {
            generation,
            path: relative_path.clone(),
            entries: entries.clone(),
        };
        self.directory_cache.insert(
            relative_path,
            CachedDirectory {
                generation,
                entries,
            },
        );
        Ok(response)
    }

    async fn rename_entry(
        &self,
        relative_path: &str,
        new_name: &str,
    ) -> Result<String, WorktreeFileError> {
        self.touch();
        let relative_path = normalize_relative_path(relative_path)?;
        if relative_path.is_empty() {
            return Err(WorktreeFileError::InvalidPath);
        }
        let new_name = validate_new_name(new_name)?;
        let source_path = resolve_existing_path(&self.root_path, &relative_path)?;
        let parent = source_path
            .parent()
            .ok_or(WorktreeFileError::InvalidPath)?
            .to_path_buf();
        if !parent.starts_with(&self.root_path) {
            return Err(WorktreeFileError::InvalidPath);
        }

        let target_path = parent.join(new_name);
        if tokio::fs::try_exists(&target_path)
            .await
            .map_err(map_io_error)?
        {
            return Err(WorktreeFileError::Conflict);
        }

        tokio::fs::rename(&source_path, &target_path)
            .await
            .map_err(map_io_error)?;

        self.invalidate_path_local();

        relative_from_root(&self.root_path, &target_path)
    }

    fn invalidate_path_local(&self) {
        self.touch();
        self.directory_cache.clear();
        *self.git_cache.lock().unwrap() = None;
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    async fn read_git_status(&self) -> Result<(u32, git::WorktreeGitStatus), WorktreeFileError> {
        self.touch();
        let generation = to_public_generation(self.generation.load(Ordering::SeqCst));
        if let Some(cached) = self.git_cache.lock().unwrap().clone()
            && cached.generation == generation
        {
            return Ok((generation, cached.status));
        }

        let root_path = self.root_path.clone();
        let source_ref = self.source_ref.clone();
        let status = tokio::task::spawn_blocking(move || {
            git::read_worktree_status(&root_path, source_ref.as_deref())
        })
        .await
        .map_err(|_| WorktreeFileError::Internal)?
        .map_err(|_| WorktreeFileError::Internal)?;

        let mut cache = self.git_cache.lock().unwrap();
        if to_public_generation(self.generation.load(Ordering::SeqCst)) == generation {
            *cache = Some(CachedGitStatus {
                generation,
                status: status.clone(),
            });
        }

        Ok((generation, status))
    }
}

fn should_skip_entry(name: &str) -> bool {
    name == ".git"
}

fn normalize_relative_path(raw: &str) -> Result<String, WorktreeFileError> {
    let trimmed = raw.trim_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }

    let mut parts = Vec::new();
    for segment in trimmed.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." || segment.contains('\\') {
            return Err(WorktreeFileError::InvalidPath);
        }
        parts.push(segment);
    }

    Ok(parts.join("/"))
}

fn validate_new_name(raw: &str) -> Result<&str, WorktreeFileError> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
    {
        return Err(WorktreeFileError::InvalidName);
    }
    Ok(trimmed)
}

fn resolve_existing_path(root: &Path, relative_path: &str) -> Result<PathBuf, WorktreeFileError> {
    let candidate = if relative_path.is_empty() {
        root.to_path_buf()
    } else {
        root.join(relative_path)
    };
    let canonical = std::fs::canonicalize(candidate).map_err(map_io_error)?;
    if !canonical.starts_with(root) {
        return Err(WorktreeFileError::InvalidPath);
    }
    Ok(canonical)
}

fn relative_from_root(root: &Path, path: &Path) -> Result<String, WorktreeFileError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| WorktreeFileError::InvalidPath)?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn collect_invalidated_paths(root: &Path, pending: PendingWatchEvent) -> Vec<String> {
    let mut invalidated_paths = BTreeSet::new();

    if pending.force_root {
        invalidated_paths.insert(String::new());
    }

    for path in pending.paths {
        match normalize_watcher_path(root, &path) {
            Some(relative_path) => {
                if relative_path.is_empty()
                    || relative_path == ".git"
                    || relative_path.starts_with(".git/")
                {
                    invalidated_paths.insert(String::new());
                    continue;
                }

                invalidated_paths.insert(relative_path.clone());
                invalidated_paths.insert(parent_path_str(&relative_path));
            }
            None => {
                invalidated_paths.insert(String::new());
            }
        }
    }

    if invalidated_paths.is_empty() {
        invalidated_paths.insert(String::new());
    }

    invalidated_paths.into_iter().collect()
}

fn collect_relative_invalidated_paths(paths: &[String]) -> Result<Vec<String>, WorktreeFileError> {
    let mut invalidated_paths = BTreeSet::new();

    for path in paths {
        let normalized = normalize_relative_path(path)?;
        invalidated_paths.insert(normalized.clone());
        invalidated_paths.insert(parent_path_str(&normalized));
    }

    if invalidated_paths.is_empty() {
        invalidated_paths.insert(String::new());
    }

    Ok(invalidated_paths.into_iter().collect())
}

fn normalize_watcher_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let normalized = relative.to_string_lossy().replace('\\', "/");
    Some(normalized.trim_matches('/').to_string())
}

fn parent_path_str(path: &str) -> String {
    match path.rfind('/') {
        Some(index) => path[..index].to_string(),
        None => String::new(),
    }
}

fn map_io_error(error: std::io::Error) -> WorktreeFileError {
    match error.kind() {
        std::io::ErrorKind::NotFound => WorktreeFileError::NotFound,
        std::io::ErrorKind::PermissionDenied => WorktreeFileError::PermissionDenied,
        std::io::ErrorKind::AlreadyExists => WorktreeFileError::Conflict,
        _ => WorktreeFileError::Internal,
    }
}

fn now_ms() -> u64 {
    duration_ms(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default(),
    )
}

fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

fn to_public_generation(value: u64) -> u32 {
    value.min(u32::MAX as u64) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_invalidated_paths_includes_changed_paths_and_parents() {
        let root = Path::new("/repo");
        let paths = collect_invalidated_paths(
            root,
            PendingWatchEvent {
                force_root: false,
                paths: vec![root.join("src/nested/demo.txt"), root.join("src/nested")],
            },
        );

        assert_eq!(paths, vec!["src", "src/nested", "src/nested/demo.txt"]);
    }

    #[test]
    fn collect_invalidated_paths_falls_back_to_root_for_git_and_unknown_paths() {
        let root = Path::new("/repo");
        let paths = collect_invalidated_paths(
            root,
            PendingWatchEvent {
                force_root: false,
                paths: vec![root.join(".git/index"), PathBuf::from("/other/place.txt")],
            },
        );

        assert_eq!(paths, vec![""]);
    }

    #[test]
    fn collect_invalidated_paths_keeps_root_when_requested() {
        let root = Path::new("/repo");
        let paths = collect_invalidated_paths(
            root,
            PendingWatchEvent {
                force_root: true,
                paths: vec![root.join("README.md")],
            },
        );

        assert_eq!(paths, vec!["", "README.md"]);
    }
}
