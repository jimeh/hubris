//! Git repository and worktree operations.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use git2::build::CheckoutBuilder;
use git2::{
    BranchType, Delta, DiffDelta, DiffFindOptions, DiffOptions, ErrorCode, FileMode, Reference,
    Repository, Sort, Status, StatusEntry, Time, WorktreeAddOptions, WorktreeLockStatus,
    WorktreePruneOptions,
};
use uuid::Uuid;

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utoipa::ToSchema;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum GitFileChangeType {
    Added,
    Copied,
    Renamed,
    Conflict,
    Modified,
    Deleted,
    Typechange,
    Untracked,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub change_type: GitFileChangeType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insertions: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitSummary {
    pub id: String,
    pub short_id: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitPerson {
    pub name: String,
    pub email: String,
    pub date: String,
}

const WORKTREE_NAMESPACE: Uuid = Uuid::from_u128(0x2b8b1f5e_84f8_4d8d_9ad8_9f6df2a93f3b);

#[derive(Debug, Clone)]
pub struct GitWorktree {
    pub path: PathBuf,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum GitStartPointKind {
    Local,
    Remote,
}

#[derive(Debug, Clone)]
pub struct GitStartPoint {
    pub name: String,
    pub kind: GitStartPointKind,
    pub sha: String,
    pub commit_timestamp: i64,
}

#[derive(Debug, Clone)]
pub struct WorktreeGitStatus {
    pub unstaged_files: Vec<GitFileChange>,
    pub staged_files: Vec<GitFileChange>,
    pub ahead_count: usize,
    pub ahead_commits: Vec<GitCommitSummary>,
    pub comparison_available: bool,
    pub comparison_error: Option<String>,
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct GitError {
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct GitCommitDetails {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    pub message: String,
    pub author: GitCommitPerson,
    pub committer: GitCommitPerson,
    pub files: Vec<GitFileChange>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitCommitDetailsError {
    NotFound,
    Internal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitPathActionError {
    InvalidPath,
    Conflict,
    NotFound,
    PermissionDenied,
    Internal,
}

fn to_git_error(error: impl std::fmt::Display) -> GitError {
    GitError {
        message: error.to_string(),
    }
}

fn canonicalize_or(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn trim_trailing_newlines(value: String) -> String {
    value.trim_end_matches(['\n', '\r']).to_string()
}

fn bytes_to_string(value: &[u8]) -> String {
    String::from_utf8_lossy(value).into_owned()
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn decode_ref_name(bytes: &[u8]) -> String {
    bytes_to_string(bytes)
}

fn is_unborn_or_missing_head(error: &git2::Error) -> bool {
    matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound)
}

fn format_git_offset(time: Time) -> String {
    let offset = time.offset_minutes();
    let sign = if offset < 0 { '-' } else { '+' };
    let offset = offset.abs();
    let hours = offset / 60;
    let minutes = offset % 60;
    format!("{sign}{hours:02}:{minutes:02}")
}

#[cfg(not(windows))]
fn format_git_signature_date(time: Time) -> String {
    let adjusted = time
        .seconds()
        .saturating_add(i64::from(time.offset_minutes()) * 60);
    let mut tm = std::mem::MaybeUninit::<libc::tm>::zeroed();
    let seconds = adjusted as libc::time_t;
    let result = unsafe { libc::gmtime_r(&seconds, tm.as_mut_ptr()) };
    if result.is_null() {
        return format!("{} {}", time.seconds(), format_git_offset(time));
    }

    let tm = unsafe { tm.assume_init() };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec,
        format_git_offset(time),
    )
}

#[cfg(windows)]
fn format_git_signature_date(time: Time) -> String {
    format!("{} {}", time.seconds(), format_git_offset(time))
}

fn map_commit_person(signature: git2::Signature<'_>) -> GitCommitPerson {
    GitCommitPerson {
        name: bytes_to_string(signature.name_bytes()),
        email: bytes_to_string(signature.email_bytes()),
        date: format_git_signature_date(signature.when()),
    }
}

fn normalize_relative_git_path(raw: &str) -> Result<String, GitPathActionError> {
    let trimmed = raw.trim_matches('/');
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err(GitPathActionError::InvalidPath);
    }

    let mut parts = Vec::new();
    for segment in trimmed.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." || segment.contains('\\') {
            return Err(GitPathActionError::InvalidPath);
        }
        parts.push(segment);
    }

    Ok(parts.join("/"))
}

fn normalized_git_action_paths(
    relative_path: &str,
    original_path: Option<&str>,
) -> Result<BTreeSet<String>, GitPathActionError> {
    let mut paths = BTreeSet::from([normalize_relative_git_path(relative_path)?]);
    if let Some(original_path) = original_path {
        paths.insert(normalize_relative_git_path(original_path)?);
    }
    Ok(paths)
}

fn path_matches_literal_or_child(target: &str, candidate: &str) -> bool {
    candidate == target
        || candidate
            .strip_prefix(target)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn matching_index_entries(index: &git2::Index, target: &str) -> Vec<git2::IndexEntry> {
    index
        .iter()
        .filter(|entry| path_matches_literal_or_child(target, &bytes_to_string(&entry.path)))
        .collect()
}

fn target_is_directory(
    worktree_path: &Path,
    target: &str,
    current_entries: &[git2::IndexEntry],
    head_entries: &[git2::IndexEntry],
) -> bool {
    worktree_path.join(target).is_dir()
        || current_entries.iter().any(|entry| {
            bytes_to_string(&entry.path)
                .strip_prefix(target)
                .is_some_and(|suffix| suffix.starts_with('/'))
        })
        || head_entries.iter().any(|entry| {
            bytes_to_string(&entry.path)
                .strip_prefix(target)
                .is_some_and(|suffix| suffix.starts_with('/'))
        })
}

fn remove_index_path(index: &mut git2::Index, path: &str) -> Result<(), GitPathActionError> {
    match index.remove_path(Path::new(path)) {
        Ok(()) => Ok(()),
        Err(err) if err.code() == ErrorCode::NotFound => Ok(()),
        Err(err) => Err(map_git2_path_error(err)),
    }
}

fn collect_worktree_paths(root: &Path, target: &str) -> Result<Vec<String>, GitPathActionError> {
    fn walk_dir(
        root: &Path,
        dir: &Path,
        paths: &mut Vec<String>,
    ) -> Result<(), GitPathActionError> {
        for entry in std::fs::read_dir(dir).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => GitPathActionError::NotFound,
            std::io::ErrorKind::PermissionDenied => GitPathActionError::PermissionDenied,
            _ => GitPathActionError::Internal,
        })? {
            let entry = entry.map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => GitPathActionError::NotFound,
                std::io::ErrorKind::PermissionDenied => GitPathActionError::PermissionDenied,
                _ => GitPathActionError::Internal,
            })?;
            let path = entry.path();
            let metadata =
                std::fs::symlink_metadata(&path).map_err(|error| match error.kind() {
                    std::io::ErrorKind::NotFound => GitPathActionError::NotFound,
                    std::io::ErrorKind::PermissionDenied => GitPathActionError::PermissionDenied,
                    _ => GitPathActionError::Internal,
                })?;
            if metadata.is_dir() {
                walk_dir(root, &path, paths)?;
                continue;
            }

            let relative = path
                .strip_prefix(root)
                .map_err(|_| GitPathActionError::Internal)?;
            paths.push(relative.to_string_lossy().replace('\\', "/"));
        }
        Ok(())
    }

    let path = root.join(target);
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if metadata.is_dir() {
                let mut paths = Vec::new();
                walk_dir(root, &path, &mut paths)?;
                paths.sort();
                Ok(paths)
            } else {
                Ok(vec![target.to_string()])
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            Err(GitPathActionError::PermissionDenied)
        }
        Err(_) => Err(GitPathActionError::Internal),
    }
}

