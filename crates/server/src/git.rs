use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::api::worktrees::{GitCommitSummary, GitFileChange, GitFileChangeType};
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

    #[test]
    fn test_worktree_id_is_stable() {
        let path = Path::new("/tmp/repo");
        assert_eq!(worktree_id(path), worktree_id(path));
    }
}
