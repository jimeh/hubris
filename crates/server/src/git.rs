use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use crate::api::worktrees::{GitCommitPerson, GitCommitSummary, GitFileChange, GitFileChangeType};
use tokio::process::Command;
use uuid::Uuid;

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

#[derive(Debug, Clone)]
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
    NotFound,
    PermissionDenied,
    Internal,
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for GitError {}

fn trim_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

fn to_git_error(error: impl std::fmt::Display) -> GitError {
    GitError {
        message: error.to_string(),
    }
}

fn bytes_to_string(value: &[u8]) -> String {
    String::from_utf8_lossy(value).into_owned()
}

fn rewrite_tracking() -> gix::diff::Rewrites {
    gix::diff::Rewrites {
        copies: Some(gix::diff::rewrites::Copies {
            source: gix::diff::rewrites::CopySource::FromSetOfModifiedFilesAndAllSources,
            ..Default::default()
        }),
        ..Default::default()
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

fn map_git_path_error(error: GitError) -> GitPathActionError {
    let message = error.message.to_lowercase();
    if message.contains("permission denied") {
        GitPathActionError::PermissionDenied
    } else if message.contains("did not match any file")
        || message.contains("pathspec")
        || message.contains("no such file")
    {
        GitPathActionError::NotFound
    } else {
        GitPathActionError::Internal
    }
}

async fn run_git_in_worktree(
    worktree_path: &Path,
    args: &[&str],
) -> Result<String, GitPathActionError> {
    let cwd = worktree_path.to_string_lossy().to_string();
    let mut argv = vec!["-C", &cwd];
    argv.extend_from_slice(args);
    run_git(&argv).await.map_err(map_git_path_error)
}

fn split_nul_tokens(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|token| !token.is_empty())
        .map(bytes_to_string)
        .collect()
}

fn trim_trailing_newlines(value: String) -> String {
    value.trim_end_matches(['\n', '\r']).to_string()
}

fn format_git_signature_date(time: gix::date::Time) -> String {
    time.format(gix::date::time::format::ISO8601_STRICT)
        .unwrap_or_else(|_| time.format_or_unix(gix::date::time::format::RAW))
}

fn map_commit_person(signature: gix::actor::SignatureRef<'_>) -> GitCommitPerson {
    GitCommitPerson {
        name: bytes_to_string(signature.name.as_ref()),
        email: bytes_to_string(signature.email.as_ref()),
        date: signature
            .time()
            .map(format_git_signature_date)
            .unwrap_or_else(|_| signature.time.trim().to_string()),
    }
}

fn non_empty_string(value: &[u8]) -> Option<String> {
    let value = bytes_to_string(value);
    (!value.is_empty()).then_some(value)
}

fn map_commit_tree_change(
    change: gix::object::tree::diff::ChangeDetached,
) -> Option<GitFileChange> {
    use gix::object::tree::diff::ChangeDetached;

    let (path, original_path, change_type) = match change {
        ChangeDetached::Addition {
            location,
            entry_mode,
            ..
        } => {
            if entry_mode.is_tree() {
                return None;
            }
            (
                bytes_to_string(location.as_ref()),
                None,
                GitFileChangeType::Added,
            )
        }
        ChangeDetached::Deletion {
            location,
            entry_mode,
            ..
        } => {
            if entry_mode.is_tree() {
                return None;
            }
            (
                bytes_to_string(location.as_ref()),
                None,
                GitFileChangeType::Deleted,
            )
        }
        ChangeDetached::Modification {
            location,
            previous_entry_mode,
            entry_mode,
            ..
        } => {
            if previous_entry_mode.is_tree() || entry_mode.is_tree() {
                return None;
            }
            let change_type = if previous_entry_mode != entry_mode {
                GitFileChangeType::Typechange
            } else {
                GitFileChangeType::Modified
            };
            (bytes_to_string(location.as_ref()), None, change_type)
        }
        ChangeDetached::Rewrite {
            source_location,
            location,
            source_entry_mode,
            entry_mode,
            copy,
            ..
        } => {
            if source_entry_mode.is_tree() || entry_mode.is_tree() {
                return None;
            }
            let change_type = if copy {
                GitFileChangeType::Copied
            } else {
                GitFileChangeType::Renamed
            };
            (
                bytes_to_string(location.as_ref()),
                non_empty_string(source_location.as_ref()),
                change_type,
            )
        }
    };

    Some(GitFileChange {
        path,
        original_path,
        change_type,
    })
}

fn read_commit_details_gix(
    worktree_path: &Path,
    commit_id: &str,
) -> Result<GitCommitDetails, GitCommitDetailsError> {
    let repo = gix::open(worktree_path).map_err(|_| GitCommitDetailsError::Internal)?;
    let commit_id = repo
        .rev_parse_single(commit_id)
        .map_err(|_| GitCommitDetailsError::NotFound)?
        .detach();
    let commit = repo
        .find_commit(commit_id)
        .map_err(|_| GitCommitDetailsError::NotFound)?;
    let short_id = commit
        .short_id()
        .map_err(|_| GitCommitDetailsError::Internal)?
        .to_string();
    let summary = String::from_utf8_lossy(commit.message_raw_sloppy().as_ref())
        .lines()
        .next()
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let message = trim_trailing_newlines(bytes_to_string(
        commit
            .message_raw()
            .map_err(|_| GitCommitDetailsError::Internal)?
            .as_ref(),
    ));
    let author = map_commit_person(
        commit
            .author()
            .map_err(|_| GitCommitDetailsError::Internal)?,
    );
    let committer = map_commit_person(
        commit
            .committer()
            .map_err(|_| GitCommitDetailsError::Internal)?,
    );
    let old_tree = match commit.parent_ids().next() {
        Some(parent_id) => Some(
            repo.find_commit(parent_id.detach())
                .map_err(|_| GitCommitDetailsError::Internal)?
                .tree()
                .map_err(|_| GitCommitDetailsError::Internal)?,
        ),
        None => None,
    };
    let new_tree = commit.tree().map_err(|_| GitCommitDetailsError::Internal)?;
    let mut diff_options = gix::diff::Options::default();
    diff_options.track_path();
    diff_options.track_rewrites(Some(rewrite_tracking()));
    let mut files = repo
        .diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), Some(diff_options))
        .map_err(|_| GitCommitDetailsError::Internal)?
        .into_iter()
        .filter_map(map_commit_tree_change)
        .collect::<Vec<_>>();
    files.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(GitCommitDetails {
        id: commit_id.to_string(),
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
    tokio::task::spawn_blocking(move || read_commit_details_gix(&worktree_path, &commit_id))
        .await
        .map_err(|_| GitCommitDetailsError::Internal)?
}

#[derive(Debug)]
struct PorcelainStatusEntry {
    index_status: char,
    worktree_status: char,
    path: String,
    original_path: Option<String>,
}

fn parse_porcelain_status(bytes: &[u8]) -> Vec<PorcelainStatusEntry> {
    let mut entries = Vec::new();
    let mut tokens = split_nul_tokens(bytes).into_iter();

    while let Some(token) = tokens.next() {
        if token.len() < 4 {
            continue;
        }

        let mut chars = token.chars();
        let Some(index_status) = chars.next() else {
            continue;
        };
        let Some(worktree_status) = chars.next() else {
            continue;
        };
        if chars.next() != Some(' ') {
            continue;
        }

        let path = chars.collect::<String>();
        let original_path =
            if matches!(index_status, 'R' | 'C') || matches!(worktree_status, 'R' | 'C') {
                tokens.next()
            } else {
                None
            };

        entries.push(PorcelainStatusEntry {
            index_status,
            worktree_status,
            path,
            original_path,
        });
    }

    entries
}

async fn read_porcelain_status(
    worktree_path: &Path,
    relative_path: &str,
) -> Result<Vec<PorcelainStatusEntry>, GitPathActionError> {
    let cwd = worktree_path.to_string_lossy().to_string();
    let output = Command::new("git")
        .args([
            "-C",
            &cwd,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--find-renames",
            "--",
            relative_path,
        ])
        .output()
        .await
        .map_err(|_| GitPathActionError::Internal)?;

    if !output.status.success() {
        let stderr = trim_output(&output.stderr);
        let stdout = trim_output(&output.stdout);
        return Err(map_git_path_error(GitError {
            message: if stderr.is_empty() { stdout } else { stderr },
        }));
    }

    Ok(parse_porcelain_status(&output.stdout))
}

fn status_contains_worktree_change(entry: &PorcelainStatusEntry) -> bool {
    entry.worktree_status != ' '
}

fn is_tracked_path(entry: &PorcelainStatusEntry) -> bool {
    entry.index_status != '?'
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

fn map_index_worktree_change(item: &gix::status::index_worktree::Item) -> Option<GitFileChange> {
    use gix::status::index_worktree::{Item, iter::Summary};

    let change_type = match item.summary()? {
        Summary::Added | Summary::IntentToAdd => GitFileChangeType::Untracked,
        Summary::Copied => GitFileChangeType::Copied,
        Summary::Renamed => GitFileChangeType::Renamed,
        Summary::Conflict => GitFileChangeType::Conflict,
        Summary::Modified => GitFileChangeType::Modified,
        Summary::Removed => GitFileChangeType::Deleted,
        Summary::TypeChange => GitFileChangeType::Typechange,
    };

    let (path, original_path) = match item {
        Item::Modification { rela_path, .. } => (bytes_to_string(rela_path), None),
        Item::DirectoryContents { entry, .. } => (bytes_to_string(&entry.rela_path), None),
        Item::Rewrite {
            source,
            dirwalk_entry,
            ..
        } => (
            bytes_to_string(&dirwalk_entry.rela_path),
            Some(bytes_to_string(source.rela_path())),
        ),
    };

    Some(GitFileChange {
        path,
        original_path,
        change_type,
    })
}

fn map_tree_index_change(
    change: gix::diff::index::ChangeRef<'_, '_>,
    tree_index: &gix::index::State,
) -> Option<GitFileChange> {
    use gix::diff::index::ChangeRef;

    let (path, original_path, change_type) = match change {
        ChangeRef::Addition { location, .. } => (
            bytes_to_string(location.as_ref()),
            None,
            GitFileChangeType::Added,
        ),
        ChangeRef::Deletion { location, .. } => (
            bytes_to_string(location.as_ref()),
            None,
            GitFileChangeType::Deleted,
        ),
        ChangeRef::Modification {
            location,
            previous_entry_mode,
            entry_mode,
            ..
        } => {
            let change_type = if previous_entry_mode != entry_mode {
                GitFileChangeType::Typechange
            } else {
                GitFileChangeType::Modified
            };
            (bytes_to_string(location.as_ref()), None, change_type)
        }
        ChangeRef::Rewrite {
            source_index,
            location,
            copy,
            ..
        } => (
            bytes_to_string(location.as_ref()),
            tree_index
                .entries()
                .get(source_index)
                .map(|entry| bytes_to_string(entry.path(tree_index).as_ref())),
            if copy {
                GitFileChangeType::Copied
            } else {
                GitFileChangeType::Renamed
            },
        ),
    };

    Some(GitFileChange {
        path,
        original_path,
        change_type,
    })
}

fn read_staged_files(repo: &gix::Repository) -> Result<Vec<GitFileChange>, GitError> {
    let head_tree_id = repo.head_tree_id_or_empty().map_err(to_git_error)?.detach();
    let index = repo.index_or_empty().map_err(to_git_error)?;
    let mut staged_files = Vec::new();
    repo.tree_index_status(
        &head_tree_id,
        &index,
        None,
        gix::status::tree_index::TrackRenames::Given(rewrite_tracking()),
        |change, tree_index, _| {
            if let Some(change) = map_tree_index_change(change, tree_index) {
                staged_files.push(change);
            }
            Ok::<_, std::convert::Infallible>(std::ops::ControlFlow::Continue(()))
        },
    )
    .map_err(to_git_error)?;
    staged_files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(staged_files)
}

fn commit_summary(commit: &gix::Commit<'_>) -> Result<GitCommitSummary, GitError> {
    let id = commit.id.to_string();
    let short_id = commit.short_id().map_err(to_git_error)?.to_string();
    let summary = String::from_utf8_lossy(commit.message_raw_sloppy().as_ref())
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .unwrap_or("(no commit message)")
        .to_string();

    Ok(GitCommitSummary {
        id,
        short_id,
        summary,
    })
}

fn read_ahead_commits(
    repo: &gix::Repository,
    source_ref: Option<&str>,
) -> Result<(usize, Vec<GitCommitSummary>, bool, Option<String>), GitError> {
    let Some(source_ref) = source_ref else {
        return Ok((0, Vec::new(), false, None));
    };

    let head_id = repo.head_id().map_err(to_git_error)?;
    let source_id = match repo.rev_parse_single(source_ref) {
        Ok(spec) => spec.detach(),
        Err(err) => {
            return Ok((0, Vec::new(), true, Some(err.to_string())));
        }
    };

    let mut walk = repo
        .rev_walk([head_id.detach()])
        .with_hidden([source_id])
        .sorting(gix::revision::walk::Sorting::ByCommitTime(
            gix::traverse::commit::simple::CommitTimeOrder::NewestFirst,
        ))
        .all()
        .map_err(to_git_error)?;

    let mut ahead_count = 0;
    let mut ahead_commits = Vec::new();

    for info in &mut walk {
        let info = info.map_err(to_git_error)?;
        ahead_count += 1;
        if ahead_commits.len() >= 100 {
            continue;
        }

        let commit = repo.find_commit(info.id).map_err(to_git_error)?;
        ahead_commits.push(commit_summary(&commit)?);
    }

    Ok((ahead_count, ahead_commits, true, None))
}

async fn run_git(args: &[&str]) -> Result<String, GitError> {
    let output = Command::new("git")
        .args(args)
        .output()
        .await
        .map_err(|e| GitError {
            message: format!("failed to run git: {e}"),
        })?;

    if output.status.success() {
        Ok(trim_output(&output.stdout))
    } else {
        let stderr = trim_output(&output.stderr);
        let stdout = trim_output(&output.stdout);
        Err(GitError {
            message: if stderr.is_empty() {
                if stdout.is_empty() {
                    "git command failed".to_string()
                } else {
                    stdout
                }
            } else {
                stderr
            },
        })
    }
}

pub fn worktree_id(path: &Path) -> String {
    Uuid::new_v5(&WORKTREE_NAMESPACE, path.to_string_lossy().as_bytes()).to_string()
}

pub fn resolve_git_metadata_watch_paths(worktree_path: &Path) -> Result<Vec<PathBuf>, GitError> {
    let repo = gix::open(worktree_path).map_err(to_git_error)?;
    let mut paths = BTreeSet::new();
    for path in [
        repo.git_dir().to_path_buf(),
        repo.common_dir().to_path_buf(),
    ] {
        let canonical = std::fs::canonicalize(&path).unwrap_or(path);
        paths.insert(canonical);
    }

    Ok(paths.into_iter().collect())
}

fn resolve_local_root_gix(path: &Path) -> Result<PathBuf, GitError> {
    let repo = gix::open(path).map_err(to_git_error)?;
    if let Some(workdir) = repo.workdir() {
        return std::fs::canonicalize(workdir).map_err(|e| GitError {
            message: format!("failed to canonicalize git top-level: {e}"),
        });
    }

    let common_dir = repo.common_dir();
    if common_dir
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == ".git")
        && let Some(parent) = common_dir.parent()
    {
        return std::fs::canonicalize(parent).map_err(|e| GitError {
            message: format!("failed to canonicalize git root: {e}"),
        });
    }

    std::fs::canonicalize(repo.git_dir()).map_err(|e| GitError {
        message: format!("failed to canonicalize git dir: {e}"),
    })
}

pub async fn resolve_local_root(path: &Path) -> Result<PathBuf, GitError> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || resolve_local_root_gix(&path))
        .await
        .map_err(|_| GitError {
            message: "failed to join git root task".to_string(),
        })?
}