fn invalidated_parent_paths(paths: &BTreeSet<String>) -> Vec<String> {
    let mut invalidated = BTreeSet::new();
    for path in paths {
        invalidated.insert(path.clone());
        if let Some((parent, _)) = path.rsplit_once('/') {
            invalidated.insert(parent.to_string());
        } else {
            invalidated.insert(String::new());
        }
    }
    invalidated.into_iter().collect()
}

fn map_git_path_error(error: GitError) -> GitPathActionError {
    tracing::warn!(error = %error, "classifying git path action error");
    let message = error.message.to_lowercase();
    if message.contains("permission denied") {
        GitPathActionError::PermissionDenied
    } else if message.contains("did not match any file")
        || message.contains("pathspec")
        || message.contains("no such file")
    {
        GitPathActionError::NotFound
    } else if message.contains("conflict") || message.contains("unmerged") {
        GitPathActionError::Conflict
    } else {
        GitPathActionError::Internal
    }
}

fn map_git2_path_error(error: git2::Error) -> GitPathActionError {
    tracing::warn!(error = %error, "classifying git2 path action error");
    match error.code() {
        ErrorCode::NotFound | ErrorCode::InvalidSpec => GitPathActionError::NotFound,
        ErrorCode::Unmerged | ErrorCode::Conflict | ErrorCode::MergeConflict => {
            GitPathActionError::Conflict
        }
        _ => map_git_path_error(to_git_error(error)),
    }
}

fn open_repo(path: &Path) -> Result<Repository, GitError> {
    Repository::open(path).map_err(to_git_error)
}

fn discover_repo(path: &Path) -> Result<Repository, GitError> {
    Repository::discover(path).map_err(to_git_error)
}

fn reference_display_name(reference: &Reference<'_>) -> String {
    decode_ref_name(reference.shorthand_bytes())
}

fn abbreviate_oid(repo: &Repository, oid: git2::Oid) -> Result<String, GitError> {
    repo.find_object(oid, None)
        .and_then(|object| object.short_id())
        .map(|buf| buf.as_str().unwrap_or_default().to_string())
        .map_err(to_git_error)
}

fn short_head_name(repo: &Repository) -> Result<Option<String>, GitError> {
    match repo.head() {
        Ok(head) => {
            if repo.head_detached().map_err(to_git_error)? {
                return Ok(None);
            }
            Ok(Some(reference_display_name(&head)))
        }
        Err(err) if is_unborn_or_missing_head(&err) => Ok(None),
        Err(err) => Err(to_git_error(err)),
    }
}

fn head_tree(repo: &Repository) -> Result<Option<git2::Tree<'_>>, GitError> {
    match repo.head() {
        Ok(head) => head.peel_to_tree().map(Some).map_err(to_git_error),
        Err(err) if is_unborn_or_missing_head(&err) => Ok(None),
        Err(err) => Err(to_git_error(err)),
    }
}

/// Git object source used for file/diff tab content loading.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitDiffBlobSource {
    Head,
    Index,
}

/// Loaded blob content for file/diff tabs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitDiffBlobContent {
    Missing,
    Text(String),
    Unsupported(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitCommitDiffError {
    NotFound,
    Internal,
}

const SUBMODULE_DIFF_UNSUPPORTED_REASON: &str = "Submodule diffs are not supported.";

fn format_diff_size_limit(max_bytes: u64) -> String {
    const KIB: u64 = 1024;
    const MIB: u64 = 1024 * KIB;

    if max_bytes.is_multiple_of(MIB) {
        format!("{} MiB", max_bytes / MIB)
    } else if max_bytes.is_multiple_of(KIB) {
        format!("{} KiB", max_bytes / KIB)
    } else if max_bytes == 1 {
        "1 byte".to_string()
    } else {
        format!("{max_bytes} bytes")
    }
}

fn load_head_blob<'repo>(
    repo: &'repo Repository,
    relative_path: &str,
) -> Result<Option<git2::Blob<'repo>>, GitError> {
    let Some(tree) = head_tree(repo)? else {
        return Ok(None);
    };
    load_tree_blob(repo, &tree, relative_path)
}

fn load_tree_blob<'repo>(
    repo: &'repo Repository,
    tree: &git2::Tree<'repo>,
    relative_path: &str,
) -> Result<Option<git2::Blob<'repo>>, GitError> {
    let entry = match tree.get_path(Path::new(relative_path)) {
        Ok(entry) => entry,
        Err(err) if err.code() == ErrorCode::NotFound => return Ok(None),
        Err(err) => return Err(to_git_error(err)),
    };
    let object = entry.to_object(repo).map_err(to_git_error)?;
    if object.kind() != Some(git2::ObjectType::Blob) {
        return Ok(None);
    }
    object.peel_to_blob().map(Some).map_err(to_git_error)
}

fn load_index_blob<'repo>(
    repo: &'repo Repository,
    relative_path: &str,
) -> Result<Option<git2::Blob<'repo>>, GitError> {
    let index = repo.index().map_err(to_git_error)?;
    let Some(entry) = index.get_path(Path::new(relative_path), 0) else {
        return Ok(None);
    };
    match repo.find_blob(entry.id) {
        Ok(blob) => Ok(Some(blob)),
        Err(err) if err.code() == ErrorCode::NotFound => Ok(None),
        Err(err) => Err(to_git_error(err)),
    }
}

fn diff_blob_content_from_blob(blob: Option<git2::Blob<'_>>, max_bytes: u64) -> GitDiffBlobContent {
    let Some(blob) = blob else {
        return GitDiffBlobContent::Missing;
    };
    if blob.size() as u64 > max_bytes {
        return GitDiffBlobContent::Unsupported(format!(
            "Diffs larger than {} are read-only.",
            format_diff_size_limit(max_bytes)
        ));
    }

    match std::str::from_utf8(blob.content()) {
        Ok(content) => GitDiffBlobContent::Text(content.to_string()),
        Err(_) => GitDiffBlobContent::Unsupported("Binary diffs are not supported.".to_string()),
    }
}

fn read_diff_blob_git2(
    worktree_path: &Path,
    source: GitDiffBlobSource,
    relative_path: &str,
    max_bytes: u64,
) -> Result<GitDiffBlobContent, GitError> {
    let repo = open_repo(worktree_path)?;
    let relative_path = normalize_relative_git_path(relative_path).map_err(|_| GitError {
        message: format!("invalid relative git path: {relative_path}"),
    })?;
    let blob = match source {
        GitDiffBlobSource::Head => load_head_blob(&repo, &relative_path)?,
        GitDiffBlobSource::Index => load_index_blob(&repo, &relative_path)?,
    };
    Ok(diff_blob_content_from_blob(blob, max_bytes))
}

/// Load HEAD or index blob content for diff tabs without invoking the git CLI.
pub async fn read_diff_blob(
    worktree_path: &Path,
    source: GitDiffBlobSource,
    relative_path: &str,
    max_bytes: u64,
) -> Result<GitDiffBlobContent, GitError> {
    let worktree_path = worktree_path.to_path_buf();
    let relative_path = relative_path.to_string();
    tokio::task::spawn_blocking(move || {
        read_diff_blob_git2(&worktree_path, source, &relative_path, max_bytes)
    })
    .await
    .map_err(|_| GitError {
        message: "failed to join diff blob task".to_string(),
    })?
}

fn read_commit_diff_blob_git2(
    worktree_path: &Path,
    commit_id: &str,
    use_parent: bool,
    relative_path: &str,
    max_bytes: u64,
) -> Result<GitDiffBlobContent, GitCommitDiffError> {
    let repo = Repository::open(worktree_path).map_err(|_| GitCommitDiffError::Internal)?;
    let relative_path =
        normalize_relative_git_path(relative_path).map_err(|_| GitCommitDiffError::Internal)?;
    let commit = revparse_commit(&repo, commit_id).map_err(|error| match error {
        GitCommitDetailsError::NotFound => GitCommitDiffError::NotFound,
        GitCommitDetailsError::Internal => GitCommitDiffError::Internal,
    })?;
    if use_parent {
        if commit.parent_count() == 0 {
            return Ok(GitDiffBlobContent::Missing);
        }

        let parent = commit.parent(0).map_err(|_| GitCommitDiffError::Internal)?;
        let tree = parent.tree().map_err(|_| GitCommitDiffError::Internal)?;
        load_commit_tree_diff_content(&repo, &tree, &relative_path, max_bytes)
    } else {
        let tree = commit.tree().map_err(|_| GitCommitDiffError::Internal)?;
        load_commit_tree_diff_content(&repo, &tree, &relative_path, max_bytes)
    }
}

