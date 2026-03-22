use std::collections::{BTreeSet, HashMap};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::ffi::CString;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{Notify, mpsc};

use crate::api::files::{ListWorktreeFilesResponse, WorktreeFileEntry, WorktreeFileKind};
use crate::api::worktrees::ResolvedWorktree;
use crate::api::worktrees::{GitFileChange, GitFileChangeType};
use crate::events::{EventBus, EventKind};
use crate::git;
use crate::worktree_path_policy::{WorktreePathPolicy, WorktreePathPolicyError};

const WATCH_DEBOUNCE: Duration = Duration::from_millis(175);
const IDLE_TTL: Duration = Duration::from_secs(300);
const IDLE_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
const WATCH_EVENT_CHANNEL_CAPACITY: usize = 256;

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
    file_tree_paths: Vec<PathBuf>,
    git_metadata_paths: Vec<PathBuf>,
    force_file_root: bool,
    force_git_refresh: bool,
}

#[derive(Debug, Default)]
struct FileInvalidation {
    changed_paths: Vec<String>,
    listing_paths: Vec<String>,
    git_refresh: bool,
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
    path_policy: WorktreePathPolicy,
    source_ref: Option<String>,
    file_generation: AtomicU64,
    git_generation: AtomicU64,
    last_access_ms: AtomicU64,
    directory_cache: DashMap<String, CachedDirectory>,
    git_cache: std::sync::Mutex<Option<CachedGitStatus>>,
    git_rewrite_hints: std::sync::Mutex<HashMap<String, String>>,
    watchers: std::sync::Mutex<Vec<RecommendedWatcher>>,
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
        let tracker = self.ensure_tracker_async(resolved).await?;
        tracker.list_directory(relative_path).await
    }

    pub async fn rename_entry(
        &self,
        resolved: &ResolvedWorktree,
        relative_path: &str,
        new_name: &str,
    ) -> Result<String, WorktreeFileError> {
        self.start_cleanup_loop();
        let tracker = self.ensure_tracker_async(resolved).await?;
        tracker
            .rename_entry(&self.events, relative_path, new_name)
            .await
    }

    pub async fn read_git_status(
        &self,
        resolved: &ResolvedWorktree,
    ) -> Result<(u32, git::WorktreeGitStatus), WorktreeFileError> {
        self.start_cleanup_loop();
        let tracker = self.ensure_tracker_async(resolved).await?;
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

    pub fn record_git_rewrite_hint(
        &self,
        resolved: &ResolvedWorktree,
        path: &str,
        original_path: &str,
    ) -> Result<(), WorktreeFileError> {
        self.start_cleanup_loop();
        let tracker = self.ensure_tracker(resolved)?;
        tracker.record_git_rewrite_hint(path, original_path)
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

    async fn ensure_tracker_async(
        &self,
        resolved: &ResolvedWorktree,
    ) -> Result<Arc<WorktreeFileTracker>, WorktreeFileError> {
        if let Some(existing) = self.trackers.get(&resolved.worktree.id) {
            let tracker = existing.clone();
            tracker.touch();
            return Ok(tracker);
        }

        let tracker = WorktreeFileTracker::new_async(resolved, Arc::clone(&self.events)).await?;

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
        let repo_root = std::fs::canonicalize(&resolved.local_root).map_err(map_io_error)?;
        if !root_path.is_dir() {
            return Err(WorktreeFileError::NotDirectory);
        }

        let tracker = Arc::new(Self {
            project_id: resolved.project_id.clone(),
            worktree_id: resolved.worktree.id.clone(),
            path_policy: WorktreePathPolicy::new(root_path.clone(), repo_root),
            root_path,
            source_ref: resolved.worktree.source_ref.clone(),
            file_generation: AtomicU64::new(1),
            git_generation: AtomicU64::new(1),
            last_access_ms: AtomicU64::new(now_ms()),
            directory_cache: DashMap::new(),
            git_cache: std::sync::Mutex::new(None),
            git_rewrite_hints: std::sync::Mutex::new(HashMap::new()),
            watchers: std::sync::Mutex::new(Vec::new()),
        });

        tracker.install_watcher(events)?;
        Ok(tracker)
    }

    async fn new_async(
        resolved: &ResolvedWorktree,
        events: Arc<EventBus>,
    ) -> Result<Arc<Self>, WorktreeFileError> {
        let root_path = tokio::fs::canonicalize(&resolved.worktree.path)
            .await
            .map_err(map_io_error)?;
        let repo_root = tokio::fs::canonicalize(&resolved.local_root)
            .await
            .map_err(map_io_error)?;
        if !root_path.is_dir() {
            return Err(WorktreeFileError::NotDirectory);
        }

        let tracker = Arc::new(Self {
            project_id: resolved.project_id.clone(),
            worktree_id: resolved.worktree.id.clone(),
            path_policy: WorktreePathPolicy::new(root_path.clone(), repo_root),
            root_path,
            source_ref: resolved.worktree.source_ref.clone(),
            file_generation: AtomicU64::new(1),
            git_generation: AtomicU64::new(1),
            last_access_ms: AtomicU64::new(now_ms()),
            directory_cache: DashMap::new(),
            git_cache: std::sync::Mutex::new(None),
            git_rewrite_hints: std::sync::Mutex::new(HashMap::new()),
            watchers: std::sync::Mutex::new(Vec::new()),
        });

        tracker.install_watcher(events)?;
        Ok(tracker)
    }

    fn install_watcher(self: &Arc<Self>, events: Arc<EventBus>) -> Result<(), WorktreeFileError> {
        let (tx, mut rx) = mpsc::channel::<PendingWatchEvent>(WATCH_EVENT_CHANNEL_CAPACITY);
        let overflowed = Arc::new(AtomicBool::new(false));
        let overflow_notify = Arc::new(Notify::new());
        let mut watchers = Vec::new();

        let file_tx = tx.clone();
        let file_overflowed = Arc::clone(&overflowed);
        let file_overflow_notify = Arc::clone(&overflow_notify);
        let mut root_watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    let force_file_root = event.paths.is_empty();
                    enqueue_watch_event(
                        &file_tx,
                        &file_overflowed,
                        &file_overflow_notify,
                        PendingWatchEvent {
                            file_tree_paths: event.paths,
                            force_file_root,
                            ..PendingWatchEvent::default()
                        },
                    );
                }
            })
            .map_err(|_| WorktreeFileError::Internal)?;
        root_watcher
            .watch(&self.root_path, RecursiveMode::Recursive)
            .map_err(|_| WorktreeFileError::Internal)?;
        watchers.push(root_watcher);

        let git_watch_paths = git::resolve_git_metadata_watch_paths(&self.root_path)
            .map_err(|_| WorktreeFileError::Internal)?;
        let extra_git_watch_paths: Vec<PathBuf> = git_watch_paths
            .into_iter()
            .filter(|path| !path.starts_with(&self.root_path))
            .collect();

        if !extra_git_watch_paths.is_empty() {
            let git_tx = tx.clone();
            let git_overflowed = Arc::clone(&overflowed);
            let git_overflow_notify = Arc::clone(&overflow_notify);
            let mut git_watcher =
                notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                    if let Ok(event) = result {
                        let force_git_refresh = event.paths.is_empty();
                        enqueue_watch_event(
                            &git_tx,
                            &git_overflowed,
                            &git_overflow_notify,
                            PendingWatchEvent {
                                git_metadata_paths: event.paths,
                                force_git_refresh,
                                ..PendingWatchEvent::default()
                            },
                        );
                    }
                })
                .map_err(|_| WorktreeFileError::Internal)?;

            for path in &extra_git_watch_paths {
                git_watcher
                    .watch(path, RecursiveMode::Recursive)
                    .map_err(|_| WorktreeFileError::Internal)?;
            }
            watchers.push(git_watcher);
        }

        {
            let mut slot = self.watchers.lock().unwrap();
            *slot = watchers;
        }

        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(mut pending) =
                    next_pending_watch_event(&mut rx, &overflowed, &overflow_notify).await
                else {
                    return;
                };
                let sleep = tokio::time::sleep(WATCH_DEBOUNCE);
                tokio::pin!(sleep);

                loop {
                    tokio::select! {
                        _ = &mut sleep => break,
                        _ = overflow_notify.notified() => {
                            merge_pending_watch_event(
                                &mut pending,
                                take_overflow_watch_event(&overflowed),
                            );
                        }
                        maybe = rx.recv() => {
                            let Some(next_event) = maybe else {
                                return;
                            };
                            merge_pending_watch_event(&mut pending, Some(next_event));
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
        let invalidation = collect_file_invalidated_paths(&self.root_path, pending);

        if invalidation.git_refresh {
            self.emit_git_invalidation(events);
        }

        if !invalidation.changed_paths.is_empty() || !invalidation.listing_paths.is_empty() {
            self.emit_file_invalidation(
                events,
                invalidation.changed_paths,
                invalidation.listing_paths,
            );
        }
    }

    fn invalidate_relative_paths(
        &self,
        events: &EventBus,
        paths: &[String],
    ) -> Result<(), WorktreeFileError> {
        self.touch();
        let invalidation = collect_relative_invalidated_paths(paths)?;
        self.emit_file_invalidation(
            events,
            invalidation.changed_paths,
            invalidation.listing_paths,
        );
        Ok(())
    }

    fn emit_file_invalidation(
        &self,
        events: &EventBus,
        changed_paths: Vec<String>,
        listing_paths: Vec<String>,
    ) {
        self.directory_cache.clear();
        *self.git_cache.lock().unwrap() = None;
        let file_generation = self.file_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.git_generation.fetch_add(1, Ordering::SeqCst);
        events.emit(EventKind::WorktreeFilesUpdated {
            project_id: self.project_id.clone(),
            worktree_id: self.worktree_id.clone(),
            generation: to_public_generation(file_generation),
            changed_paths,
            listing_paths,
        });
    }

    fn emit_git_invalidation(&self, events: &EventBus) {
        *self.git_cache.lock().unwrap() = None;
        let git_generation = self.git_generation.fetch_add(1, Ordering::SeqCst) + 1;
        events.emit(EventKind::WorktreeGitStatusUpdated {
            project_id: self.project_id.clone(),
            worktree_id: self.worktree_id.clone(),
            generation: to_public_generation(git_generation),
        });
    }

    fn record_git_rewrite_hint(
        &self,
        path: &str,
        original_path: &str,
    ) -> Result<(), WorktreeFileError> {
        let path = normalize_relative_path(path)?;
        let original_path = normalize_relative_path(original_path)?;
        self.git_rewrite_hints
            .lock()
            .unwrap()
            .insert(path, original_path);
        Ok(())
    }

    async fn list_directory(
        &self,
        relative_path: &str,
    ) -> Result<ListWorktreeFilesResponse, WorktreeFileError> {
        self.touch();
        let relative_path = normalize_relative_path(relative_path)?;
        let generation = to_public_generation(self.file_generation.load(Ordering::SeqCst));

        if let Some(cached) = self.directory_cache.get(&relative_path)
            && cached.generation == generation
        {
            return Ok(ListWorktreeFilesResponse {
                generation,
                path: relative_path,
                entries: cached.entries.clone(),
            });
        }

        let directory_path =
            resolve_allowed_existing_path(&self.path_policy, &relative_path).await?;
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
            let (kind, is_symlink) =
                classify_directory_entry(&self.path_policy, entry.path(), file_type).await?;
            let relative_entry_path = if relative_path.is_empty() {
                name.clone()
            } else {
                format!("{relative_path}/{name}")
            };
            entries.push(WorktreeFileEntry {
                name,
                path: relative_entry_path,
                kind,
                is_symlink,
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
        events: &EventBus,
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
        rename_path_noreplace(source_path, target_path.clone()).await?;
        let next_relative_path = relative_from_root(&self.root_path, &target_path)?;
        let invalidated_paths = vec![relative_path.clone(), next_relative_path.clone()];
        let invalidation = collect_relative_invalidated_paths(&invalidated_paths)?;
        self.emit_file_invalidation(
            events,
            invalidation.changed_paths,
            invalidation.listing_paths,
        );
        Ok(next_relative_path)
    }

    async fn read_git_status(&self) -> Result<(u32, git::WorktreeGitStatus), WorktreeFileError> {
        self.touch();
        let generation = to_public_generation(self.git_generation.load(Ordering::SeqCst));
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
        let mut status = status;
        self.apply_git_rewrite_hints(&mut status);

        let mut cache = self.git_cache.lock().unwrap();
        if to_public_generation(self.git_generation.load(Ordering::SeqCst)) == generation {
            *cache = Some(CachedGitStatus {
                generation,
                status: status.clone(),
            });
        }

        Ok((generation, status))
    }

    fn apply_git_rewrite_hints(&self, status: &mut git::WorktreeGitStatus) {
        let mut hints = self.git_rewrite_hints.lock().unwrap();
        if hints.is_empty() {
            return;
        }

        apply_git_rewrite_hints_to_files(&mut status.staged_files, &hints, true);
        apply_git_rewrite_hints_to_files(&mut status.unstaged_files, &hints, false);

        let live_paths: BTreeSet<&str> = status
            .staged_files
            .iter()
            .map(|file| file.path.as_str())
            .chain(status.unstaged_files.iter().map(|file| file.path.as_str()))
            .collect();
        hints.retain(|path, _| live_paths.contains(path.as_str()));
    }
}

fn apply_git_rewrite_hints_to_files(
    files: &mut [GitFileChange],
    hints: &HashMap<String, String>,
    staged: bool,
) {
    for file in files {
        let Some(original_path) = hints.get(&file.path).cloned() else {
            continue;
        };

        let should_mark_copied = if staged {
            matches!(file.change_type, GitFileChangeType::Added)
        } else {
            matches!(file.change_type, GitFileChangeType::Untracked)
        };

        if should_mark_copied {
            file.change_type = GitFileChangeType::Copied;
            file.original_path = Some(original_path);
        } else if matches!(
            file.change_type,
            GitFileChangeType::Copied | GitFileChangeType::Renamed
        ) && file.original_path.is_none()
        {
            file.original_path = Some(original_path);
        }
    }
}

fn enqueue_watch_event(
    tx: &mpsc::Sender<PendingWatchEvent>,
    overflowed: &AtomicBool,
    overflow_notify: &Notify,
    event: PendingWatchEvent,
) {
    match tx.try_send(event) {
        Ok(()) | Err(TrySendError::Closed(_)) => {}
        Err(TrySendError::Full(_)) => {
            overflowed.store(true, Ordering::SeqCst);
            overflow_notify.notify_one();
        }
    }
}

async fn next_pending_watch_event(
    rx: &mut mpsc::Receiver<PendingWatchEvent>,
    overflowed: &AtomicBool,
    overflow_notify: &Notify,
) -> Option<PendingWatchEvent> {
    if let Some(event) = take_overflow_watch_event(overflowed) {
        return Some(event);
    }

    loop {
        tokio::select! {
            maybe = rx.recv() => return maybe,
            _ = overflow_notify.notified() => {
                if let Some(event) = take_overflow_watch_event(overflowed) {
                    return Some(event);
                }
            }
        }
    }
}

fn take_overflow_watch_event(overflowed: &AtomicBool) -> Option<PendingWatchEvent> {
    overflowed
        .swap(false, Ordering::SeqCst)
        .then_some(PendingWatchEvent {
            force_file_root: true,
            force_git_refresh: true,
            ..PendingWatchEvent::default()
        })
}

fn merge_pending_watch_event(
    pending: &mut PendingWatchEvent,
    next_event: Option<PendingWatchEvent>,
) {
    let Some(next_event) = next_event else {
        return;
    };

    pending.force_file_root |= next_event.force_file_root;
    pending.force_git_refresh |= next_event.force_git_refresh;
    pending.file_tree_paths.extend(next_event.file_tree_paths);
    pending
        .git_metadata_paths
        .extend(next_event.git_metadata_paths);
}

fn should_skip_entry(name: &str) -> bool {
    name == ".git"
}

fn normalize_relative_path(raw: &str) -> Result<String, WorktreeFileError> {
    let trimmed = raw.trim_matches('/');
    if trimmed.contains('\0') {
        return Err(WorktreeFileError::InvalidPath);
    }
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
        || trimmed.contains('\0')
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

async fn resolve_allowed_existing_path(
    policy: &WorktreePathPolicy,
    relative_path: &str,
) -> Result<PathBuf, WorktreeFileError> {
    policy
        .resolve_existing(relative_path)
        .await
        .map_err(map_path_policy_error)
}

async fn classify_directory_entry(
    policy: &WorktreePathPolicy,
    entry_path: PathBuf,
    file_type: std::fs::FileType,
) -> Result<(WorktreeFileKind, bool), WorktreeFileError> {
    if !file_type.is_symlink() {
        let kind = if file_type.is_dir() {
            WorktreeFileKind::Directory
        } else {
            WorktreeFileKind::File
        };
        return Ok((kind, false));
    }

    let canonical = match tokio::fs::canonicalize(&entry_path).await {
        Ok(canonical) => canonical,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((WorktreeFileKind::File, true));
        }
        Err(error) => return Err(map_io_error(error)),
    };

    if !policy.allows(&canonical) {
        return Ok((WorktreeFileKind::File, true));
    }

    let metadata = tokio::fs::metadata(&canonical)
        .await
        .map_err(map_io_error)?;
    let kind = if metadata.is_dir() {
        WorktreeFileKind::Directory
    } else {
        WorktreeFileKind::File
    };
    Ok((kind, true))
}

fn relative_from_root(root: &Path, path: &Path) -> Result<String, WorktreeFileError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| WorktreeFileError::InvalidPath)?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn collect_file_invalidated_paths(root: &Path, pending: PendingWatchEvent) -> FileInvalidation {
    let mut raw_changed_paths = BTreeSet::new();
    let mut git_refresh = pending.force_git_refresh || !pending.git_metadata_paths.is_empty();
    let mut force_root_listing = pending.force_file_root;

    if pending.force_file_root {
        raw_changed_paths.insert(String::new());
    }

    for path in pending.file_tree_paths {
        match normalize_watcher_path(root, &path) {
            Some(relative_path) => {
                if relative_path.is_empty()
                    || relative_path == ".git"
                    || relative_path.starts_with(".git/")
                {
                    git_refresh = true;
                    continue;
                }

                raw_changed_paths.insert(relative_path.clone());
            }
            None => {
                raw_changed_paths.insert(String::new());
                force_root_listing = true;
            }
        }
    }

    let (changed_paths, listing_paths) = if force_root_listing || raw_changed_paths.contains("") {
        raw_changed_paths.clear();
        raw_changed_paths.insert(String::new());
        (vec![String::new()], vec![String::new()])
    } else {
        let changed_paths = collapse_ancestor_paths(&raw_changed_paths);
        let listing_paths = changed_paths
            .iter()
            .map(|path| parent_path_str(path))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        (changed_paths, listing_paths)
    };

    let (changed_paths, listing_paths) =
        if changed_paths.is_empty() && listing_paths.is_empty() && !git_refresh {
            (vec![String::new()], vec![String::new()])
        } else {
            (changed_paths, listing_paths)
        };

    FileInvalidation {
        changed_paths,
        listing_paths,
        git_refresh,
    }
}

fn collapse_ancestor_paths(paths: &BTreeSet<String>) -> Vec<String> {
    let mut collapsed = Vec::new();

    for path in paths {
        if path.is_empty() {
            collapsed.push(String::new());
            continue;
        }

        let is_ancestor = paths
            .iter()
            .any(|other| other != path && is_strict_subpath(other, path));
        if !is_ancestor {
            collapsed.push(path.clone());
        }
    }

    collapsed
}

fn is_strict_subpath(path: &str, parent: &str) -> bool {
    path.len() > parent.len()
        && path.starts_with(parent)
        && path.as_bytes().get(parent.len()) == Some(&b'/')
}

fn collect_relative_invalidated_paths(
    paths: &[String],
) -> Result<FileInvalidation, WorktreeFileError> {
    let mut changed_paths = BTreeSet::new();
    let mut listing_paths = BTreeSet::new();

    for path in paths {
        let normalized = normalize_relative_path(path)?;
        changed_paths.insert(normalized.clone());
        listing_paths.insert(parent_path_str(&normalized));
    }

    if changed_paths.is_empty() && listing_paths.is_empty() {
        changed_paths.insert(String::new());
        listing_paths.insert(String::new());
    }

    Ok(FileInvalidation {
        changed_paths: changed_paths.into_iter().collect(),
        listing_paths: listing_paths.into_iter().collect(),
        git_refresh: false,
    })
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

fn map_path_policy_error(error: WorktreePathPolicyError) -> WorktreeFileError {
    match error {
        WorktreePathPolicyError::NotFound => WorktreeFileError::NotFound,
        WorktreePathPolicyError::PermissionDenied => WorktreeFileError::PermissionDenied,
        WorktreePathPolicyError::Denied => WorktreeFileError::PermissionDenied,
        WorktreePathPolicyError::Internal => WorktreeFileError::Internal,
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn rename_path_noreplace(
    source_path: PathBuf,
    target_path: PathBuf,
) -> Result<(), WorktreeFileError> {
    tokio::task::spawn_blocking(move || rename_path_noreplace_blocking(&source_path, &target_path))
        .await
        .map_err(|_| WorktreeFileError::Internal)?
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
async fn rename_path_noreplace(
    source_path: PathBuf,
    target_path: PathBuf,
) -> Result<(), WorktreeFileError> {
    // This fallback is still TOCTOU-prone: without a native no-replace rename
    // syscall on this platform we can only check, then rename.
    if tokio::fs::try_exists(&target_path)
        .await
        .map_err(map_io_error)?
    {
        return Err(WorktreeFileError::Conflict);
    }

    tokio::fs::rename(source_path, target_path)
        .await
        .map_err(map_io_error)
}

#[cfg(target_os = "linux")]
fn rename_path_noreplace_blocking(
    source_path: &Path,
    target_path: &Path,
) -> Result<(), WorktreeFileError> {
    let source = c_string_path(source_path)?;
    let target = c_string_path(target_path)?;
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(map_io_error(std::io::Error::last_os_error()))
    }
}

#[cfg(target_os = "macos")]
fn rename_path_noreplace_blocking(
    source_path: &Path,
    target_path: &Path,
) -> Result<(), WorktreeFileError> {
    let source = c_string_path(source_path)?;
    let target = c_string_path(target_path)?;
    let result = unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(map_io_error(std::io::Error::last_os_error()))
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn c_string_path(path: &Path) -> Result<CString, WorktreeFileError> {
    CString::new(path.as_os_str().as_bytes()).map_err(|_| WorktreeFileError::InvalidPath)
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
    use std::sync::Arc;

    #[test]
    fn collect_invalidated_paths_includes_changed_paths_and_parents() {
        let root = Path::new("/repo");
        let invalidation = collect_file_invalidated_paths(
            root,
            PendingWatchEvent {
                force_file_root: false,
                file_tree_paths: vec![root.join("src/nested/demo.txt"), root.join("src/nested")],
                ..PendingWatchEvent::default()
            },
        );

        assert!(!invalidation.git_refresh);
        assert_eq!(invalidation.changed_paths, vec!["src/nested/demo.txt"]);
        assert_eq!(invalidation.listing_paths, vec!["src/nested"]);
    }

    #[test]
    fn collect_invalidated_paths_separates_git_metadata_from_file_paths() {
        let root = Path::new("/repo");
        let invalidation = collect_file_invalidated_paths(
            root,
            PendingWatchEvent {
                force_file_root: false,
                file_tree_paths: vec![root.join(".git/index"), PathBuf::from("/other/place.txt")],
                ..PendingWatchEvent::default()
            },
        );

        assert!(invalidation.git_refresh);
        assert_eq!(invalidation.changed_paths, vec![""]);
        assert_eq!(invalidation.listing_paths, vec![""]);
    }

    #[test]
    fn collect_invalidated_paths_keeps_root_when_requested() {
        let root = Path::new("/repo");
        let invalidation = collect_file_invalidated_paths(
            root,
            PendingWatchEvent {
                force_file_root: true,
                file_tree_paths: vec![root.join("README.md")],
                ..PendingWatchEvent::default()
            },
        );

        assert!(!invalidation.git_refresh);
        assert_eq!(invalidation.changed_paths, vec![""]);
        assert_eq!(invalidation.listing_paths, vec![""]);
    }

    #[test]
    fn collect_invalidated_paths_filters_strict_ancestor_directories() {
        let root = Path::new("/repo");
        let invalidation = collect_file_invalidated_paths(
            root,
            PendingWatchEvent {
                file_tree_paths: vec![
                    root.join("src"),
                    root.join("src/nested"),
                    root.join("src/nested/watch-me.txt"),
                ],
                ..PendingWatchEvent::default()
            },
        );

        assert_eq!(invalidation.changed_paths, vec!["src/nested/watch-me.txt"]);
        assert_eq!(invalidation.listing_paths, vec!["src/nested"]);
    }

    #[test]
    fn overflow_watch_event_forces_safe_root_and_git_refresh() {
        let invalidation = collect_file_invalidated_paths(
            Path::new("/repo"),
            PendingWatchEvent {
                force_file_root: true,
                force_git_refresh: true,
                ..PendingWatchEvent::default()
            },
        );

        assert!(invalidation.git_refresh);
        assert_eq!(invalidation.changed_paths, vec![""]);
        assert_eq!(invalidation.listing_paths, vec![""]);
    }

    #[tokio::test]
    async fn stale_overflow_notify_permit_does_not_terminate_watch_loop() {
        let (_tx, mut rx) = mpsc::channel(1);
        let overflowed = AtomicBool::new(true);
        let overflow_notify = Arc::new(Notify::new());
        overflow_notify.notify_one();

        let first = next_pending_watch_event(&mut rx, &overflowed, &overflow_notify)
            .await
            .unwrap();
        assert!(first.force_file_root);
        assert!(first.force_git_refresh);

        let second = tokio::time::timeout(
            Duration::from_millis(50),
            next_pending_watch_event(&mut rx, &overflowed, &overflow_notify),
        )
        .await;

        assert!(second.is_err(), "stale notify permit should be ignored");
    }
}
