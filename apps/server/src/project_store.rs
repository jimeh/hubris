use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;

use crate::api::projects::Project;
use crate::fs_sync::sync_parent_directory;

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Errors surfaced by [`ProjectStore`].
#[derive(Debug)]
pub enum ProjectStoreError {
    Io(std::io::Error),
    /// The projects file on disk exists but does not parse as a
    /// list of projects. The file is left untouched so user data
    /// stays recoverable.
    Corrupt {
        path: PathBuf,
        source: serde_json::Error,
    },
}

impl fmt::Display for ProjectStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::Corrupt { path, source } => write!(
                f,
                "projects file {} is corrupt ({source}); refusing to \
                 overwrite it — fix or move the file and restart",
                path.display()
            ),
        }
    }
}

impl std::error::Error for ProjectStoreError {}

impl From<std::io::Error> for ProjectStoreError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

/// Outcome of [`ProjectStore::add`].
pub struct AddOutcome {
    pub project: Project,
    /// `false` when a project with the same path already existed.
    pub created: bool,
}

/// Outcome of [`ProjectStore::reorder`].
pub enum ReorderOutcome {
    Reordered(Vec<Project>),
    /// The supplied ids do not exactly cover the stored projects.
    InvalidIds,
}

/// Serialized owner of `projects.json`.
///
/// The file is read once at startup; afterwards the in-memory list
/// is the source of truth. Every mutation runs under a write lock
/// and persists atomically (temp file + rename) before the new
/// state is committed, so concurrent requests cannot lose updates
/// and a failed write leaves both memory and disk unchanged.
pub struct ProjectStore {
    path: PathBuf,
    projects: RwLock<Vec<Project>>,
}