fn load_commit_tree_diff_content(
    repo: &Repository,
    tree: &git2::Tree<'_>,
    relative_path: &str,
    max_bytes: u64,
) -> Result<GitDiffBlobContent, GitCommitDiffError> {
    let entry = match tree.get_path(Path::new(relative_path)) {
        Ok(entry) => entry,
        Err(err) if err.code() == ErrorCode::NotFound => {
            return Ok(GitDiffBlobContent::Missing);
        }
        Err(_) => return Err(GitCommitDiffError::Internal),
    };

    match entry.kind() {
        Some(git2::ObjectType::Blob) => {
            let blob = repo
                .find_blob(entry.id())
                .map_err(|_| GitCommitDiffError::Internal)?;
            Ok(diff_blob_content_from_blob(Some(blob), max_bytes))
        }
        Some(git2::ObjectType::Commit) => Ok(GitDiffBlobContent::Unsupported(
            SUBMODULE_DIFF_UNSUPPORTED_REASON.to_string(),
        )),
        _ => Ok(GitDiffBlobContent::Missing),
    }
}

pub async fn read_commit_diff_blob(
    worktree_path: &Path,
    commit_id: &str,
    use_parent: bool,
    relative_path: &str,
    max_bytes: u64,
) -> Result<GitDiffBlobContent, GitCommitDiffError> {
    let worktree_path = worktree_path.to_path_buf();
    let commit_id = commit_id.to_string();
    let relative_path = relative_path.to_string();
    tokio::task::spawn_blocking(move || {
        read_commit_diff_blob_git2(
            &worktree_path,
            &commit_id,
            use_parent,
            &relative_path,
            max_bytes,
        )
    })
    .await
    .map_err(|_| GitCommitDiffError::Internal)?
}

fn revparse_commit<'repo>(
    repo: &'repo Repository,
    spec: &str,
) -> Result<git2::Commit<'repo>, GitCommitDetailsError> {
    repo.revparse_single(spec)
        .and_then(|object| object.peel_to_commit())
        .map_err(|err| match err.code() {
            ErrorCode::NotFound | ErrorCode::InvalidSpec => GitCommitDetailsError::NotFound,
            _ => GitCommitDetailsError::Internal,
        })
}

fn diff_options(include_untracked: bool, include_unmodified: bool) -> DiffOptions {
    let mut options = DiffOptions::new();
    options.include_typechange(true);
    if include_untracked {
        options.include_untracked(true).recurse_untracked_dirs(true);
    }
    if include_unmodified {
        options.include_unmodified(true);
    }
    options
}

fn diff_find_options(include_untracked: bool, copies_from_unmodified: bool) -> DiffFindOptions {
    let mut options = DiffFindOptions::new();
    options
        .renames(true)
        .renames_from_rewrites(true)
        .copies(true)
        .remove_unmodified(true);
    if include_untracked {
        options.for_untracked(true);
    }
    if copies_from_unmodified {
        options.copies_from_unmodified(true);
    }
    options
}

fn rename_only_diff_find_options() -> DiffFindOptions {
    let mut options = DiffFindOptions::new();
    options.renames(true).renames_from_rewrites(true);
    options
}

fn diff_file_is_tree(file: &git2::DiffFile<'_>) -> bool {
    file.exists() && file.mode() == FileMode::Tree
}

fn diff_path(path: Option<&Path>) -> Option<String> {
    path.map(path_to_string)
}

fn diff_display_path_from_paths(
    status: Delta,
    old_path: Option<&Path>,
    new_path: Option<&Path>,
) -> Option<String> {
    match status {
        Delta::Added | Delta::Untracked => diff_path(new_path),
        Delta::Deleted => diff_path(old_path),
        Delta::Modified | Delta::Typechange | Delta::Unreadable | Delta::Conflicted => {
            diff_path(new_path).or_else(|| diff_path(old_path))
        }
        Delta::Renamed | Delta::Copied => diff_path(new_path),
        Delta::Ignored | Delta::Unmodified => None,
    }
}

fn diff_display_path(
    status: Delta,
    old_file: &git2::DiffFile<'_>,
    new_file: &git2::DiffFile<'_>,
) -> Option<String> {
    diff_display_path_from_paths(status, old_file.path(), new_file.path())
}

fn diff_change_type(
    delta: Delta,
    old_file: &git2::DiffFile<'_>,
    new_file: &git2::DiffFile<'_>,
) -> Option<GitFileChangeType> {
    if diff_file_is_tree(old_file) || diff_file_is_tree(new_file) {
        return None;
    }

    Some(match delta {
        Delta::Added => GitFileChangeType::Added,
        Delta::Deleted => GitFileChangeType::Deleted,
        Delta::Modified | Delta::Unreadable => GitFileChangeType::Modified,
        Delta::Renamed => GitFileChangeType::Renamed,
        Delta::Copied => GitFileChangeType::Copied,
        Delta::Untracked => GitFileChangeType::Untracked,
        Delta::Typechange => GitFileChangeType::Typechange,
        Delta::Conflicted => GitFileChangeType::Conflict,
        Delta::Ignored | Delta::Unmodified => return None,
    })
}

fn map_diff_delta(delta: DiffDelta<'_>) -> Option<GitFileChange> {
    let old_file = delta.old_file();
    let new_file = delta.new_file();
    let change_type = diff_change_type(delta.status(), &old_file, &new_file)?;

    let (path, original_path) = match delta.status() {
        Delta::Added
        | Delta::Untracked
        | Delta::Deleted
        | Delta::Modified
        | Delta::Typechange
        | Delta::Unreadable
        | Delta::Conflicted => (
            diff_display_path(delta.status(), &old_file, &new_file)?,
            None,
        ),
        Delta::Renamed | Delta::Copied => (diff_path(new_file.path())?, diff_path(old_file.path())),
        Delta::Ignored | Delta::Unmodified => return None,
    };

    Some(GitFileChange {
        path,
        original_path,
        change_type,
        insertions: None,
        deletions: None,
    })
}

fn collect_diff_changes(diff: &git2::Diff<'_>) -> Vec<GitFileChange> {
    let mut changes = diff.deltas().filter_map(map_diff_delta).collect::<Vec<_>>();
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    changes
}

/// Maximum blob size (in bytes) for which we compute per-file line
/// stats. Larger files are skipped to bound diff computation cost.
const DIFF_STAT_MAX_BLOB_BYTES: u64 = 1_048_576; // 1 MB

