use std::path::{Path, PathBuf};

use crate::domain::worktree::ResolvedWorktree;

pub const DISALLOWED_PATH_MESSAGE: &str = "This path resolves outside the allowed roots. Only files inside this \
     worktree or symlinks into the repository root can be opened.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreePathPolicy {
    worktree_root: PathBuf,
    repo_root: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreePathPolicyError {
    NotFound,
    PermissionDenied,
    Denied,
    Internal,
}

impl WorktreePathPolicy {
    pub async fn from_resolved(
        resolved: &ResolvedWorktree,
    ) -> Result<Self, WorktreePathPolicyError> {
        let worktree_root = tokio::fs::canonicalize(&resolved.worktree.path)
            .await
            .map_err(map_io_error)?;
        let repo_root = tokio::fs::canonicalize(&resolved.local_root)
            .await
            .map_err(map_io_error)?;
        Ok(Self {
            worktree_root,
            repo_root,
        })
    }

    pub fn new(worktree_root: PathBuf, repo_root: PathBuf) -> Self {
        Self {
            worktree_root,
            repo_root,
        }
    }

    pub fn worktree_root(&self) -> &Path {
        &self.worktree_root
    }

    pub fn repo_root(&self) -> &Path {
        &self.repo_root
    }

    pub fn allows(&self, canonical_path: &Path) -> bool {
        canonical_path.starts_with(&self.worktree_root)
            || canonical_path.starts_with(&self.repo_root)
    }

    pub fn require_allowed(
        &self,
        canonical_path: PathBuf,
    ) -> Result<PathBuf, WorktreePathPolicyError> {
        if self.allows(&canonical_path) {
            Ok(canonical_path)
        } else {
            Err(WorktreePathPolicyError::Denied)
        }
    }

    pub async fn resolve_existing(
        &self,
        relative_path: &str,
    ) -> Result<PathBuf, WorktreePathPolicyError> {
        let candidate = self.join(relative_path);
        let canonical = tokio::fs::canonicalize(candidate)
            .await
            .map_err(map_io_error)?;
        self.require_allowed(canonical)
    }

    pub async fn resolve_optional(
        &self,
        relative_path: &str,
    ) -> Result<Option<PathBuf>, WorktreePathPolicyError> {
        let candidate = self.join(relative_path);
        match tokio::fs::canonicalize(&candidate).await {
            Ok(canonical) => self.require_allowed(canonical).map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let parent = candidate.parent().ok_or(WorktreePathPolicyError::Denied)?;
                let canonical_parent = tokio::fs::canonicalize(parent)
                    .await
                    .map_err(map_io_error)?;
                self.require_allowed(canonical_parent)?;
                Ok(None)
            }
            Err(error) => Err(map_io_error(error)),
        }
    }

    fn join(&self, relative_path: &str) -> PathBuf {
        if relative_path.is_empty() {
            self.worktree_root.clone()
        } else {
            self.worktree_root.join(relative_path)
        }
    }
}

fn map_io_error(error: std::io::Error) -> WorktreePathPolicyError {
    match error.kind() {
        std::io::ErrorKind::NotFound => WorktreePathPolicyError::NotFound,
        std::io::ErrorKind::PermissionDenied => WorktreePathPolicyError::PermissionDenied,
        _ => WorktreePathPolicyError::Internal,
    }
}
