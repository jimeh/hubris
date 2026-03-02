use std::path::{Path, PathBuf};

use tokio::process::Command;
use uuid::Uuid;

const WORKTREE_NAMESPACE: Uuid = Uuid::from_u128(0x2b8b1f5e_84f8_4d8d_9ad8_9f6df2a93f3b);

#[derive(Debug, Clone)]
pub struct GitWorktree {
    pub path: PathBuf,
    pub branch: Option<String>,
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

    run_git(&["-C", &cwd, "worktree", "add", "-b", branch, &target])
        .await
        .map(|_| ())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_worktree_id_is_stable() {
        let path = Path::new("/tmp/repo");
        assert_eq!(worktree_id(path), worktree_id(path));
    }
}