/// Compute per-file (insertions, deletions) from a prepared diff.
///
/// Returns a map keyed by the same path that `map_diff_delta` would
/// assign to each delta, so callers can attach stats to the matching
/// `GitFileChange` entries.
fn compute_diff_line_stats(diff: &git2::Diff<'_>) -> HashMap<String, (usize, usize)> {
    let mut stats = HashMap::new();
    for idx in 0..diff.deltas().len() {
        let Some(delta) = diff.get_delta(idx) else {
            continue;
        };

        // Skip statuses where patch-based stats are irrelevant or
        // misleading. Untracked files are handled separately below via
        // attach_untracked_line_stats().
        match delta.status() {
            Delta::Conflicted
            | Delta::Ignored
            | Delta::Unmodified
            | Delta::Typechange
            | Delta::Untracked => continue,
            _ => {}
        }

        let old_file = delta.old_file();
        let new_file = delta.new_file();

        // Skip directory (tree) entries.
        if diff_file_is_tree(&old_file) || diff_file_is_tree(&new_file) {
            continue;
        }

        // Skip blobs exceeding the size limit.
        if old_file.size() > DIFF_STAT_MAX_BLOB_BYTES || new_file.size() > DIFF_STAT_MAX_BLOB_BYTES
        {
            continue;
        }

        // Skip binary files.
        if old_file.is_binary() || new_file.is_binary() {
            continue;
        }

        // Build a Patch to get line-level stats.
        let patch = match git2::Patch::from_diff(diff, idx) {
            Ok(Some(p)) => p,
            Ok(None) => continue, // binary
            Err(_) => continue,   // graceful degradation
        };

        let (_context, additions, deletions) = match patch.line_stats() {
            Ok(s) => s,
            Err(_) => continue,
        };

        // Key by the same path logic as map_diff_delta.
        let key = match delta.status() {
            Delta::Renamed | Delta::Copied => diff_path(new_file.path()),
            status => diff_display_path(status, &old_file, &new_file),
        };

        if let Some(key) = key {
            stats.insert(key, (additions, deletions));
        }
    }
    stats
}

fn count_lines(bytes: &[u8]) -> usize {
    if bytes.is_empty() {
        return 0;
    }

    let newline_count = bytes.iter().filter(|&&byte| byte == b'\n').count();
    if bytes.last() == Some(&b'\n') {
        newline_count
    } else {
        newline_count + 1
    }
}

fn read_untracked_file_line_stats(path: &Path) -> Option<(usize, usize)> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    let file_type = metadata.file_type();
    if file_type.is_symlink() || !file_type.is_file() {
        return None;
    }
    if metadata.len() > DIFF_STAT_MAX_BLOB_BYTES {
        return None;
    }

    let bytes = std::fs::read(path).ok()?;
    if bytes.contains(&0) {
        return None;
    }

    Some((count_lines(&bytes), 0))
}

fn attach_untracked_line_stats(changes: &mut [GitFileChange], worktree_path: &Path) {
    for change in changes.iter_mut() {
        if change.change_type != GitFileChangeType::Untracked {
            continue;
        }

        let Some((insertions, deletions)) =
            read_untracked_file_line_stats(&worktree_path.join(&change.path))
        else {
            continue;
        };
        change.insertions = Some(insertions);
        change.deletions = Some(deletions);
    }
}

/// Attach precomputed line stats to the matching `GitFileChange`
/// entries. Typechange, untracked, and conflicted entries are
/// intentionally left without stats here.
fn attach_line_stats(changes: &mut [GitFileChange], stats: &HashMap<String, (usize, usize)>) {
    for change in changes.iter_mut() {
        if matches!(
            change.change_type,
            GitFileChangeType::Typechange
                | GitFileChangeType::Untracked
                | GitFileChangeType::Conflict
        ) {
            continue;
        }
        if let Some(&(ins, del)) = stats.get(&change.path) {
            change.insertions = Some(ins);
            change.deletions = Some(del);
        }
    }
}

fn read_commit_details_git2(
    worktree_path: &Path,
    commit_id: &str,
) -> Result<GitCommitDetails, GitCommitDetailsError> {
    let repo = Repository::open(worktree_path).map_err(|_| GitCommitDetailsError::Internal)?;
    let commit = revparse_commit(&repo, commit_id)?;
    let short_id =
        abbreviate_oid(&repo, commit.id()).map_err(|_| GitCommitDetailsError::Internal)?;
    let summary = commit.summary().unwrap_or_default().trim().to_string();
    let message =
        trim_trailing_newlines(String::from_utf8_lossy(commit.message_raw_bytes()).into_owned());
    let author = map_commit_person(commit.author());
    let committer = map_commit_person(commit.committer());
    let old_tree = if commit.parent_count() > 0 {
        let parent = commit
            .parent(0)
            .map_err(|_| GitCommitDetailsError::Internal)?;
        Some(parent.tree().map_err(|_| GitCommitDetailsError::Internal)?)
    } else {
        None
    };
    let new_tree = commit.tree().map_err(|_| GitCommitDetailsError::Internal)?;
    let mut options = diff_options(false, false);
    let mut diff = repo
        .diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), Some(&mut options))
        .map_err(|_| GitCommitDetailsError::Internal)?;
    let mut find_options = rename_only_diff_find_options();
    diff.find_similar(Some(&mut find_options))
        .map_err(|_| GitCommitDetailsError::Internal)?;
    let files = collect_diff_changes(&diff);

    Ok(GitCommitDetails {
        id: commit.id().to_string(),
        short_id,
        summary,
        message,
        author,
        committer,
        files,
    })
}

pub async fn read_commit_details(
    worktree_path: &Path,
    commit_id: &str,
) -> Result<GitCommitDetails, GitCommitDetailsError> {
    let worktree_path = worktree_path.to_path_buf();
    let commit_id = commit_id.to_string();
    tokio::task::spawn_blocking(move || read_commit_details_git2(&worktree_path, &commit_id))
        .await
        .map_err(|_| GitCommitDetailsError::Internal)?
}

fn read_staged_files(repo: &Repository) -> Result<Vec<GitFileChange>, GitError> {
    let index = repo.index().map_err(to_git_error)?;
    let old_tree = head_tree(repo)?;
    let mut options = diff_options(false, true);
    let mut diff = repo
        .diff_tree_to_index(old_tree.as_ref(), Some(&index), Some(&mut options))
        .map_err(to_git_error)?;
    let mut find_options = diff_find_options(false, true);
    diff.find_similar(Some(&mut find_options))
        .map_err(to_git_error)?;
    let stats = compute_diff_line_stats(&diff);
    let mut changes = collect_diff_changes(&diff);
    attach_line_stats(&mut changes, &stats);
    Ok(changes)
}

fn read_unstaged_files(repo: &Repository) -> Result<Vec<GitFileChange>, GitError> {
    let index = repo.index().map_err(to_git_error)?;
    let mut options = diff_options(true, false);
    let mut diff = repo
        .diff_index_to_workdir(Some(&index), Some(&mut options))
        .map_err(to_git_error)?;
    let mut find_options = diff_find_options(true, false);
    diff.find_similar(Some(&mut find_options))
        .map_err(to_git_error)?;
    let stats = compute_diff_line_stats(&diff);
    let mut changes = collect_diff_changes(&diff);
    attach_line_stats(&mut changes, &stats);
    if let Some(worktree_path) = repo.workdir() {
        attach_untracked_line_stats(&mut changes, worktree_path);
    }
    Ok(changes)
}

fn commit_summary(
    repo: &Repository,
    commit: &git2::Commit<'_>,
) -> Result<GitCommitSummary, GitError> {
    Ok(GitCommitSummary {
        id: commit.id().to_string(),
        short_id: abbreviate_oid(repo, commit.id())?,
        summary: commit
            .summary()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .unwrap_or("(no commit message)")
            .to_string(),
    })
}

fn read_ahead_commits(
    repo: &Repository,
    source_ref: Option<&str>,
) -> Result<(usize, Vec<GitCommitSummary>, bool, Option<String>), GitError> {
    let Some(source_ref) = source_ref else {
        return Ok((0, Vec::new(), false, None));
    };

    let head = repo.head().map_err(to_git_error)?;
    let head_oid = head.target().ok_or_else(|| GitError {
        message: "HEAD does not point to a commit".to_string(),
    })?;
    let source_oid = match repo.revparse_single(source_ref) {
        Ok(object) => object.id(),
        Err(err) => {
            return Ok((0, Vec::new(), true, Some(err.to_string())));
        }
    };

    let (ahead_count, _) = repo
        .graph_ahead_behind(head_oid, source_oid)
        .map_err(to_git_error)?;
    let mut walk = repo.revwalk().map_err(to_git_error)?;
    walk.set_sorting(Sort::TIME).map_err(to_git_error)?;
    walk.push(head_oid).map_err(to_git_error)?;
    walk.hide(source_oid).map_err(to_git_error)?;

    let mut ahead_commits = Vec::new();
    for oid in walk.take(100) {
        let oid = oid.map_err(to_git_error)?;
        let commit = repo.find_commit(oid).map_err(to_git_error)?;
        ahead_commits.push(commit_summary(repo, &commit)?);
    }

    Ok((ahead_count, ahead_commits, true, None))
}