impl ProjectStore {
    /// Load the store from `path`. A missing file yields an empty
    /// store; an unreadable or unparsable file is a hard error so
    /// existing data is never silently replaced.
    pub async fn load(path: PathBuf) -> Result<Self, ProjectStoreError> {
        let projects = match tokio::fs::read_to_string(&path).await {
            Ok(contents) => match serde_json::from_str::<Vec<Project>>(&contents) {
                Ok(projects) => projects,
                Err(source) => {
                    return Err(ProjectStoreError::Corrupt {
                        path: path.clone(),
                        source,
                    });
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => vec![],
            Err(error) => return Err(ProjectStoreError::Io(error)),
        };
        Ok(Self {
            path,
            projects: RwLock::new(projects),
        })
    }

    /// All projects, sorted by position.
    pub async fn list(&self) -> Vec<Project> {
        let mut projects = self.projects.read().await.clone();
        projects.sort_by(|a, b| {
            a.position
                .partial_cmp(&b.position)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        projects
    }

    /// Look up a project by id.
    pub async fn get(&self, id: &str) -> Option<Project> {
        self.projects
            .read()
            .await
            .iter()
            .find(|project| project.id == id)
            .cloned()
    }

    /// Add a project for `canonical_path`, or return the existing
    /// project registered for that path.
    pub async fn add(
        &self,
        canonical_path: String,
        name: String,
    ) -> Result<AddOutcome, ProjectStoreError> {
        let mut projects = self.projects.write().await;
        if let Some(existing) = projects
            .iter()
            .find(|project| project.path == canonical_path)
            .cloned()
        {
            return Ok(AddOutcome {
                project: existing,
                created: false,
            });
        }

        let max_pos = projects.iter().map(|p| p.position).fold(0.0_f64, f64::max);
        let project = Project {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            path: canonical_path,
            position: max_pos + 1.0,
            git_error: None,
        };

        let mut next = projects.clone();
        next.push(project.clone());
        persist(&self.path, &next).await?;
        *projects = next;
        Ok(AddOutcome {
            project,
            created: true,
        })
    }

    /// Apply an optional rename to a project. Returns `None` when
    /// no project has the given id.
    pub async fn update(
        &self,
        id: &str,
        name: Option<String>,
    ) -> Result<Option<Project>, ProjectStoreError> {
        let mut projects = self.projects.write().await;
        let mut next = projects.clone();
        let Some(project) = next.iter_mut().find(|p| p.id == id) else {
            return Ok(None);
        };
        if let Some(name) = name {
            project.name = name;
        }
        let updated = project.clone();
        persist(&self.path, &next).await?;
        *projects = next;
        Ok(Some(updated))
    }

    /// Reassign positions from the given id order. The ids must
    /// exactly cover the stored projects.
    pub async fn reorder(
        &self,
        project_ids: &[String],
    ) -> Result<ReorderOutcome, ProjectStoreError> {
        let mut projects = self.projects.write().await;
        if project_ids.len() != projects.len() {
            return Ok(ReorderOutcome::InvalidIds);
        }
        // Require a true permutation: distinct ids that each match a stored
        // project. A duplicated-but-covering input like [A, A] against
        // stored [A, B] would otherwise pass and leave B's position stale.
        let distinct: std::collections::HashSet<&str> =
            project_ids.iter().map(String::as_str).collect();
        if distinct.len() != project_ids.len() {
            return Ok(ReorderOutcome::InvalidIds);
        }
        let all_exist = project_ids
            .iter()
            .all(|id| projects.iter().any(|p| p.id == *id));
        if !all_exist {
            return Ok(ReorderOutcome::InvalidIds);
        }

        let mut next = projects.clone();
        for (i, id) in project_ids.iter().enumerate() {
            if let Some(p) = next.iter_mut().find(|p| p.id == *id) {
                p.position = (i + 1) as f64;
            }
        }
        next.sort_by(|a, b| {
            a.position
                .partial_cmp(&b.position)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        persist(&self.path, &next).await?;
        *projects = next.clone();
        Ok(ReorderOutcome::Reordered(next))
    }

    /// Remove a project by id. Returns `false` when no project had
    /// the given id (nothing is persisted in that case).
    pub async fn remove(&self, id: &str) -> Result<bool, ProjectStoreError> {
        let mut projects = self.projects.write().await;
        let mut next = projects.clone();
        let before = next.len();
        next.retain(|p| p.id != id);
        if next.len() == before {
            return Ok(false);
        }
        persist(&self.path, &next).await?;
        *projects = next;
        Ok(true)
    }
}

/// Write the projects list to `path` atomically: write and fsync a
/// sibling temp file, rename it over the target, then fsync the
/// parent directory.
async fn persist(path: &Path, projects: &[Project]) -> Result<(), ProjectStoreError> {
    let mut to_store = projects.to_vec();
    for project in &mut to_store {
        project.git_error = None;
    }
    let contents = serde_json::to_string_pretty(&to_store).map_err(std::io::Error::other)?;

    let temp_path = temp_projects_path(path);
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&temp_path)
        .await
        .map_err(|error| cleanup_temp_file_on_error(&temp_path, error))?;
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

    if let Err(error) = tokio::fs::rename(&temp_path, path).await {
        return Err(cleanup_temp_file_on_error(&temp_path, error));
    }
    sync_parent_directory(path).await?;
    Ok(())
}

fn temp_projects_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("projects.json");
    let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    parent.join(format!("{file_name}.tmp.{}.{counter}", std::process::id()))
}

fn cleanup_temp_file_on_error(path: &Path, error: std::io::Error) -> ProjectStoreError {
    let _ = std::fs::remove_file(path);
    ProjectStoreError::Io(error)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tempfile::TempDir;

    use super::*;

    fn projects_path(tmp: &TempDir) -> PathBuf {
        tmp.path().join("projects.json")
    }

    async fn new_store(tmp: &TempDir) -> Arc<ProjectStore> {
        Arc::new(ProjectStore::load(projects_path(tmp)).await.unwrap())
    }

    fn read_disk_projects(tmp: &TempDir) -> Vec<Project> {
        let contents = std::fs::read_to_string(projects_path(tmp)).unwrap();
        serde_json::from_str(&contents).unwrap()
    }

    fn assert_no_temp_files(tmp: &TempDir) {
        let temp_files = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("projects.json.tmp.")
            })
            .count();
        assert_eq!(temp_files, 0);
    }

    #[tokio::test]
    async fn load_missing_file_starts_empty() {
        let tmp = TempDir::new().unwrap();
        let store = new_store(&tmp).await;
        assert!(store.list().await.is_empty());
        assert!(!projects_path(&tmp).exists());
    }

    #[tokio::test]
    async fn add_persists_and_deduplicates_by_path() {
        let tmp = TempDir::new().unwrap();
        let store = new_store(&tmp).await;

        let first = store
            .add("/repo/a".to_string(), "a".to_string())
            .await
            .unwrap();
        assert!(first.created);

        let second = store
            .add("/repo/a".to_string(), "a".to_string())
            .await
            .unwrap();
        assert!(!second.created);
        assert_eq!(second.project.id, first.project.id);

        let on_disk = read_disk_projects(&tmp);
        assert_eq!(on_disk.len(), 1);
        assert_eq!(on_disk[0].id, first.project.id);
        assert_no_temp_files(&tmp);
    }

    #[tokio::test]
    async fn load_corrupt_file_errors_and_preserves_file() {
        let tmp = TempDir::new().unwrap();
        let garbage = "{ not json ]";
        std::fs::write(projects_path(&tmp), garbage).unwrap();

        let result = ProjectStore::load(projects_path(&tmp)).await;
        assert!(matches!(result, Err(ProjectStoreError::Corrupt { .. })));

        let contents = std::fs::read_to_string(projects_path(&tmp)).unwrap();
        assert_eq!(contents, garbage);
    }

    #[tokio::test]
    async fn failed_persist_rolls_back_memory_and_leaves_disk_alone() {
        let tmp = TempDir::new().unwrap();
        let store = new_store(&tmp).await;
        let added = store
            .add("/repo/a".to_string(), "a".to_string())
            .await
            .unwrap();
        let disk_before = std::fs::read_to_string(projects_path(&tmp)).unwrap();

        // Replace the target with a directory so the rename step
        // of the atomic persist fails.
        std::fs::remove_file(projects_path(&tmp)).unwrap();
        std::fs::create_dir(projects_path(&tmp)).unwrap();

        let result = store.remove(&added.project.id).await;
        assert!(matches!(result, Err(ProjectStoreError::Io(_))));

        std::fs::remove_dir(projects_path(&tmp)).unwrap();
        std::fs::write(projects_path(&tmp), &disk_before).unwrap();

        let projects = store.list().await;
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, added.project.id);
        assert_no_temp_files(&tmp);
    }

    #[tokio::test]
    async fn concurrent_mutations_lose_no_updates() {
        let tmp = TempDir::new().unwrap();
        let store = new_store(&tmp).await;

        // Seed projects that concurrent tasks will delete and
        // reorder while new ones are added.
        let mut seeded = Vec::new();
        for i in 0..4 {
            let added = store
                .add(format!("/repo/seed-{i}"), format!("seed-{i}"))
                .await
                .unwrap();
            seeded.push(added.project.id);
        }

        let mut handles = Vec::new();
        for i in 0..16 {
            let store = Arc::clone(&store);
            handles.push(tokio::spawn(async move {
                store
                    .add(format!("/repo/add-{i}"), format!("add-{i}"))
                    .await
                    .unwrap();
            }));
        }
        for id in &seeded[..2] {
            let id = id.clone();
            let store = Arc::clone(&store);
            handles.push(tokio::spawn(async move {
                assert!(store.remove(&id).await.unwrap());
            }));
        }
        for _ in 0..4 {
            let store = Arc::clone(&store);
            handles.push(tokio::spawn(async move {
                let ids: Vec<String> = store.list().await.into_iter().rev().map(|p| p.id).collect();
                // Ids may be stale by the time reorder runs; both
                // outcomes are valid, only errors are not.
                store.reorder(&ids).await.unwrap();
            }));
        }
        for handle in handles {
            handle.await.unwrap();
        }

        let expected_paths: Vec<String> = (0..16)
            .map(|i| format!("/repo/add-{i}"))
            .chain(
                seeded
                    .iter()
                    .skip(2)
                    .enumerate()
                    .map(|(i, _)| format!("/repo/seed-{}", i + 2)),
            )
            .collect();

        let projects = store.list().await;
        assert_eq!(projects.len(), expected_paths.len());
        for path in &expected_paths {
            assert!(
                projects.iter().any(|p| &p.path == path),
                "missing project for {path}"
            );
        }

        // Disk must parse and match the in-memory source of truth.
        let mut on_disk = read_disk_projects(&tmp);
        on_disk.sort_by(|a, b| a.id.cmp(&b.id));
        let mut in_memory = projects;
        in_memory.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(
            serde_json::to_value(&on_disk).unwrap(),
            serde_json::to_value(&in_memory).unwrap()
        );
        assert_no_temp_files(&tmp);
    }
}
