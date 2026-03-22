use std::path::Path;

pub async fn sync_parent_directory(path: &Path) -> Result<(), std::io::Error> {
    let parent = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    tokio::task::spawn_blocking(move || {
        let dir = open_directory_for_sync(&parent)?;
        dir.sync_all()
    })
    .await
    .map_err(|join_error| std::io::Error::other(join_error.to_string()))?
}

#[cfg(not(windows))]
fn open_directory_for_sync(path: &Path) -> Result<std::fs::File, std::io::Error> {
    std::fs::File::open(path)
}

#[cfg(windows)]
fn open_directory_for_sync(path: &Path) -> Result<std::fs::File, std::io::Error> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    #[tokio::test]
    async fn sync_parent_directory_succeeds_for_regular_file_parent() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("demo.txt");
        std::fs::write(&path, "hello\n").unwrap();

        sync_parent_directory(&path).await.unwrap();
    }
}