pub fn worktree_id(path: &Path) -> String {
    Uuid::new_v5(&WORKTREE_NAMESPACE, path.to_string_lossy().as_bytes()).to_string()
}

pub fn resolve_git_metadata_watch_paths(worktree_path: &Path) -> Result<Vec<PathBuf>, GitError> {
    let repo = discover_repo(worktree_path)?;
    let mut paths = BTreeSet::new();
    for path in [repo.path().to_path_buf(), repo.commondir().to_path_buf()] {
        paths.insert(canonicalize_or(&path));
    }
    Ok(paths.into_iter().collect())
}

fn resolve_local_root_git2(path: &Path) -> Result<PathBuf, GitError> {
    let repo = discover_repo(path)?;
    if let Some(workdir) = repo.workdir() {
        return Ok(canonicalize_or(workdir));
    }

    let common_dir = repo.commondir();
    if common_dir
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == ".git")
        && let Some(parent) = common_dir.parent()
    {
        return Ok(canonicalize_or(parent));
    }

    Ok(canonicalize_or(repo.path()))
}

pub async fn resolve_local_root(path: &Path) -> Result<PathBuf, GitError> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || resolve_local_root_git2(&path))
        .await
        .map_err(|_| GitError {
            message: "failed to join git root task".to_string(),
        })?
}

fn list_worktrees_git2(local_root: &Path) -> Result<Vec<GitWorktree>, GitError> {
    let repo = open_repo(local_root)?;
    let local_path = repo
        .workdir()
        .map(canonicalize_or)
        .unwrap_or_else(|| local_root.to_path_buf());
    let mut worktrees = vec![GitWorktree {
        path: local_path,
        branch: short_head_name(&repo)?,
    }];

    let mut linked = Vec::new();
    let names = repo.worktrees().map_err(to_git_error)?;
    for name in names.iter().flatten() {
        let worktree = repo.find_worktree(name).map_err(to_git_error)?;
        let path = canonicalize_or(worktree.path());
        let branch = Repository::open_from_worktree(&worktree)
            .ok()
            .and_then(|repo| short_head_name(&repo).ok())
            .flatten();
        linked.push(GitWorktree { path, branch });
    }

    linked.sort_by(|a, b| a.path.cmp(&b.path));
    worktrees.extend(linked);
    Ok(worktrees)
}

pub async fn list_worktrees(local_root: &Path) -> Result<Vec<GitWorktree>, GitError> {
    let local_root = local_root.to_path_buf();
    tokio::task::spawn_blocking(move || list_worktrees_git2(&local_root))
        .await
        .map_err(|_| GitError {
            message: "failed to join worktree list task".to_string(),
        })?
}

fn peel_start_point<'repo>(
    repo: &'repo Repository,
    start_point: Option<&str>,
) -> Result<git2::Commit<'repo>, GitError> {
    match start_point {
        Some(start_point) => repo
            .revparse_single(start_point)
            .and_then(|object| object.peel_to_commit())
            .map_err(to_git_error),
        None => repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .map_err(to_git_error),
    }
}

fn worktree_name_from_target_path(target_path: &Path) -> Result<String, GitError> {
    let Some(file_name) = target_path.file_name() else {
        return Err(GitError {
            message: format!("invalid worktree target path: {}", target_path.display()),
        });
    };

    Ok(format!(
        "{}-{}",
        file_name.to_string_lossy(),
        &worktree_id(target_path)[..8]
    ))
}

fn create_worktree_git2(
    local_root: &Path,
    branch: &str,
    target_path: &Path,
    start_point: Option<&str>,
) -> Result<(), GitError> {
    let repo = open_repo(local_root)?;
    let target_commit = peel_start_point(&repo, start_point)?;
    let worktree_name = worktree_name_from_target_path(target_path)?;
    let created_branch = repo
        .branch(branch, &target_commit, false)
        .map_err(to_git_error)?;
    let reference = created_branch.into_reference();
    let mut options = WorktreeAddOptions::new();
    options.reference(Some(&reference));

    if let Err(err) = repo.worktree(&worktree_name, target_path, Some(&options)) {
        if let Ok(mut created_branch) = repo.find_branch(branch, BranchType::Local) {
            let _ = created_branch.get_mut().delete();
        }
        return Err(to_git_error(err));
    }

    Ok(())
}

pub async fn create_worktree(
    local_root: &Path,
    branch: &str,
    target_path: &Path,
    start_point: Option<&str>,
) -> Result<(), GitError> {
    if let Some(parent) = target_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| GitError {
                message: format!("failed to create parent directories: {e}"),
            })?;
    }

    let local_root = local_root.to_path_buf();
    let branch = branch.to_string();
    let target_path = target_path.to_path_buf();
    let start_point = start_point.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        create_worktree_git2(&local_root, &branch, &target_path, start_point.as_deref())
    })
    .await
    .map_err(|_| GitError {
        message: "failed to join create worktree task".to_string(),
    })?
}

fn rename_branch_git2(worktree_path: &Path, new_name: &str) -> Result<String, GitError> {
    let repo = open_repo(worktree_path)?;
    if repo.head_detached().map_err(to_git_error)? {
        return Err(GitError {
            message: "HEAD is detached".to_string(),
        });
    }
    let head = repo.head().map_err(to_git_error)?;
    let current_branch_name = head
        .shorthand()
        .ok_or_else(|| GitError {
            message: "could not determine current branch name".to_string(),
        })?
        .to_string();
    let mut branch = repo
        .find_branch(&current_branch_name, BranchType::Local)
        .map_err(to_git_error)?;
    branch.rename(new_name, false).map_err(to_git_error)?;
    Ok(new_name.to_string())
}

pub async fn rename_branch(worktree_path: &Path, new_name: &str) -> Result<String, GitError> {
    let worktree_path = worktree_path.to_path_buf();
    let new_name = new_name.to_string();
    tokio::task::spawn_blocking(move || rename_branch_git2(&worktree_path, &new_name))
        .await
        .map_err(|_| GitError {
            message: "failed to join rename branch task".to_string(),
        })?
}

fn commit_timestamp_for_reference(
    reference: &Reference<'_>,
) -> Result<(String, String, i64), GitError> {
    let commit = reference.peel_to_commit().map_err(to_git_error)?;
    Ok((
        reference_display_name(reference),
        commit.id().to_string(),
        commit.time().seconds(),
    ))
}

fn list_branch_start_points_git2(local_root: &Path) -> Result<Vec<GitStartPoint>, GitError> {
    let repo = open_repo(local_root)?;
    let mut seen = HashSet::new();
    let mut start_points = Vec::new();

    for branch_type in [BranchType::Local, BranchType::Remote] {
        let branches = repo.branches(Some(branch_type)).map_err(to_git_error)?;
        for branch in branches {
            let (branch, branch_kind) = branch.map_err(to_git_error)?;
            let name = reference_display_name(branch.get());
            if name.is_empty()
                || matches!(branch_kind, BranchType::Remote)
                    && branch.get().shorthand_bytes().ends_with(b"/HEAD")
                || !seen.insert(name.clone())
            {
                continue;
            }

            let (name, sha, commit_timestamp) = commit_timestamp_for_reference(branch.get())?;
            start_points.push(GitStartPoint {
                name,
                kind: match branch_kind {
                    BranchType::Local => GitStartPointKind::Local,
                    BranchType::Remote => GitStartPointKind::Remote,
                },
                sha,
                commit_timestamp,
            });
        }
    }

    start_points.sort_by(|a, b| {
        b.commit_timestamp
            .cmp(&a.commit_timestamp)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.kind.cmp(&b.kind))
    });
    Ok(start_points)
}

