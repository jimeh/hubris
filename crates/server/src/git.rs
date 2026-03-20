use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;

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

fn run_git_sync(args: &[&str]) -> Result<String, GitError> {
    let output = StdCommand::new("git")
        .args(args)
        .output()
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
    if trimmed.is_empty() {
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

async fn run_git_bytes(args: &[&str]) -> Result<Vec<u8>, GitError> {
    let output = Command::new("git")
        .args(args)
        .output()
        .await
        .map_err(|e| GitError {
            message: format!("failed to run git: {e}"),
        })?;

    if output.status.success() {
        Ok(output.stdout)
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

async fn run_git_in_worktree_bytes(
    worktree_path: &Path,
    args: &[&str],
) -> Result<Vec<u8>, GitError> {
    let cwd = worktree_path.to_string_lossy().to_string();
    let mut argv = vec!["-C", &cwd];
    argv.extend_from_slice(args);
    run_git_bytes(&argv).await
}

fn split_nul_tokens(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|token| !token.is_empty())
        .map(bytes_to_string)
        .collect()
}

fn map_git_commit_details_error(error: GitError) -> GitCommitDetailsError {
    let message = error.message.to_lowercase();
    if message.contains("unknown revision")
        || message.contains("bad object")
        || message.contains("bad revision")
        || message.contains("needed a single revision")
        || message.contains("ambiguous argument")
    {
        GitCommitDetailsError::NotFound
    } else {
        GitCommitDetailsError::Internal
    }
}

fn trim_trailing_newlines(value: String) -> String {
    value.trim_end_matches(['\n', '\r']).to_string()
}

fn parse_commit_meta(bytes: &[u8]) -> Result<GitCommitDetails, GitCommitDetailsError> {
    let tokens = split_nul_tokens(bytes);
    if tokens.len() < 9 {
        return Err(GitCommitDetailsError::Internal);
    }

    Ok(GitCommitDetails {
        id: tokens[0].clone(),
        short_id: tokens[1].clone(),
        summary: tokens[2].clone(),
        message: trim_trailing_newlines(tokens[3].clone()),
        author: GitCommitPerson {
            name: tokens[4].clone(),
            email: tokens[5].clone(),
            date: tokens[6].trim().to_string(),
        },
        committer: GitCommitPerson {
            name: tokens[7].clone(),
            email: tokens[8].clone(),
            date: tokens
                .get(9)
                .map(|value| value.trim().to_string())
                .unwrap_or_default(),
        },
        files: Vec::new(),
    })
}

fn map_diff_name_status(kind: &str) -> Option<GitFileChangeType> {
    let code = kind.chars().next()?;
    Some(match code {
        'A' => GitFileChangeType::Added,
        'C' => GitFileChangeType::Copied,
        'D' => GitFileChangeType::Deleted,
        'M' => GitFileChangeType::Modified,
        'R' => GitFileChangeType::Renamed,
        'T' => GitFileChangeType::Typechange,
        _ => return None,
    })
}

fn parse_diff_name_status(bytes: &[u8]) -> Vec<GitFileChange> {
    let tokens = split_nul_tokens(bytes);
    let mut index = 0;
    let mut files = Vec::new();

    while index < tokens.len() {
        let status = &tokens[index];
        index += 1;

        let Some(change_type) = map_diff_name_status(status) else {
            continue;
        };

        let path = match change_type {
            GitFileChangeType::Copied | GitFileChangeType::Renamed => {
                if index + 1 >= tokens.len() {
                    break;
                }
                index += 1;
                let value = tokens[index].clone();
                index += 1;
                value
            }
            _ => {
                if index >= tokens.len() {
                    break;
                }
                let value = tokens[index].clone();
                index += 1;
                value
            }
        };

        files.push(GitFileChange { path, change_type });
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

pub async fn read_commit_details(
    worktree_path: &Path,
    commit_id: &str,
) -> Result<GitCommitDetails, GitCommitDetailsError> {
    let meta_bytes = run_git_in_worktree_bytes(
        worktree_path,
        &[
            "show",
            "-s",
            "--no-patch",
            "--format=%H%x00%h%x00%s%x00%B%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI",
            commit_id,
        ],
    )
    .await
    .map_err(map_git_commit_details_error)?;
    let mut details = parse_commit_meta(&meta_bytes)?;

    let parent_bytes = run_git_in_worktree_bytes(
        worktree_path,
        &["rev-list", "--parents", "-n", "1", commit_id],
    )
    .await
    .map_err(map_git_commit_details_error)?;
    let parent_tokens = String::from_utf8_lossy(&parent_bytes)
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    if parent_tokens.is_empty() {
        return Err(GitCommitDetailsError::NotFound);
    }

    let diff_bytes = if let Some(first_parent) = parent_tokens.get(1) {
        run_git_in_worktree_bytes(
            worktree_path,
            &[
                "diff-tree",
                "--no-commit-id",
                "--name-status",
                "-r",
                "-z",
                "-M",
                "-C",
                first_parent,
                commit_id,
            ],
        )
        .await
    } else {
        run_git_in_worktree_bytes(
            worktree_path,
            &[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--name-status",
                "-r",
                "-z",
                "-M",
                "-C",
                commit_id,
            ],
        )
        .await
    }
    .map_err(map_git_commit_details_error)?;

    details.files = parse_diff_name_status(&diff_bytes);
    Ok(details)
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

fn status_contains_tracked_change(entry: &PorcelainStatusEntry) -> bool {
    entry.index_status != '?'
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
            if !current.starts_with(&request_root)
                || current == worktree_path
                || current == request_root
            {
                break;
            }

            match std::fs::remove_dir(&current) {
                Ok(()) => {
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

    let path = match item {
        Item::Modification { rela_path, .. } => bytes_to_string(rela_path),
        Item::DirectoryContents { entry, .. } => bytes_to_string(&entry.rela_path),
        Item::Rewrite { dirwalk_entry, .. } => bytes_to_string(&dirwalk_entry.rela_path),
    };

    Some(GitFileChange { path, change_type })
}

fn map_tree_index_change(change: gix::diff::index::Change) -> Option<GitFileChange> {
    use gix::diff::index::Change;

    let (path, change_type) = match change {
        Change::Addition { location, .. } => {
            (bytes_to_string(location.as_ref()), GitFileChangeType::Added)
        }
        Change::Deletion { location, .. } => (
            bytes_to_string(location.as_ref()),
            GitFileChangeType::Deleted,
        ),
        Change::Modification {
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
            (bytes_to_string(location.as_ref()), change_type)
        }
        Change::Rewrite { location, copy, .. } => (
            bytes_to_string(location.as_ref()),
            if copy {
                GitFileChangeType::Copied
            } else {
                GitFileChangeType::Renamed
            },
        ),
    };

    Some(GitFileChange { path, change_type })
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
    let cwd = worktree_path.to_string_lossy().to_string();
    let git_dir = run_git_sync(&[
        "-C",
        &cwd,
        "rev-parse",
        "--path-format=absolute",
        "--absolute-git-dir",
    ])?;
    let common_dir = run_git_sync(&[
        "-C",
        &cwd,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
    ])?;

    let mut paths = BTreeSet::new();
    for raw_path in [git_dir, common_dir] {
        let path = PathBuf::from(raw_path);
        let canonical = std::fs::canonicalize(&path).unwrap_or(path);
        paths.insert(canonical);
    }

    Ok(paths.into_iter().collect())
}

pub async fn resolve_local_root(path: &Path) -> Result<PathBuf, GitError> {
    let cwd = path.to_string_lossy().to_string();
    let common_dir = run_git(&[
        "-C",
        &cwd,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
    ])
    .await?;

    let common = PathBuf::from(common_dir);
    if common
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == ".git")
        && let Some(parent) = common.parent()
    {
        return tokio::fs::canonicalize(parent).await.map_err(|e| GitError {
            message: format!("failed to canonicalize git root: {e}"),
        });
    }

    let top_level = run_git(&[
        "-C",
        &cwd,
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
    ])
    .await?;

    tokio::fs::canonicalize(top_level)
        .await
        .map_err(|e| GitError {
            message: format!("failed to canonicalize git top-level: {e}"),
        })
}

pub async fn list_worktrees(local_root: &Path) -> Result<Vec<GitWorktree>, GitError> {
    let cwd = local_root.to_string_lossy().to_string();
    let out = run_git(&["-C", &cwd, "worktree", "list", "--porcelain"]).await?;
    let mut worktrees = Vec::new();

    for block in out.split("\n\n") {
        if block.trim().is_empty() {
            continue;
        }

        let mut path: Option<PathBuf> = None;
        let mut branch: Option<String> = None;

        for line in block.lines() {
            if let Some(rest) = line.strip_prefix("worktree ") {
                path = Some(PathBuf::from(rest.trim()));
            } else if let Some(rest) = line.strip_prefix("branch ") {
                branch = Some(
                    rest.trim()
                        .strip_prefix("refs/heads/")
                        .unwrap_or(rest.trim())
                        .to_string(),
                );
            }
        }

        if let Some(path) = path {
            let canonical = tokio::fs::canonicalize(&path).await.unwrap_or(path);
            worktrees.push(GitWorktree {
                path: canonical,
                branch,
            });
        }
    }

    Ok(worktrees)
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

pub async fn list_branch_start_points(local_root: &Path) -> Result<Vec<GitStartPoint>, GitError> {
    let cwd = local_root.to_string_lossy().to_string();
    let local = run_git(&[
        "-C",
        &cwd,
        "for-each-ref",
        "--format=%(refname:short)\t%(objectname)\t%(committerdate:unix)",
        "refs/heads",
    ])
    .await?;
    let remote = run_git(&[
        "-C",
        &cwd,
        "for-each-ref",
        "--format=%(refname)\t%(refname:short)\t%(objectname)\t%(committerdate:unix)",
        "refs/remotes",
    ])
    .await?;

    let mut seen = HashSet::new();
    let mut start_points = Vec::new();

    for line in local.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let mut parts = line.split('\t');
        let Some(name) = parts.next().map(str::trim) else {
            continue;
        };
        let Some(sha) = parts.next().map(str::trim) else {
            continue;
        };
        let Some(commit_timestamp) = parts.next().map(str::trim) else {
            continue;
        };
        if name.is_empty() || sha.is_empty() {
            continue;
        }
        let commit_timestamp = commit_timestamp.parse::<i64>().unwrap_or_default();

        if seen.insert(name.to_string()) {
            start_points.push(GitStartPoint {
                name: name.to_string(),
                kind: GitStartPointKind::Local,
                sha: sha.to_string(),
                commit_timestamp,
            });
        }
    }

    for line in remote
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let mut parts = line.split('\t');
        let Some(full_name) = parts.next().map(str::trim) else {
            continue;
        };
        let Some(name) = parts.next().map(str::trim) else {
            continue;
        };
        let Some(sha) = parts.next().map(str::trim) else {
            continue;
        };
        let Some(commit_timestamp) = parts.next().map(str::trim) else {
            continue;
        };
        if name.is_empty() || sha.is_empty() {
            continue;
        }
        let commit_timestamp = commit_timestamp.parse::<i64>().unwrap_or_default();
        if full_name.ends_with("/HEAD") {
            continue;
        }
        if seen.insert(name.to_string()) {
            start_points.push(GitStartPoint {
                name: name.to_string(),
                kind: GitStartPointKind::Remote,
                sha: sha.to_string(),
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

pub async fn current_branch(local_root: &Path) -> Result<Option<String>, GitError> {
    let cwd = local_root.to_string_lossy().to_string();
    let output = Command::new("git")
        .args(["-C", &cwd, "symbolic-ref", "--quiet", "--short", "HEAD"])
        .output()
        .await
        .map_err(|e| GitError {
            message: format!("failed to run git: {e}"),
        })?;

    if output.status.success() {
        let branch = trim_output(&output.stdout);
        if branch.is_empty() {
            Ok(None)
        } else {
            Ok(Some(branch))
        }
    } else if output.status.code() == Some(1) {
        // Detached HEAD; there is no current branch.
        Ok(None)
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
) -> Result<Vec<String>, GitPathActionError> {
    let relative_path = normalize_relative_git_path(relative_path)?;
    run_git_in_worktree(worktree_path, &["add", "--", &relative_path]).await?;
    Ok(invalidated_parent_paths(&BTreeSet::from([relative_path])))
}

pub async fn unstage_worktree_path(
    worktree_path: &Path,
    relative_path: &str,
) -> Result<Vec<String>, GitPathActionError> {
    let relative_path = normalize_relative_git_path(relative_path)?;
    run_git_in_worktree(
        worktree_path,
        &["restore", "--staged", "--", &relative_path],
    )
    .await?;
    Ok(invalidated_parent_paths(&BTreeSet::from([relative_path])))
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

        if status_contains_tracked_change(&entry) {
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
        let mut restore_args = vec!["restore", "--source=HEAD", "--worktree", "--"];
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
        .tree_index_track_renames(gix::status::tree_index::TrackRenames::Given(
            rewrite_tracking(),
        ))
        .into_iter(Vec::<gix::bstr::BString>::new())
        .map_err(to_git_error)?;

    let mut unstaged_files = Vec::new();
    let mut staged_files = Vec::new();

    for item in &mut status {
        match item.map_err(to_git_error)? {
            gix::status::Item::IndexWorktree(change) => {
                if let Some(change) = map_index_worktree_change(&change) {
                    unstaged_files.push(change);
                }
            }
            gix::status::Item::TreeIndex(change) => {
                if let Some(change) = map_tree_index_change(change) {
                    staged_files.push(change);
                }
            }
        }
    }

    unstaged_files.sort_by(|a, b| a.path.cmp(&b.path));
    staged_files.sort_by(|a, b| a.path.cmp(&b.path));

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
}