fn short_head_name(repo: &gix::Repository) -> Result<Option<String>, GitError> {
    repo.head_name()
        .map(|name| name.map(|name| bytes_to_string(name.shorten().as_ref())))
        .map_err(to_git_error)
}

fn list_worktrees_gix(local_root: &Path) -> Result<Vec<GitWorktree>, GitError> {
    let repo = gix::open(local_root).map_err(to_git_error)?;
    let mut worktrees = Vec::new();

    let local_path = repo
        .workdir()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| local_root.to_path_buf());
    let local_path = std::fs::canonicalize(&local_path).unwrap_or(local_path);
    worktrees.push(GitWorktree {
        path: local_path,
        branch: short_head_name(&repo)?,
    });

    let mut linked_worktrees = Vec::new();
    for proxy in repo.worktrees().map_err(to_git_error)? {
        let base = proxy.base().map_err(to_git_error)?;
        let path = std::fs::canonicalize(&base).unwrap_or(base);
        let branch = proxy
            .into_repo_with_possibly_inaccessible_worktree()
            .ok()
            .and_then(|repo| short_head_name(&repo).ok())
            .flatten();
        linked_worktrees.push(GitWorktree { path, branch });
    }
    linked_worktrees.sort_by(|a, b| a.path.cmp(&b.path));
    worktrees.extend(linked_worktrees);

    Ok(worktrees)
}