pub async fn list_branch_start_points(local_root: &Path) -> Result<Vec<GitStartPoint>, GitError> {
    let local_root = local_root.to_path_buf();
    tokio::task::spawn_blocking(move || list_branch_start_points_git2(&local_root))
        .await
        .map_err(|_| GitError {
            message: "failed to join branch start points task".to_string(),
        })?
}

fn current_branch_git2(local_root: &Path) -> Result<Option<String>, GitError> {
    let repo = open_repo(local_root)?;
    short_head_name(&repo)
}

pub async fn current_branch(local_root: &Path) -> Result<Option<String>, GitError> {
    let local_root = local_root.to_path_buf();
    tokio::task::spawn_blocking(move || current_branch_git2(&local_root))
        .await
        .map_err(|_| GitError {
            message: "failed to join current branch task".to_string(),
        })?
}

fn find_worktree_by_path(
    repo: &Repository,
    worktree_path: &Path,
) -> Result<git2::Worktree, GitError> {
    let target = canonicalize_or(worktree_path);
    let names = repo.worktrees().map_err(to_git_error)?;
    for name in names.iter().flatten() {
        let worktree = repo.find_worktree(name).map_err(to_git_error)?;
        if canonicalize_or(worktree.path()) == target {
            return Ok(worktree);
        }
    }

    Err(GitError {
        message: "worktree not found".to_string(),
    })
}

fn remove_worktree_git2(
    local_root: &Path,
    worktree_path: &Path,
    force: bool,
) -> Result<(), GitError> {
    let repo = open_repo(local_root)?;
    if !force {
        let status = read_worktree_status(worktree_path, None)?;
        if !status.unstaged_files.is_empty() || !status.staged_files.is_empty() {
            return Err(GitError {
                message: "worktree has uncommitted changes".to_string(),
            });
        }
    }
    let worktree = find_worktree_by_path(&repo, worktree_path)?;
    if !force
        && !matches!(
            worktree.is_locked().map_err(to_git_error)?,
            WorktreeLockStatus::Unlocked
        )
    {
        return Err(GitError {
            message: "worktree is locked".to_string(),
        });
    }
    let mut options = WorktreePruneOptions::new();
    options.valid(true).working_tree(true);
    if force {
        options.locked(true);
    }
    worktree.prune(Some(&mut options)).map_err(to_git_error)
}

pub async fn remove_worktree(
    local_root: &Path,
    worktree_path: &Path,
    force: bool,
) -> Result<(), GitError> {
    let local_root = local_root.to_path_buf();
    let worktree_path = worktree_path.to_path_buf();
    tokio::task::spawn_blocking(move || remove_worktree_git2(&local_root, &worktree_path, force))
        .await
        .map_err(|_| GitError {
            message: "failed to join remove worktree task".to_string(),
        })?
}

fn stage_worktree_path_git2(
    worktree_path: &Path,
    relative_path: &str,
    original_path: Option<&str>,
) -> Result<Vec<String>, GitPathActionError> {
    let repo = open_repo(worktree_path).map_err(map_git_path_error)?;
    let paths = normalized_git_action_paths(relative_path, original_path)?;
    let mut index = repo.index().map_err(map_git2_path_error)?;

    for path in &paths {
        let current_entries = matching_index_entries(&index, path);
        let worktree_paths = collect_worktree_paths(worktree_path, path)?;

        if target_is_directory(worktree_path, path, &current_entries, &[]) {
            let current_paths = current_entries
                .iter()
                .map(|entry| bytes_to_string(&entry.path))
                .collect::<HashSet<_>>();
            let worktree_paths_set = worktree_paths.iter().cloned().collect::<HashSet<_>>();

            for current_path in current_paths.difference(&worktree_paths_set) {
                remove_index_path(&mut index, current_path)?;
            }

            for worktree_path in worktree_paths {
                let path = Path::new(&worktree_path);
                let tracked = index.get_path(path, 0).is_some();
                if !tracked && repo.is_path_ignored(path).map_err(map_git2_path_error)? {
                    continue;
                }
                index.add_path(path).map_err(map_git2_path_error)?;
            }
            continue;
        }

        if let Some(worktree_path) = worktree_paths.first() {
            let path = Path::new(worktree_path);
            let tracked = index.get_path(path, 0).is_some();
            if !tracked && repo.is_path_ignored(path).map_err(map_git2_path_error)? {
                continue;
            }
            index.add_path(path).map_err(map_git2_path_error)?;
        } else {
            remove_index_path(&mut index, path)?;
        }
    }

    index.write().map_err(map_git2_path_error)?;
    Ok(invalidated_parent_paths(&paths))
}

pub async fn stage_worktree_path(
    worktree_path: &Path,
    relative_path: &str,
    original_path: Option<&str>,
) -> Result<Vec<String>, GitPathActionError> {
    let worktree_path = worktree_path.to_path_buf();
    let relative_path = relative_path.to_string();
    let original_path = original_path.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        stage_worktree_path_git2(&worktree_path, &relative_path, original_path.as_deref())
    })
    .await
    .map_err(|_| GitPathActionError::Internal)?
}

fn unstage_worktree_path_git2(
    worktree_path: &Path,
    relative_path: &str,
    original_path: Option<&str>,
) -> Result<Vec<String>, GitPathActionError> {
    let repo = open_repo(worktree_path).map_err(map_git_path_error)?;
    let paths = normalized_git_action_paths(relative_path, original_path)?;
    let mut index = repo.index().map_err(map_git2_path_error)?;
    let head_index = match repo.head() {
        Ok(head) => {
            let commit = head.peel_to_commit().map_err(map_git2_path_error)?;
            let tree = commit.tree().map_err(map_git2_path_error)?;
            let mut head_index = git2::Index::new().map_err(map_git2_path_error)?;
            head_index.read_tree(&tree).map_err(map_git2_path_error)?;
            Some(head_index)
        }
        Err(err) if is_unborn_or_missing_head(&err) => None,
        Err(err) => return Err(map_git2_path_error(err)),
    };

    for path in &paths {
        let current_entries = matching_index_entries(&index, path);
        let head_entries = head_index
            .as_ref()
            .map(|head_index| matching_index_entries(head_index, path))
            .unwrap_or_default();

        if target_is_directory(worktree_path, path, &current_entries, &head_entries) {
            match index.remove_dir(Path::new(path), 0) {
                Ok(()) => {}
                Err(err) if err.code() == ErrorCode::NotFound => {}
                Err(err) => return Err(map_git2_path_error(err)),
            }
            for entry in head_entries {
                index.add(&entry).map_err(map_git2_path_error)?;
            }
            continue;
        }

        if let Some(entry) = head_entries
            .into_iter()
            .find(|entry| entry.path == path.as_bytes())
        {
            index.add(&entry).map_err(map_git2_path_error)?;
        } else {
            remove_index_path(&mut index, path)?;
        }
    }

    index.write().map_err(map_git2_path_error)?;
    Ok(invalidated_parent_paths(&paths))
}

pub async fn unstage_worktree_path(
    worktree_path: &Path,
    relative_path: &str,
    original_path: Option<&str>,
) -> Result<Vec<String>, GitPathActionError> {
    let worktree_path = worktree_path.to_path_buf();
    let relative_path = relative_path.to_string();
    let original_path = original_path.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        unstage_worktree_path_git2(&worktree_path, &relative_path, original_path.as_deref())
    })
    .await
    .map_err(|_| GitPathActionError::Internal)?
}

fn status_entry_old_new_paths(entry: &StatusEntry<'_>) -> (Option<String>, Option<String>) {
    if let Some(delta) = entry.index_to_workdir() {
        return (
            diff_path(delta.old_file().path()),
            diff_path(delta.new_file().path()),
        );
    }
    let path = entry.path().map(str::to_string);
    (path.clone(), path)
}

