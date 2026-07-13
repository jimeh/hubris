use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const API_DEPENDENCY_ALLOWLIST: &[&str] = &[];

const MODULE_SIZE_WARNING_LINES: usize = 2_000;
const MODULE_SIZE_FAILURE_LINES: usize = 7_000;

fn rust_source_files(source_root: &Path) -> Vec<PathBuf> {
    let mut directories = vec![source_root.to_path_buf()];
    let mut files = Vec::new();

    while let Some(directory) = directories.pop() {
        let entries = fs::read_dir(&directory)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", directory.display()));

        for entry in entries {
            let path = entry
                .unwrap_or_else(|error| {
                    panic!(
                        "failed to read an entry in {}: {error}",
                        directory.display()
                    )
                })
                .path();
            if path.is_dir() {
                directories.push(path);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                files.push(path);
            }
        }
    }

    files.sort();
    files
}

fn source_path(source_root: &Path, path: &Path) -> String {
    Path::new("src")
        .join(path.strip_prefix(source_root).unwrap_or_else(|error| {
            panic!(
                "{} is not below {}: {error}",
                path.display(),
                source_root.display()
            )
        }))
        .to_string_lossy()
        .into_owned()
}

fn read_source(path: &Path) -> String {
    fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()))
}

#[test]
fn non_api_modules_do_not_add_api_dependencies() {
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let violations = rust_source_files(&source_root)
        .into_iter()
        .filter_map(|path| {
            let relative_path = source_path(&source_root, &path);
            if relative_path.starts_with("src/api/") || !read_source(&path).contains("crate::api") {
                None
            } else {
                Some(relative_path)
            }
        })
        .collect::<BTreeSet<_>>();
    let allowlist = API_DEPENDENCY_ALLOWLIST
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();

    let new_violations = violations
        .iter()
        .filter(|path| !allowlist.contains(path.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let clean_allowlist_entries = allowlist
        .iter()
        .filter(|path| !violations.contains(**path))
        .copied()
        .collect::<Vec<_>>();

    assert!(
        new_violations.is_empty() && clean_allowlist_entries.is_empty(),
        "non-api modules must not import crate::api; move shared types or functions out of api/: \
         {new_violations:?}\n\
         allowlist entries no longer needed; delete them: {clean_allowlist_entries:?}"
    );
}

#[test]
fn rust_modules_warn_before_reaching_the_hard_size_ceiling() {
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut oversized_modules = Vec::new();

    for path in rust_source_files(&source_root) {
        let line_count = read_source(&path).lines().count();
        let relative_path = source_path(&source_root, &path);

        if line_count > MODULE_SIZE_WARNING_LINES {
            eprintln!(
                "module-size warning: {relative_path} has {line_count} lines \
                 (warning ceiling: {MODULE_SIZE_WARNING_LINES})"
            );
        }
        if line_count > MODULE_SIZE_FAILURE_LINES {
            oversized_modules.push(format!("{relative_path} ({line_count} lines)"));
        }
    }

    assert!(
        oversized_modules.is_empty(),
        "module-size hard ceiling exceeded ({MODULE_SIZE_FAILURE_LINES} lines): \
         {oversized_modules:?}"
    );
}
