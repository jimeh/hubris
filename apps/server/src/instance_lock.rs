use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fs4::fs_std::FileExt;
use serde::{Deserialize, Serialize};

/// The kind of Hubris runtime that currently owns a data directory.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstanceKind {
    Server,
    DesktopRuntime,
}

impl fmt::Display for InstanceKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Server => write!(f, "server"),
            Self::DesktopRuntime => write!(f, "desktop runtime"),
        }
    }
}

/// Metadata persisted in `instance.lock` by the active Hubris process.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct InstanceLockMetadata {
    pub pid: u32,
    pub started_at: u64,
    pub instance_kind: InstanceKind,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listen_url: Option<String>,
}

/// Startup metadata supplied when claiming a data directory lock.
#[derive(Clone, Debug)]
pub struct InstanceLockOptions {
    pub instance_kind: InstanceKind,
    pub display_name: String,
    pub listen_url: Option<String>,
}

/// Information about the process that already owns a data directory.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstanceConflictInfo {
    pub holder_pid: u32,
    pub holder_kind: InstanceKind,
    pub listen_url: Option<String>,
    pub data_dir: PathBuf,
}

impl InstanceConflictInfo {
    /// Return a human-readable conflict message for logs and CLI output.
    pub fn message(&self) -> String {
        match (&self.holder_kind, &self.listen_url) {
            (InstanceKind::Server, Some(listen_url)) => format!(
                "Hubris is already running for data dir {} (pid {}, URL {})",
                self.data_dir.display(),
                self.holder_pid,
                listen_url
            ),
            (InstanceKind::DesktopRuntime, _) => format!(
                "Hubris desktop runtime is already running for data dir {} \
                 (pid {})",
                self.data_dir.display(),
                self.holder_pid
            ),
            _ => format!(
                "Hubris is already running for data dir {} (pid {})",
                self.data_dir.display(),
                self.holder_pid
            ),
        }
    }
}

/// Errors returned while acquiring a Hubris data directory lock.
#[derive(Debug, thiserror::Error)]
pub enum InstanceLockError {
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("{}", .0.message())]
    Conflict(InstanceConflictInfo),
}

/// A live exclusive lock over a Hubris data directory.
#[derive(Debug)]
pub struct InstanceLock {
    file: File,
    metadata: InstanceLockMetadata,
}

impl InstanceLock {
    /// Acquire the data directory lock and persist ownership metadata.
    pub fn acquire(
        data_dir: &Path,
        options: InstanceLockOptions,
    ) -> Result<Self, InstanceLockError> {
        std::fs::create_dir_all(data_dir)?;

        let path = data_dir.join("instance.lock");
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;

        match file.try_lock_exclusive() {
            Ok(true) => {
                let metadata = InstanceLockMetadata {
                    pid: std::process::id(),
                    started_at: current_unix_timestamp()?,
                    instance_kind: options.instance_kind,
                    display_name: options.display_name,
                    listen_url: options.listen_url,
                };
                write_metadata(&mut file, &metadata)?;
                Ok(Self { file, metadata })
            }
            Ok(false) => {
                let metadata = read_metadata(&path)?;
                Err(InstanceLockError::Conflict(InstanceConflictInfo {
                    holder_pid: metadata.pid,
                    holder_kind: metadata.instance_kind,
                    listen_url: metadata.listen_url,
                    data_dir: data_dir.to_path_buf(),
                }))
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                let metadata = read_metadata(&path)?;
                Err(InstanceLockError::Conflict(InstanceConflictInfo {
                    holder_pid: metadata.pid,
                    holder_kind: metadata.instance_kind,
                    listen_url: metadata.listen_url,
                    data_dir: data_dir.to_path_buf(),
                }))
            }
            Err(error) => Err(InstanceLockError::Io(error)),
        }
    }

    /// Return the current lock metadata.
    pub fn metadata(&self) -> &InstanceLockMetadata {
        &self.metadata
    }
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn current_unix_timestamp() -> io::Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(io::Error::other)
}

fn read_metadata(path: &Path) -> io::Result<InstanceLockMetadata> {
    let mut file = File::open(path)?;
    let mut buf = String::new();
    file.read_to_string(&mut buf)?;
    serde_json::from_str(&buf).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("failed to parse {path:?}: {error}"),
        )
    })
}

fn write_metadata(file: &mut File, metadata: &InstanceLockMetadata) -> io::Result<()> {
    file.seek(SeekFrom::Start(0))?;
    file.set_len(0)?;
    serde_json::to_writer_pretty(&mut *file, metadata).map_err(io::Error::other)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{InstanceKind, InstanceLock, InstanceLockOptions};
    use tempfile::TempDir;

    #[test]
    fn acquires_lock_and_writes_metadata() {
        let tmp = TempDir::new().unwrap();
        let lock = InstanceLock::acquire(
            tmp.path(),
            InstanceLockOptions {
                instance_kind: InstanceKind::Server,
                display_name: "Hubris Server".to_string(),
                listen_url: Some("http://127.0.0.1:3001".to_string()),
            },
        )
        .unwrap();

        assert_eq!(lock.metadata().pid, std::process::id());
        assert_eq!(lock.metadata().instance_kind, InstanceKind::Server);
        assert_eq!(
            lock.metadata().listen_url.as_deref(),
            Some("http://127.0.0.1:3001")
        );
    }

    #[test]
    fn writes_desktop_runtime_metadata_to_disk() {
        let tmp = TempDir::new().unwrap();
        let _lock = InstanceLock::acquire(
            tmp.path(),
            InstanceLockOptions {
                instance_kind: InstanceKind::DesktopRuntime,
                display_name: "Hubris Desktop Runtime".to_string(),
                listen_url: None,
            },
        )
        .unwrap();

        let metadata = std::fs::read_to_string(tmp.path().join("instance.lock")).unwrap();
        assert!(metadata.contains("\"instance_kind\": \"desktop_runtime\""));
        assert!(metadata.contains("\"display_name\": \"Hubris Desktop Runtime\""));
    }

    #[test]
    fn releasing_lock_allows_reacquire() {
        let tmp = TempDir::new().unwrap();
        {
            let _lock = InstanceLock::acquire(
                tmp.path(),
                InstanceLockOptions {
                    instance_kind: InstanceKind::Server,
                    display_name: "Hubris Server".to_string(),
                    listen_url: Some("http://127.0.0.1:3001".to_string()),
                },
            )
            .unwrap();
        }

        let lock = InstanceLock::acquire(
            tmp.path(),
            InstanceLockOptions {
                instance_kind: InstanceKind::DesktopRuntime,
                display_name: "Hubris Desktop Runtime".to_string(),
                listen_url: None,
            },
        )
        .unwrap();

        assert_eq!(lock.metadata().instance_kind, InstanceKind::DesktopRuntime);
    }
}