fn remove_untracked_path(path: &Path) -> Result<(), GitPathActionError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.is_dir() {
                std::fs::remove_dir_all(path).map_err(|error| match error.kind() {
                    std::io::ErrorKind::NotFound => GitPathActionError::NotFound,
                    std::io::ErrorKind::PermissionDenied => GitPathActionError::PermissionDenied,
                    _ => GitPathActionError::Internal,
                })
            } else {
                std::fs::remove_file(path).map_err(|error| match error.kind() {
                    std::io::ErrorKind::NotFound => GitPathActionError::NotFound,
                    std::io::ErrorKind::PermissionDenied => GitPathActionError::PermissionDenied,
                    _ => GitPathActionError::Internal,
                })
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            Err(GitPathActionError::PermissionDenied)
        }
        Err(_) => Err(GitPathActionError::Internal),
    }
}

fn prune_empty_parent_dirs(
    worktree_path: &Path,
    request_path: &str,
    cleaned_paths: &[String],
) -> Result<(), GitPathActionError> {
    let request_root = worktree_path.join(request_path);

    for cleaned_path in cleaned_paths {
        let cleaned_abs = worktree_path.join(cleaned_path);
        let mut current = if cleaned_abs.is_dir() {
            cleaned_abs
        } else {
            match cleaned_abs.parent() {
                Some(parent) => parent.to_path_buf(),
                None => continue,
            }
        };

        loop {
            if !current.starts_with(&request_root) || current == worktree_path {
                break;
            }

            match std::fs::remove_dir(&current) {
                Ok(()) => {
                    if current == request_root {
                        break;
                    }
                    let Some(parent) = current.parent() else {
                        break;
                    };
                    current = parent.to_path_buf();
                }
                Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => break,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                    return Err(GitPathActionError::PermissionDenied);
                }
                Err(_) => return Err(GitPathActionError::Internal),
            }
        }
    }

    Ok(())
}

fn discard_worktree_path_git2(
    worktree_path: &Path,
    relative_path: &str,
) -> Result<Vec<String>, GitPathActionError> {
    let repo = open_repo(worktree_path).map_err(map_git_path_error)?;
    let relative_path = normalize_relative_git_path(relative_path)?;
    let mut status_options = git2::StatusOptions::new();
    status_options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_index_to_workdir(true)
        .renames_from_rewrites(true)
        .disable_pathspec_match(true)
        .pathspec(&relative_path);
    let statuses = repo
        .statuses(Some(&mut status_options))
        .map_err(map_git2_path_error)?;

    let mut restore_paths = BTreeSet::new();
    let mut clean_paths = BTreeSet::new();
    let mut invalidated_paths = BTreeSet::from([relative_path.clone()]);

    for entry in &statuses {
        let status = entry.status();
        if status.contains(Status::CONFLICTED) {
            return Err(GitPathActionError::Conflict);
        }

        let (old_path, new_path) = status_entry_old_new_paths(&entry);
        if let Some(old_path) = old_path.as_ref() {
            invalidated_paths.insert(old_path.clone());
        }
        if let Some(new_path) = new_path.clone() {
            invalidated_paths.insert(new_path);
        }

        if status.contains(Status::WT_RENAMED) {
            if let Some(old_path) = old_path {
                restore_paths.insert(old_path);
            }
            if let Some(new_path) = new_path {
                clean_paths.insert(new_path);
            }
            continue;
        }

        if status.contains(Status::WT_NEW) {
            if let Some(new_path) = new_path.or(old_path) {
                clean_paths.insert(new_path);
            }
            continue;
        }

        if status.intersects(
            Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_TYPECHANGE
                | Status::WT_UNREADABLE,
        ) && let Some(path) = new_path.or(old_path)
        {
            restore_paths.insert(path);
        }
    }

    if restore_paths.is_empty() && clean_paths.is_empty() {
        let candidate = worktree_path.join(&relative_path);
        if !candidate.exists() {
            return Err(GitPathActionError::NotFound);
        }
        if candidate.is_dir() {
            remove_untracked_path(&candidate)?;
        }
        return Ok(invalidated_parent_paths(&invalidated_paths));
    }

    if !restore_paths.is_empty() {
        let mut checkout = CheckoutBuilder::new();
        checkout.force().disable_pathspec_match(true);
        for path in &restore_paths {
            checkout.path(path);
        }
        repo.checkout_index(None, Some(&mut checkout))
            .map_err(map_git2_path_error)?;
    }

    if !clean_paths.is_empty() {
        let cleaned_paths = clean_paths.iter().cloned().collect::<Vec<_>>();
        for path in &cleaned_paths {
            remove_untracked_path(&worktree_path.join(path))?;
        }
        prune_empty_parent_dirs(worktree_path, &relative_path, &cleaned_paths)?;
    }

    Ok(invalidated_parent_paths(&invalidated_paths))
}

pub async fn discard_worktree_path(
    worktree_path: &Path,
    relative_path: &str,
) -> Result<Vec<String>, GitPathActionError> {
    let worktree_path = worktree_path.to_path_buf();
    let relative_path = relative_path.to_string();
    tokio::task::spawn_blocking(move || discard_worktree_path_git2(&worktree_path, &relative_path))
        .await
        .map_err(|_| GitPathActionError::Internal)?
}