pub async fn list_worktrees(local_root: &Path) -> Result<Vec<GitWorktree>, GitError> {
    let local_root = local_root.to_path_buf();
    tokio::task::spawn_blocking(move || list_worktrees_gix(&local_root))
        .await
        .map_err(|_| GitError {
            message: "failed to join worktree list task".to_string(),
        })?
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

    let cwd = local_root.to_string_lossy().to_string();
    let target = target_path.to_string_lossy().to_string();

    let mut args = vec![
        "-C".to_string(),
        cwd,
        "worktree".to_string(),
        "add".to_string(),
        "-b".to_string(),
        branch.to_string(),
        target,
    ];
    if let Some(start_point) = start_point {
        args.push(start_point.to_string());
    }

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(&arg_refs).await.map(|_| ())
}

fn commit_timestamp_for_reference(
    repo: &gix::Repository,
    reference: &mut gix::Reference<'_>,
) -> Result<i64, GitError> {
    let commit_id = reference.peel_to_id().map_err(to_git_error)?.detach();
    let commit = repo.find_commit(commit_id).map_err(to_git_error)?;
    Ok(commit.time().map_err(to_git_error)?.seconds)
}

fn list_branch_start_points_gix(local_root: &Path) -> Result<Vec<GitStartPoint>, GitError> {
    let repo = gix::open(local_root).map_err(to_git_error)?;
    let references = repo.references().map_err(to_git_error)?;
    let mut seen = HashSet::new();
    let mut start_points = Vec::new();

    for item in references.local_branches().map_err(to_git_error)? {
        let mut reference = item.map_err(to_git_error)?;
        let name = bytes_to_string(reference.name().shorten().as_ref());
        if name.is_empty() || !seen.insert(name.clone()) {
            continue;
        }
        let commit_timestamp = commit_timestamp_for_reference(&repo, &mut reference)?;
        let sha = reference.peel_to_id().map_err(to_git_error)?.to_string();
        start_points.push(GitStartPoint {
            name,
            kind: GitStartPointKind::Local,
            sha,
            commit_timestamp,
        });
    }

    for item in references.remote_branches().map_err(to_git_error)? {
        let mut reference = item.map_err(to_git_error)?;
        let name = bytes_to_string(reference.name().shorten().as_ref());
        if name.is_empty() || name.ends_with("/HEAD") || !seen.insert(name.clone()) {
            continue;
        }
        let commit_timestamp = commit_timestamp_for_reference(&repo, &mut reference)?;
        let sha = reference.peel_to_id().map_err(to_git_error)?.to_string();
        start_points.push(GitStartPoint {
            name,
            kind: GitStartPointKind::Remote,
            sha,
            commit_timestamp,
        });
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
    tokio::task::spawn_blocking(move || list_branch_start_points_gix(&local_root))
        .await
        .map_err(|_| GitError {
            message: "failed to join branch start points task".to_string(),
        })?
}

fn current_branch_gix(local_root: &Path) -> Result<Option<String>, GitError> {
    let repo = gix::open(local_root).map_err(to_git_error)?;
    short_head_name(&repo)
}

pub async fn current_branch(local_root: &Path) -> Result<Option<String>, GitError> {
    let local_root = local_root.to_path_buf();
    tokio::task::spawn_blocking(move || current_branch_gix(&local_root))
        .await
        .map_err(|_| GitError {
            message: "failed to join current branch task".to_string(),
        })?
}

pub async fn remove_worktree(
    local_root: &Path,
    worktree_path: &Path,
    force: bool,
) -> Result<(), GitError> {
    let cwd = local_root.to_string_lossy().to_string();
    let target = worktree_path.to_string_lossy().to_string();
    let mut args = vec!["-C", &cwd, "worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&target);
    run_git(&args).await.map(|_| ())
}

pub async fn stage_worktree_path(
    worktree_path: &Path,
    relative_path: &str,
    original_path: Option<&str>,
) -> Result<Vec<String>, GitPathActionError> {
    let paths = normalized_git_action_paths(relative_path, original_path)?;
    let path_vec: Vec<String> = paths.iter().cloned().collect();
    let mut args = vec!["add", "--"];
    args.extend(path_vec.iter().map(String::as_str));
    run_git_in_worktree(worktree_path, &args).await?;
    Ok(invalidated_parent_paths(&paths))
}

pub async fn unstage_worktree_path(
    worktree_path: &Path,
    relative_path: &str,
    original_path: Option<&str>,
) -> Result<Vec<String>, GitPathActionError> {
    let paths = normalized_git_action_paths(relative_path, original_path)?;
    let path_vec: Vec<String> = paths.iter().cloned().collect();
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(path_vec.iter().map(String::as_str));
    run_git_in_worktree(worktree_path, &args).await?;
    Ok(invalidated_parent_paths(&paths))
}

pub async fn discard_worktree_path(
    worktree_path: &Path,
    relative_path: &str,
) -> Result<Vec<String>, GitPathActionError> {
    let relative_path = normalize_relative_git_path(relative_path)?;
    let statuses = read_porcelain_status(worktree_path, &relative_path).await?;

    let mut restore_paths = BTreeSet::new();
    let mut clean_paths = BTreeSet::new();
    let mut invalidated_paths = BTreeSet::from([relative_path.clone()]);

    for entry in statuses {
        invalidated_paths.insert(entry.path.clone());
        if let Some(original_path) = entry.original_path.clone() {
            invalidated_paths.insert(original_path.clone());
        }

        if entry.index_status == '?' && entry.worktree_status == '?' {
            clean_paths.insert(entry.path);
            continue;
        }

        if !status_contains_worktree_change(&entry) {
            continue;
        }

        if matches!(entry.worktree_status, 'R' | 'C') {
            if let Some(original_path) = entry.original_path {
                restore_paths.insert(original_path);
            }
            clean_paths.insert(entry.path);
            continue;
        }

        if is_tracked_path(&entry) {
            restore_paths.insert(entry.path);
        }
    }

    if restore_paths.is_empty() && clean_paths.is_empty() {
        let candidate = worktree_path.join(&relative_path);
        if !candidate.exists() {
            return Err(GitPathActionError::NotFound);
        }
        return Ok(invalidated_parent_paths(&invalidated_paths));
    }

    if !restore_paths.is_empty() {
        let restore_vec: Vec<String> = restore_paths.into_iter().collect();
        let mut restore_args = vec!["restore", "--worktree", "--"];
        restore_args.extend(restore_vec.iter().map(String::as_str));
        run_git_in_worktree(worktree_path, &restore_args).await?;
    }

    if !clean_paths.is_empty() {
        let clean_vec: Vec<String> = clean_paths.into_iter().collect();
        let mut clean_args = vec!["clean", "-fd", "--"];
        clean_args.extend(clean_vec.iter().map(String::as_str));
        run_git_in_worktree(worktree_path, &clean_args).await?;
        prune_empty_parent_dirs(worktree_path, &relative_path, &clean_vec)?;
    }

    Ok(invalidated_parent_paths(&invalidated_paths))
}

pub fn read_worktree_status(
    worktree_path: &Path,
    source_ref: Option<&str>,
) -> Result<WorktreeGitStatus, GitError> {
    let repo = gix::open(worktree_path).map_err(to_git_error)?;
    let mut status = repo
        .status(gix::progress::Discard)
        .map_err(to_git_error)?
        .untracked_files(gix::status::UntrackedFiles::Files)
        .index_worktree_rewrites(Some(rewrite_tracking()))
        .into_index_worktree_iter(Vec::<gix::bstr::BString>::new())
        .map_err(to_git_error)?;

    let mut unstaged_files = Vec::new();

    for item in &mut status {
        let change = item.map_err(to_git_error)?;
        if let Some(change) = map_index_worktree_change(&change) {
            unstaged_files.push(change);
        }
    }

    unstaged_files.sort_by(|a, b| a.path.cmp(&b.path));
    // Keep staged reads on the dedicated tree-vs-index path so rewrite-aware
    // rename/copy detection stays isolated from unstaged index-vs-worktree
    // status.
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

        let resolved = resolve_local_root_gix(&worktree_path).unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&worktree_path).unwrap());
    }
}