pub fn read_worktree_status(
    worktree_path: &Path,
    source_ref: Option<&str>,
) -> Result<WorktreeGitStatus, GitError> {
    let repo = open_repo(worktree_path)?;
    let unstaged_files = read_unstaged_files(&repo)?;
    let staged_files = read_staged_files(&repo)?;
    let (ahead_count, ahead_commits, comparison_available, comparison_error) =
        read_ahead_commits(&repo, source_ref)?;

    Ok(WorktreeGitStatus {
        unstaged_files,
        staged_files,
        ahead_count,
        ahead_commits,
        comparison_available,
        comparison_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn run_git(repo_path: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(repo_path)
            .arg("-c")
            .arg("commit.gpgsign=false")
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git failed: {:?}", args);
    }

    #[test]
    fn test_worktree_id_is_stable() {
        let path = Path::new("/tmp/repo");
        assert_eq!(worktree_id(path), worktree_id(path));
    }

    #[test]
    fn decode_ref_name_lossily_decodes_non_utf8_bytes() {
        assert_eq!(
            decode_ref_name(b"weird-\xff-branch"),
            "weird-\u{fffd}-branch"
        );
    }

    #[test]
    fn format_diff_size_limit_uses_human_readable_units() {
        assert_eq!(format_diff_size_limit(1024), "1 KiB");
        assert_eq!(format_diff_size_limit(2 * 1024 * 1024), "2 MiB");
        assert_eq!(format_diff_size_limit(123), "123 bytes");
    }

    #[test]
    fn resolve_git_metadata_watch_paths_dedupes_local_repo_paths() {
        let repo = tempfile::TempDir::new().unwrap();
        run_git(repo.path(), &["init", "-q"]);
        run_git(repo.path(), &["config", "user.email", "test@example.com"]);
        run_git(repo.path(), &["config", "user.name", "Hubris Test"]);

        let paths = resolve_git_metadata_watch_paths(repo.path()).unwrap();

        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with(".git"));
    }

    #[test]
    fn list_worktrees_reports_detached_linked_branch_as_none() {
        let repo = tempfile::TempDir::new().unwrap();
        run_git(repo.path(), &["init", "-q"]);
        run_git(repo.path(), &["config", "user.email", "test@example.com"]);
        run_git(repo.path(), &["config", "user.name", "Hubris Test"]);
        std::fs::write(repo.path().join("README.md"), "hello\n").unwrap();
        run_git(repo.path(), &["add", "README.md"]);
        run_git(repo.path(), &["commit", "-q", "-m", "init"]);
        run_git(repo.path(), &["branch", "-M", "main"]);

        let worktree_root = tempfile::TempDir::new().unwrap();
        let worktree_path = worktree_root.path().join("detached-worktree");
        let worktree_path_str = worktree_path.to_string_lossy().to_string();
        run_git(
            repo.path(),
            &[
                "worktree",
                "add",
                "-b",
                "detached-branch",
                &worktree_path_str,
            ],
        );
        run_git(&worktree_path, &["checkout", "--detach", "HEAD"]);
        let worktree_path = std::fs::canonicalize(worktree_path).unwrap();

        let worktrees = tokio_test::block_on(list_worktrees(repo.path())).unwrap();
        let detached = worktrees
            .iter()
            .find(|worktree| worktree.path == worktree_path)
            .unwrap();
        assert_eq!(detached.branch, None);
    }

    #[test]
    fn resolve_local_root_uses_linked_worktree_checkout() {
        let repo = tempfile::TempDir::new().unwrap();
        run_git(repo.path(), &["init", "-q"]);
        run_git(repo.path(), &["config", "user.email", "test@example.com"]);
        run_git(repo.path(), &["config", "user.name", "Hubris Test"]);
        std::fs::write(repo.path().join("README.md"), "hello\n").unwrap();
        run_git(repo.path(), &["add", "README.md"]);
        run_git(repo.path(), &["commit", "-q", "-m", "init"]);
        run_git(repo.path(), &["branch", "-M", "main"]);

        let worktree_root = tempfile::TempDir::new().unwrap();
        let worktree_path = worktree_root.path().join("linked-worktree");
        let worktree_path_str = worktree_path.to_string_lossy().to_string();
        run_git(
            repo.path(),
            &["worktree", "add", "-b", "feature", &worktree_path_str],
        );

        let resolved = resolve_local_root_git2(&worktree_path).unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&worktree_path).unwrap());
    }

    #[test]
    fn test_line_stats_new_file() {
        let repo = tempfile::TempDir::new().unwrap();
        run_git(repo.path(), &["init", "-q"]);
        run_git(repo.path(), &["config", "user.email", "test@example.com"]);
        run_git(repo.path(), &["config", "user.name", "Hubris Test"]);

        // Write a 3-line file without committing — it's untracked.
        std::fs::write(repo.path().join("new.txt"), "a\nb\nc\n").unwrap();

        let git_repo = Repository::open(repo.path()).unwrap();
        let unstaged = read_unstaged_files(&git_repo).unwrap();
        let file = unstaged.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(file.insertions, Some(3));
        assert_eq!(file.deletions, Some(0));
    }

    #[test]
    fn test_line_stats_modified_file() {
        let repo = tempfile::TempDir::new().unwrap();
        run_git(repo.path(), &["init", "-q"]);
        run_git(repo.path(), &["config", "user.email", "test@example.com"]);
        run_git(repo.path(), &["config", "user.name", "Hubris Test"]);

        // Commit a file, then modify it.
        std::fs::write(repo.path().join("file.txt"), "line1\nline2\nline3\n").unwrap();
        run_git(repo.path(), &["add", "file.txt"]);
        run_git(repo.path(), &["commit", "-q", "-m", "initial"]);

        // Remove line2, add two new lines.
        std::fs::write(repo.path().join("file.txt"), "line1\nline3\nnew1\nnew2\n").unwrap();

        let git_repo = Repository::open(repo.path()).unwrap();
        let unstaged = read_unstaged_files(&git_repo).unwrap();
        let file = unstaged.iter().find(|f| f.path == "file.txt").unwrap();
        assert_eq!(file.insertions, Some(2));
        assert_eq!(file.deletions, Some(1));
    }

    #[test]
    fn test_line_stats_rename_no_changes() {
        let repo = tempfile::TempDir::new().unwrap();
        run_git(repo.path(), &["init", "-q"]);
        run_git(repo.path(), &["config", "user.email", "test@example.com"]);
        run_git(repo.path(), &["config", "user.name", "Hubris Test"]);

        // Commit a file, then rename it (staged).
        std::fs::write(repo.path().join("old.txt"), "content\n").unwrap();
        run_git(repo.path(), &["add", "old.txt"]);
        run_git(repo.path(), &["commit", "-q", "-m", "initial"]);
        run_git(repo.path(), &["mv", "old.txt", "new.txt"]);

        let git_repo = Repository::open(repo.path()).unwrap();
        let staged = read_staged_files(&git_repo).unwrap();
        let file = staged.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(file.change_type, GitFileChangeType::Renamed);
        assert_eq!(file.insertions, Some(0));
        assert_eq!(file.deletions, Some(0));
    }

    #[test]
    fn diff_display_path_uses_old_path_fallback_for_modified() {
        let path = Path::new("fallback.txt");
        assert_eq!(
            diff_display_path_from_paths(Delta::Modified, Some(path), None),
            Some("fallback.txt".to_string())
        );
    }

    #[test]
    fn diff_display_path_uses_old_path_fallback_for_unreadable() {
        let path = Path::new("fallback.txt");
        assert_eq!(
            diff_display_path_from_paths(Delta::Unreadable, Some(path), None),
            Some("fallback.txt".to_string())
        );
    }

    #[test]
    fn test_line_stats_empty_untracked_file() {
        let repo = tempfile::TempDir::new().unwrap();
        run_git(repo.path(), &["init", "-q"]);
        run_git(repo.path(), &["config", "user.email", "test@example.com"]);
        run_git(repo.path(), &["config", "user.name", "Hubris Test"]);

        std::fs::write(repo.path().join("empty.txt"), b"").unwrap();

        let git_repo = Repository::open(repo.path()).unwrap();
        let unstaged = read_unstaged_files(&git_repo).unwrap();
        let file = unstaged.iter().find(|f| f.path == "empty.txt").unwrap();
        assert_eq!(file.insertions, Some(0));
        assert_eq!(file.deletions, Some(0));
    }

    #[test]
    fn test_line_stats_untracked_file_without_trailing_newline() {
        let repo = tempfile::TempDir::new().unwrap();
        run_git(repo.path(), &["init", "-q"]);
        run_git(repo.path(), &["config", "user.email", "test@example.com"]);
        run_git(repo.path(), &["config", "user.name", "Hubris Test"]);

        std::fs::write(repo.path().join("notes.txt"), "a\nb\nc").unwrap();

        let git_repo = Repository::open(repo.path()).unwrap();
        let unstaged = read_unstaged_files(&git_repo).unwrap();
        let file = unstaged.iter().find(|f| f.path == "notes.txt").unwrap();
        assert_eq!(file.insertions, Some(3));
        assert_eq!(file.deletions, Some(0));
    }

    #[test]
    fn test_line_stats_binary_untracked_file_are_skipped() {
        let repo = tempfile::TempDir::new().unwrap();
        run_git(repo.path(), &["init", "-q"]);
        run_git(repo.path(), &["config", "user.email", "test@example.com"]);
        run_git(repo.path(), &["config", "user.name", "Hubris Test"]);

        std::fs::write(repo.path().join("image.bin"), b"abc\0def").unwrap();

        let git_repo = Repository::open(repo.path()).unwrap();
        let unstaged = read_unstaged_files(&git_repo).unwrap();
        let file = unstaged.iter().find(|f| f.path == "image.bin").unwrap();
        assert_eq!(file.insertions, None);
        assert_eq!(file.deletions, None);
    }

    #[test]
    fn test_line_stats_large_untracked_file_are_skipped() {
        let repo = tempfile::TempDir::new().unwrap();
        run_git(repo.path(), &["init", "-q"]);
        run_git(repo.path(), &["config", "user.email", "test@example.com"]);
        run_git(repo.path(), &["config", "user.name", "Hubris Test"]);

        let oversized = vec![b'a'; DIFF_STAT_MAX_BLOB_BYTES as usize + 1];
        std::fs::write(repo.path().join("large.txt"), oversized).unwrap();

        let git_repo = Repository::open(repo.path()).unwrap();
        let unstaged = read_unstaged_files(&git_repo).unwrap();
        let file = unstaged.iter().find(|f| f.path == "large.txt").unwrap();
        assert_eq!(file.insertions, None);
        assert_eq!(file.deletions, None);
    }
}
