//! Release workflow helper for hubris.
//!
//! The tag-triggered release workflow keeps its shell steps thin by delegating
//! version resolution, asset packaging, and changelog extraction to this
//! binary, so the interesting logic stays unit tested instead of living in
//! untestable YAML.

use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use clap::{Parser, Subcommand};
use markdown::mdast::{Heading, Node};
use markdown::{ParseOptions, to_mdast};

/// Boxed error type shared by the helper's fallible operations.
type BoxError = Box<dyn std::error::Error>;

/// Name of the server binary produced by the `hubris-server` package.
const SERVER_BIN: &str = "hubris-server";

/// Asset name prefix used for packaged Electron desktop bundles.
const DESKTOP_ASSET: &str = "hubris-desktop";

/// Documentation files copied into server archives when they exist.
///
/// hubris currently ships no `LICENSE` file, so these are best-effort.
const OPTIONAL_DOCS: [&str; 2] = ["README.md", "LICENSE"];

/// Disambiguates staging directories when packaging runs concurrently.
static PACKAGE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Top-level release helper command-line arguments.
#[derive(Debug, Parser)]
#[command(name = "hubris-release-helper")]
#[command(about = "Release workflow helper for hubris")]
struct Args {
    #[command(subcommand)]
    command: Commands,
}

/// Release helper subcommands used by workflow wrapper scripts.
#[derive(Debug, Subcommand)]
enum Commands {
    /// Derive a release version from an override, tag ref, or git describe.
    Version {
        /// Version override, with or without a leading v.
        #[arg(long, env = "HUBRIS_RELEASE_VERSION")]
        version: Option<String>,
        /// GitHub ref type.
        #[arg(long, env = "GITHUB_REF_TYPE")]
        github_ref_type: Option<String>,
        /// GitHub ref name.
        #[arg(long, env = "GITHUB_REF_NAME")]
        github_ref_name: Option<String>,
        /// Output GitHub Actions step outputs to this file.
        #[arg(long, env = "GITHUB_OUTPUT")]
        github_output: Option<PathBuf>,
    },
    /// Package a built hubris-server binary into release assets.
    PackageServer {
        /// Rust target triple.
        target: String,
        /// Release version, without the v prefix.
        version: String,
        /// Output directory for release assets.
        dist_dir: PathBuf,
    },
    /// Normalize an Electron desktop bundle into a release asset.
    PackageDesktop {
        /// Rust target triple the desktop bundle was built for.
        target: String,
        /// Release version, without the v prefix.
        version: String,
        /// Output directory for release assets.
        dist_dir: PathBuf,
    },
    /// Extract release notes for a version from CHANGELOG.md.
    Notes {
        /// Release version, with or without a leading v.
        version: String,
        /// Output file for the extracted release notes.
        output: PathBuf,
        /// Changelog path.
        #[arg(long, default_value = "CHANGELOG.md")]
        changelog: PathBuf,
    },
}

/// Run the helper and report errors in a workflow-friendly format.
fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

/// Dispatch the selected release helper subcommand.
fn run() -> Result<(), BoxError> {
    match Args::parse().command {
        Commands::Version {
            version,
            github_ref_type,
            github_ref_name,
            github_output,
        } => {
            let version = resolve_version(
                version.as_deref(),
                github_ref_type.as_deref(),
                github_ref_name.as_deref(),
            )?;
            if let Some(output) = github_output {
                write_version_outputs(&version, &output)?;
            } else {
                println!("{}", version.version);
            }
        }
        Commands::PackageServer {
            target,
            version,
            dist_dir,
        } => package_server_asset(&target, &version, &dist_dir)?,
        Commands::PackageDesktop {
            target,
            version,
            dist_dir,
        } => package_desktop_asset(&target, &version, &dist_dir)?,
        Commands::Notes {
            version,
            output,
            changelog,
        } => {
            let notes = release_notes(&changelog, &version)?;
            fs::write(output, notes)?;
        }
    }

    Ok(())
}

/// Resolved release version metadata shared across workflow jobs.
#[derive(Debug, Eq, PartialEq)]
struct VersionInfo {
    tag: String,
    version: String,
    safe_version: String,
    is_tag: bool,
}

/// Resolve the release version from explicit input, tag context, or Git.
fn resolve_version(
    override_version: Option<&str>,
    github_ref_type: Option<&str>,
    github_ref_name: Option<&str>,
) -> Result<VersionInfo, BoxError> {
    resolve_version_with(override_version, github_ref_type, github_ref_name, || {
        git_output([
            "describe", "--tags", "--dirty", "--always", "--match", "v[0-9]*",
        ])
        .or_else(|_| git_output(["rev-parse", "--short", "HEAD"]))
    })
}

/// Resolve a release version against an injected Git description.
///
/// `describe` is only consulted for the non-tag fallback, and is a parameter so
/// tests can exercise that branch without depending on the repository the test
/// process happens to run in.
fn resolve_version_with(
    override_version: Option<&str>,
    github_ref_type: Option<&str>,
    github_ref_name: Option<&str>,
    describe: impl FnOnce() -> Result<String, BoxError>,
) -> Result<VersionInfo, BoxError> {
    if let Some(version) = override_version.filter(|value| !value.is_empty()) {
        let version = version.trim_start_matches('v').to_owned();
        return Ok(version_info(format!("v{version}"), version, false));
    }

    if github_ref_type == Some("tag") {
        let ref_name = github_ref_name.ok_or("missing github ref name for tag event")?;
        let version = ref_name
            .strip_prefix('v')
            .ok_or_else(|| format!("invalid release tag '{ref_name}', expected vX.Y.Z"))?;
        if !is_strict_release_version(version) {
            return Err(format!("invalid release tag '{ref_name}', expected vX.Y.Z").into());
        }

        let version = version.to_owned();
        return Ok(version_info(format!("v{version}"), version, true));
    }

    let describe = describe()?;
    let version = describe.trim_start_matches('v').to_owned();
    let tag = format!("v{version}");

    Ok(version_info(tag, version, false))
}

/// Build the normalized version metadata used by release workflow outputs.
fn version_info(tag: String, version: String, is_tag: bool) -> VersionInfo {
    let safe_version = version
        .chars()
        .map(|character| match character {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '.' | '_' | '-' => character,
            _ => '-',
        })
        .collect();

    VersionInfo {
        tag,
        version,
        safe_version,
        is_tag,
    }
}

/// Return whether a tag version has the strict numeric X.Y.Z release shape.
fn is_strict_release_version(version: &str) -> bool {
    let mut parts = version.split('.');
    matches!(
        (parts.next(), parts.next(), parts.next(), parts.next()),
        (Some(major), Some(minor), Some(patch), None)
            if !major.is_empty()
                && !minor.is_empty()
                && !patch.is_empty()
                && major.chars().all(|value| value.is_ascii_digit())
                && minor.chars().all(|value| value.is_ascii_digit())
                && patch.chars().all(|value| value.is_ascii_digit())
    )
}

/// Run a Git command and return trimmed UTF-8 stdout.
fn git_output<I, S>(args: I) -> Result<String, BoxError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = Command::new("git").args(args).output()?;
    if !output.status.success() {
        return Err(format!("git command failed with status {}", output.status).into());
    }

    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

/// Append release version metadata to the GitHub Actions output file.
fn write_version_outputs(version: &VersionInfo, output: &Path) -> Result<(), BoxError> {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(output)?;
    writeln!(file, "tag={}", version.tag)?;
    writeln!(file, "version={}", version.version)?;
    writeln!(file, "safe_version={}", version.safe_version)?;
    writeln!(file, "is_tag={}", version.is_tag)?;

    Ok(())
}

/// Package a built hubris-server binary into raw and archived assets.
fn package_server_asset(target: &str, version: &str, dist_dir: &Path) -> Result<(), BoxError> {
    package_server_asset_in_project(Path::new("."), target, version, dist_dir)
}

/// Package server release assets from a specific project root.
fn package_server_asset_in_project(
    project_dir: &Path,
    target: &str,
    version: &str,
    dist_dir: &Path,
) -> Result<(), BoxError> {
    let binary = project_dir.join(format!("target/{target}/release/{SERVER_BIN}"));
    if !binary.is_file() {
        return Err(format!("missing release binary: {}", binary.display()).into());
    }

    let dist_dir = resolve_project_path(project_dir, dist_dir);
    fs::create_dir_all(&dist_dir)?;
    let raw_asset = dist_dir.join(format!("{SERVER_BIN}-{target}"));
    fs::copy(&binary, &raw_asset)?;
    make_executable(&raw_asset)?;

    let temp_dir = staging_dir(target, version);
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir)?;
    }
    fs::create_dir_all(&temp_dir)?;

    let payload_name = format!("{SERVER_BIN}-{version}-{target}");
    let payload_dir = temp_dir.join(&payload_name);
    fs::create_dir_all(&payload_dir)?;
    let payload_binary = payload_dir.join(SERVER_BIN);
    fs::copy(&binary, &payload_binary)?;
    make_executable(&payload_binary)?;

    // hubris has no LICENSE file yet, so documentation is copied only when
    // present rather than being a hard packaging requirement.
    for doc in OPTIONAL_DOCS {
        let source = project_dir.join(doc);
        if source.is_file() {
            fs::copy(&source, payload_dir.join(doc))?;
        }
    }

    let result = create_tar_archive(
        &dist_dir.join(format!("{SERVER_BIN}-{target}.tar.gz")),
        &payload_dir,
        &payload_name,
    );

    fs::remove_dir_all(&temp_dir)?;
    result
}

/// Build a unique staging directory path for one packaging run.
fn staging_dir(target: &str, version: &str) -> PathBuf {
    let sequence = PACKAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed);

    env::temp_dir().join(format!(
        "hubris-release-{}-{sequence}-{target}-{version}",
        std::process::id()
    ))
}

/// Copy the Electron desktop bundle into the release asset directory.
fn package_desktop_asset(target: &str, version: &str, dist_dir: &Path) -> Result<(), BoxError> {
    package_desktop_asset_in_project(Path::new("."), target, version, dist_dir)
}

/// Package the desktop bundle from a specific project root.
fn package_desktop_asset_in_project(
    project_dir: &Path,
    target: &str,
    version: &str,
    dist_dir: &Path,
) -> Result<(), BoxError> {
    let (platform, arch) = desktop_platform_arch(target)?;
    let bundle_dir = project_dir.join(format!("dist/make/zip/{platform}/{arch}"));
    let bundle = find_desktop_bundle(&bundle_dir, platform, arch, version)?;

    let dist_dir = resolve_project_path(project_dir, dist_dir);
    fs::create_dir_all(&dist_dir)?;
    let asset = dist_dir.join(format!("{DESKTOP_ASSET}-{target}.zip"));
    fs::copy(&bundle, &asset)?;

    Ok(())
}

/// Map a Rust target triple onto its Electron Forge platform and arch.
fn desktop_platform_arch(target: &str) -> Result<(&'static str, &'static str), BoxError> {
    match target {
        "x86_64-apple-darwin" => Ok(("darwin", "x64")),
        "aarch64-apple-darwin" => Ok(("darwin", "arm64")),
        _ => Err(format!("unsupported desktop target: {target}").into()),
    }
}

/// Locate the Electron bundle Forge built for exactly this release version.
///
/// Electron Forge names bundles after the desktop `package.json` version,
/// which release-please keeps in sync with the release tag, so the exact
/// name is required rather than preferred. Falling back to "whatever zip is
/// in the directory" would relabel a wrong-version bundle as this release.
/// Nothing is lost by being strict: `.mise/tasks/build-desktop-target`
/// clears the output directory before building, and
/// `scripts/verify-desktop-package.sh` already enforces a single artifact.
/// A mismatch is therefore a real build/version bug, and the error names
/// both the expected file and whatever was actually present.
fn find_desktop_bundle(
    bundle_dir: &Path,
    platform: &str,
    arch: &str,
    version: &str,
) -> Result<PathBuf, BoxError> {
    let expected = bundle_dir.join(format!("Hubris-{platform}-{arch}-{version}.zip"));
    if expected.is_file() {
        return Ok(expected);
    }

    let found = list_desktop_bundles(bundle_dir)?;
    if found.is_empty() {
        return Err(format!("missing desktop bundle: {}", expected.display()).into());
    }

    Err(format!(
        "missing desktop bundle: {}, found: {}",
        expected.display(),
        found.join(", ")
    )
    .into())
}

/// List the zip file names present in an Electron Forge output directory.
fn list_desktop_bundles(bundle_dir: &Path) -> Result<Vec<String>, BoxError> {
    let mut bundles = Vec::new();
    if bundle_dir.is_dir() {
        for entry in fs::read_dir(bundle_dir)? {
            let path = entry?.path();
            if path.is_file() && path.extension() == Some(OsStr::new("zip")) {
                bundles.push(
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }
    bundles.sort();

    Ok(bundles)
}

/// Resolve a path relative to the project root unless it is already absolute.
fn resolve_project_path(project_dir: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_owned()
    } else {
        project_dir.join(path)
    }
}

#[cfg(unix)]
/// Mark a packaged Unix binary as executable.
fn make_executable(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
}

#[cfg(not(unix))]
/// Leave executable metadata unchanged on non-Unix platforms.
fn make_executable(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// Create the tar.gz archive for a target release payload.
fn create_tar_archive(
    archive: &Path,
    payload_dir: &Path,
    payload_name: &str,
) -> Result<(), BoxError> {
    let status = Command::new("tar")
        .args(["-C"])
        .arg(
            payload_dir
                .parent()
                .ok_or("payload directory has no parent")?,
        )
        .args(["-czf"])
        .arg(archive)
        .arg(payload_name)
        .status()?;
    if !status.success() {
        return Err(format!("tar failed with status {status}").into());
    }

    Ok(())
}

/// Return release notes for a version, falling back when no changelog exists.
fn release_notes(changelog: &Path, version: &str) -> Result<String, BoxError> {
    if !changelog.is_file() {
        return Ok(fallback_notes(version));
    }

    let markdown = fs::read_to_string(changelog)?;
    extract_release_notes(&markdown, version).map_or_else(
        || Ok(fallback_notes(version)),
        |notes| Ok(normalize_notes(notes)),
    )
}

/// Extract the body under a matching level-2 changelog heading.
fn extract_release_notes<'a>(markdown: &'a str, version: &str) -> Option<&'a str> {
    let root = to_mdast(markdown, &ParseOptions::default()).ok()?;
    let children = root.children()?;
    let target_version = normalize_version(version);

    for (index, node) in children.iter().enumerate() {
        let Node::Heading(heading) = node else {
            continue;
        };
        if heading.depth != 2 || normalize_heading_text(heading) != target_version {
            continue;
        }

        let start = heading.position.as_ref()?.end.offset;
        let end = children[index + 1..]
            .iter()
            .find_map(|next| match next {
                Node::Heading(next_heading) if next_heading.depth <= heading.depth => next_heading
                    .position
                    .as_ref()
                    .map(|position| position.start.offset),
                _ => None,
            })
            .unwrap_or(markdown.len());

        return markdown.get(start..end);
    }

    None
}

/// Trim surrounding whitespace and keep one trailing newline for notes.
fn normalize_notes(notes: &str) -> String {
    let trimmed = notes.trim_matches(|value: char| value.is_whitespace());
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("{trimmed}\n")
    }
}

/// Build default release notes when the changelog has no matching section.
fn fallback_notes(version: &str) -> String {
    format!("Release v{}\n", normalize_version(version))
}

/// Normalize a Markdown heading node into a comparable version string.
fn normalize_heading_text(heading: &Heading) -> String {
    let text = plain_text(&heading.children);
    normalize_version_heading(&text)
}

/// Extract and normalize the version token from a changelog heading.
fn normalize_version_heading(text: &str) -> String {
    let text = text.trim();
    let text = text.strip_prefix('[').unwrap_or(text);
    let text = text.split(']').next().unwrap_or(text);
    let text = text.split_whitespace().next().unwrap_or(text);
    normalize_version(text)
}

/// Normalize a version by trimming whitespace and a leading v prefix.
fn normalize_version(version: &str) -> String {
    version.trim().trim_start_matches('v').to_owned()
}

/// Flatten a sequence of phrasing Markdown nodes into plain text.
fn plain_text(nodes: &[Node]) -> String {
    let mut output = String::new();
    for node in nodes {
        append_plain_text(node, &mut output);
    }
    output
}

/// Append supported text-bearing Markdown nodes to a plain-text buffer.
fn append_plain_text(node: &Node, output: &mut String) {
    match node {
        Node::Text(text) => output.push_str(&text.value),
        Node::InlineCode(code) => output.push_str(&code.value),
        Node::Emphasis(node) => output.push_str(&plain_text(&node.children)),
        Node::Strong(node) => output.push_str(&plain_text(&node.children)),
        Node::Delete(node) => output.push_str(&plain_text(&node.children)),
        Node::Link(node) => output.push_str(&plain_text(&node.children)),
        Node::LinkReference(node) => output.push_str(&plain_text(&node.children)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Explicit overrides accept a leading v but do not mark a tag run.
    #[test]
    fn normalizes_explicit_version_with_v_prefix() {
        assert_eq!(
            resolve_version(Some("v1.2.3"), None, None).unwrap(),
            VersionInfo {
                tag: "v1.2.3".to_owned(),
                version: "1.2.3".to_owned(),
                safe_version: "1.2.3".to_owned(),
                is_tag: false,
            }
        );
    }

    /// Explicit overrides without a v prefix still produce a v-prefixed tag.
    #[test]
    fn normalizes_explicit_version_without_v_prefix() {
        assert_eq!(
            resolve_version(Some("1.2.3"), None, None).unwrap(),
            VersionInfo {
                tag: "v1.2.3".to_owned(),
                version: "1.2.3".to_owned(),
                safe_version: "1.2.3".to_owned(),
                is_tag: false,
            }
        );
    }

    /// An empty override falls through to the other resolution sources.
    #[test]
    fn empty_override_falls_through_to_tag_context() {
        assert_eq!(
            resolve_version(Some(""), Some("tag"), Some("v4.5.6")).unwrap(),
            VersionInfo {
                tag: "v4.5.6".to_owned(),
                version: "4.5.6".to_owned(),
                safe_version: "4.5.6".to_owned(),
                is_tag: true,
            }
        );
    }

    /// GitHub tag refs resolve to a tag release when the ref is vX.Y.Z.
    #[test]
    fn detects_github_tag_version() {
        assert_eq!(
            resolve_version(None, Some("tag"), Some("v1.2.3")).unwrap(),
            VersionInfo {
                tag: "v1.2.3".to_owned(),
                version: "1.2.3".to_owned(),
                safe_version: "1.2.3".to_owned(),
                is_tag: true,
            }
        );
    }

    /// GitHub tag events fail when GitHub did not provide a ref name.
    #[test]
    fn rejects_missing_github_tag_ref_name() {
        let error = resolve_version(None, Some("tag"), None)
            .unwrap_err()
            .to_string();

        assert_eq!(error, "missing github ref name for tag event");
    }

    /// GitHub tag events fail when the ref does not start with v.
    #[test]
    fn rejects_github_tag_without_v_prefix() {
        let error = resolve_version(None, Some("tag"), Some("1.2.3"))
            .unwrap_err()
            .to_string();

        assert_eq!(error, "invalid release tag '1.2.3', expected vX.Y.Z");
    }

    /// GitHub tag events fail when the ref is not strict vX.Y.Z.
    #[test]
    fn rejects_non_strict_github_tag_version() {
        let error = resolve_version(None, Some("tag"), Some("v1.2.3-beta.1"))
            .unwrap_err()
            .to_string();

        assert_eq!(
            error,
            "invalid release tag 'v1.2.3-beta.1', expected vX.Y.Z"
        );
    }

    /// Strict release versions require exactly three numeric segments.
    #[test]
    fn validates_strict_release_versions() {
        assert!(is_strict_release_version("1.2.3"));
        assert!(!is_strict_release_version("1.2"));
        assert!(!is_strict_release_version("1.2.3.4"));
        assert!(!is_strict_release_version("1.2.beta"));
        assert!(!is_strict_release_version("1..3"));
    }

    /// Artifact names replace characters that are unsafe in artifacts.
    #[test]
    fn safe_version_replaces_artifact_unsafe_characters() {
        assert_eq!(
            version_info("v1.2.3".to_owned(), "1.2.3+dirty build".to_owned(), false).safe_version,
            "1.2.3-dirty-build"
        );
    }

    /// Git-derived non-tag runs use the full described version as their tag.
    #[test]
    fn derived_version_keeps_git_describe_detail() {
        let version =
            resolve_version_with(None, None, None, || Ok("v1.2.3-4-gabc1234".to_owned())).unwrap();

        assert_eq!(version.version, "1.2.3-4-gabc1234");
        assert_eq!(version.tag, "v1.2.3-4-gabc1234");
        assert!(!version.is_tag);
    }

    /// A dirty working tree keeps its describe suffix in the derived version.
    #[test]
    fn derived_version_preserves_dirty_suffix() {
        let version =
            resolve_version_with(None, None, None, || Ok("v1.2.3-dirty".to_owned())).unwrap();

        assert_eq!(version.version, "1.2.3-dirty");
        assert!(!version.is_tag);
    }

    /// With no tags at all, describe falls back to a bare short SHA.
    #[test]
    fn derived_version_falls_back_to_short_sha() {
        let version = resolve_version_with(None, None, None, || Ok("abc1234".to_owned())).unwrap();

        assert_eq!(version.version, "abc1234");
        assert_eq!(version.tag, "vabc1234");
        assert!(!version.is_tag);
    }

    /// A failing Git description propagates instead of inventing a version.
    #[test]
    fn derived_version_propagates_describe_failure() {
        let error = resolve_version_with(None, None, None, || Err("git exploded".into()))
            .expect_err("describe failure must not yield a version");

        assert_eq!(error.to_string(), "git exploded");
    }

    /// Version metadata appends key-value pairs to GitHub output files.
    #[test]
    fn writes_github_outputs() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("outputs");

        write_version_outputs(
            &VersionInfo {
                tag: "v1.2.3".to_owned(),
                version: "1.2.3".to_owned(),
                safe_version: "1.2.3".to_owned(),
                is_tag: true,
            },
            &output,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(output).unwrap(),
            "tag=v1.2.3\nversion=1.2.3\nsafe_version=1.2.3\nis_tag=true\n"
        );
    }

    /// Writing outputs must append, because `$GITHUB_OUTPUT` is one file shared
    /// by every step in the job. Truncating it would erase earlier steps.
    #[test]
    fn preserves_existing_github_outputs() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("outputs");
        fs::write(&output, "earlier_step=kept\n").unwrap();

        write_version_outputs(
            &VersionInfo {
                tag: "v1.2.3".to_owned(),
                version: "1.2.3".to_owned(),
                safe_version: "1.2.3".to_owned(),
                is_tag: true,
            },
            &output,
        )
        .unwrap();

        let written = fs::read_to_string(&output).unwrap();
        assert!(
            written.starts_with("earlier_step=kept\n"),
            "earlier step output was clobbered: {written:?}"
        );
        assert!(written.contains("tag=v1.2.3\n"));
    }

    /// Packaging creates the raw binary and tar.gz assets for a target.
    #[test]
    fn packages_server_release_assets() {
        let project = server_fixture("x86_64-unknown-linux-gnu");
        fs::write(project.path().join("LICENSE"), "license").unwrap();
        let dist_dir = project.path().join("release-dist");

        package_server_asset_in_project(
            project.path(),
            "x86_64-unknown-linux-gnu",
            "1.2.3",
            &dist_dir,
        )
        .unwrap();

        let raw_asset = dist_dir.join("hubris-server-x86_64-unknown-linux-gnu");
        assert_eq!(fs::read(&raw_asset).unwrap(), b"binary");

        // The published binary has to stay runnable after download.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = fs::metadata(&raw_asset).unwrap().permissions().mode();
            assert_ne!(
                mode & 0o111,
                0,
                "packaged binary is not executable: mode {mode:o}"
            );
        }

        let entries = tar_entries(&dist_dir.join("hubris-server-x86_64-unknown-linux-gnu.tar.gz"));
        let prefix = "hubris-server-1.2.3-x86_64-unknown-linux-gnu";
        assert!(entries.contains(&format!("{prefix}/hubris-server")));
        assert!(entries.contains(&format!("{prefix}/README.md")));
        assert!(entries.contains(&format!("{prefix}/LICENSE")));
    }

    /// Packaging still succeeds when the repository has no LICENSE file.
    #[test]
    fn packages_server_assets_without_license() {
        let project = server_fixture("aarch64-apple-darwin");
        let dist_dir = project.path().join("release-dist");

        package_server_asset_in_project(project.path(), "aarch64-apple-darwin", "1.2.3", &dist_dir)
            .unwrap();

        assert!(
            dist_dir
                .join("hubris-server-aarch64-apple-darwin")
                .is_file()
        );

        let entries = tar_entries(&dist_dir.join("hubris-server-aarch64-apple-darwin.tar.gz"));
        let prefix = "hubris-server-1.2.3-aarch64-apple-darwin";
        assert!(entries.contains(&format!("{prefix}/hubris-server")));
        assert!(entries.contains(&format!("{prefix}/README.md")));
        assert!(!entries.contains(&format!("{prefix}/LICENSE")));
    }

    /// Packaging fails loudly when the target build produced no binary.
    #[test]
    fn rejects_missing_server_binary() {
        let project = tempfile::tempdir().unwrap();
        let dist_dir = project.path().join("release-dist");

        let error = package_server_asset_in_project(
            project.path(),
            "x86_64-unknown-linux-gnu",
            "1.2.3",
            &dist_dir,
        )
        .unwrap_err()
        .to_string();

        assert_eq!(
            error,
            format!(
                "missing release binary: {}",
                project
                    .path()
                    .join("target/x86_64-unknown-linux-gnu/release/hubris-server")
                    .display()
            )
        );
        assert!(!dist_dir.exists());
    }

    /// Desktop packaging renames the versioned Forge bundle to its asset.
    #[test]
    fn packages_desktop_bundle() {
        let project = desktop_fixture("arm64", "Hubris-darwin-arm64-1.2.3.zip");
        let dist_dir = project.path().join("release-dist");

        package_desktop_asset_in_project(
            project.path(),
            "aarch64-apple-darwin",
            "1.2.3",
            &dist_dir,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(dist_dir.join("hubris-desktop-aarch64-apple-darwin.zip")).unwrap(),
            "bundle"
        );
    }

    /// A leftover bundle beside the current one does not shadow it.
    #[test]
    fn packages_desktop_bundle_alongside_stale_bundle() {
        let project = desktop_fixture("x64", "Hubris-darwin-x64-1.2.3.zip");
        add_desktop_bundle(&project, "x64", "Hubris-darwin-x64-1.2.2.zip", "stale");
        let dist_dir = project.path().join("release-dist");

        package_desktop_asset_in_project(project.path(), "x86_64-apple-darwin", "1.2.3", &dist_dir)
            .unwrap();

        assert_eq!(
            fs::read_to_string(dist_dir.join("hubris-desktop-x86_64-apple-darwin.zip")).unwrap(),
            "bundle"
        );
    }

    /// A bundle built from a different version is never relabelled.
    #[test]
    fn rejects_wrong_version_desktop_bundle() {
        let project = desktop_fixture("x64", "Hubris-darwin-x64-0.1.0.zip");
        let dist_dir = project.path().join("release-dist");

        let error = package_desktop_asset_in_project(
            project.path(),
            "x86_64-apple-darwin",
            "0.0.2",
            &dist_dir,
        )
        .unwrap_err()
        .to_string();

        assert_eq!(
            error,
            format!(
                "missing desktop bundle: {}, found: Hubris-darwin-x64-0.1.0.zip",
                project
                    .path()
                    .join("dist/make/zip/darwin/x64/Hubris-darwin-x64-0.0.2.zip")
                    .display()
            )
        );
        assert!(!dist_dir.exists());
    }

    /// Desktop packaging fails when Electron Forge produced no bundle.
    #[test]
    fn rejects_missing_desktop_bundle() {
        let project = tempfile::tempdir().unwrap();
        let dist_dir = project.path().join("release-dist");

        let error = package_desktop_asset_in_project(
            project.path(),
            "aarch64-apple-darwin",
            "1.2.3",
            &dist_dir,
        )
        .unwrap_err()
        .to_string();

        assert_eq!(
            error,
            format!(
                "missing desktop bundle: {}",
                project
                    .path()
                    .join(
                        "dist/make/zip/darwin/arm64/\
                         Hubris-darwin-arm64-1.2.3.zip"
                    )
                    .display()
            )
        );
        assert!(!dist_dir.exists());
    }

    /// The mismatch error lists every bundle present, so builds are debuggable.
    #[test]
    fn desktop_bundle_error_lists_every_present_bundle() {
        let project = desktop_fixture("arm64", "Hubris-darwin-arm64-1.2.2.zip");
        add_desktop_bundle(&project, "arm64", "Hubris-darwin-arm64-1.2.1.zip", "stale");
        let dist_dir = project.path().join("release-dist");

        let error = package_desktop_asset_in_project(
            project.path(),
            "aarch64-apple-darwin",
            "1.2.3",
            &dist_dir,
        )
        .unwrap_err()
        .to_string();

        assert!(
            error.ends_with(
                "found: Hubris-darwin-arm64-1.2.1.zip, \
                 Hubris-darwin-arm64-1.2.2.zip"
            ),
            "unexpected error: {error}"
        );
        assert!(!dist_dir.exists());
    }

    /// Only the supported macOS desktop targets can be packaged.
    #[test]
    fn rejects_unsupported_desktop_target() {
        let project = tempfile::tempdir().unwrap();

        let error = package_desktop_asset_in_project(
            project.path(),
            "x86_64-unknown-linux-gnu",
            "1.2.3",
            &project.path().join("release-dist"),
        )
        .unwrap_err()
        .to_string();

        assert_eq!(
            error,
            "unsupported desktop target: x86_64-unknown-linux-gnu"
        );
    }

    /// Server fixtures mirror the release workflow's expected layout.
    fn server_fixture(target: &str) -> tempfile::TempDir {
        let project = tempfile::tempdir().unwrap();
        fs::write(project.path().join("README.md"), "readme").unwrap();

        let binary_dir = project.path().join(format!("target/{target}/release"));
        fs::create_dir_all(&binary_dir).unwrap();
        fs::write(binary_dir.join("hubris-server"), "binary").unwrap();

        project
    }

    /// Desktop fixtures mirror Electron Forge's zip maker output layout.
    fn desktop_fixture(arch: &str, bundle: &str) -> tempfile::TempDir {
        let project = tempfile::tempdir().unwrap();
        let bundle_dir = project.path().join(format!("dist/make/zip/darwin/{arch}"));
        fs::create_dir_all(&bundle_dir).unwrap();
        fs::write(bundle_dir.join(bundle), "bundle").unwrap();

        project
    }

    /// Add another zip to a desktop fixture's Forge output directory.
    fn add_desktop_bundle(project: &tempfile::TempDir, arch: &str, bundle: &str, contents: &str) {
        let bundle_dir = project.path().join(format!("dist/make/zip/darwin/{arch}"));
        fs::write(bundle_dir.join(bundle), contents).unwrap();
    }

    /// List the entry names inside a packaged tar.gz archive.
    fn tar_entries(archive: &Path) -> Vec<String> {
        let output = Command::new("tar")
            .arg("-tzf")
            .arg(archive)
            .output()
            .unwrap();
        assert!(output.status.success());

        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| line.trim_end_matches('/').to_owned())
            .collect()
    }

    /// Changelog extraction preserves Markdown inside a release section.
    #[test]
    fn extracts_matching_release_section() {
        let changelog = "\
# Changelog

## [v1.2.3](https://example.test/releases/tag/v1.2.3) (2026-06-21)

### Features

- Keep **formatting** intact.

```text
## not a heading
```

## [v1.2.2] (2026-06-20)

- Old note.
";

        assert_eq!(
            extract_release_notes(changelog, "1.2.3").map(normalize_notes),
            Some(
                "\
### Features

- Keep **formatting** intact.

```text
## not a heading
```
"
                .to_owned()
            )
        );
    }

    /// Plain headings match version inputs with or without a leading v.
    #[test]
    fn extracts_unlinked_version_heading() {
        let changelog = "\
# Changelog

## 1.2.3

- Note.
";

        assert_eq!(
            extract_release_notes(changelog, "v1.2.3").map(normalize_notes),
            Some("- Note.\n".to_owned())
        );
    }

    /// Bracketed headings without a link definition still match a version.
    #[test]
    fn extracts_bracketed_version_heading() {
        let changelog = "\
# Changelog

## [1.2.3] - 2026-06-21

- Note.
";

        assert_eq!(
            extract_release_notes(changelog, "1.2.3").map(normalize_notes),
            Some("- Note.\n".to_owned())
        );
    }

    /// Extraction stops at the next release heading of the same level.
    #[test]
    fn stops_at_same_level_heading() {
        let changelog = "\
# Changelog

## v1.2.3

- Note.

## v1.2.2

- Not part of the release.
";

        assert_eq!(
            extract_release_notes(changelog, "1.2.3").map(normalize_notes),
            Some("- Note.\n".to_owned())
        );
    }

    /// Extraction stops at a higher-level heading that ends the section.
    #[test]
    fn stops_at_higher_heading() {
        let changelog = "\
# Changelog

## v1.2.3

- Note.

# Other

- Not part of the release.
";

        assert_eq!(
            extract_release_notes(changelog, "1.2.3").map(normalize_notes),
            Some("- Note.\n".to_owned())
        );
    }

    /// Missing changelog sections return no extracted body.
    #[test]
    fn returns_none_when_version_is_missing() {
        assert_eq!(extract_release_notes("# Changelog\n", "1.2.3"), None);
    }

    /// Missing changelog files produce fallback release notes.
    #[test]
    fn release_notes_falls_back_when_changelog_is_missing() {
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(
            release_notes(&dir.path().join("missing.md"), "v1.2.3").unwrap(),
            "Release v1.2.3\n"
        );
    }

    /// An existing changelog without the version still yields fallback notes.
    #[test]
    fn release_notes_falls_back_when_version_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let changelog = dir.path().join("CHANGELOG.md");
        fs::write(&changelog, "# Changelog\n\n## v1.2.2\n\n- Old.\n").unwrap();

        assert_eq!(
            release_notes(&changelog, "1.2.3").unwrap(),
            "Release v1.2.3\n"
        );
    }

    /// Release notes read the matching section straight from a file.
    #[test]
    fn release_notes_reads_matching_section_from_file() {
        let dir = tempfile::tempdir().unwrap();
        let changelog = dir.path().join("CHANGELOG.md");
        fs::write(&changelog, "# Changelog\n\n## v1.2.3\n\n- New.\n").unwrap();

        assert_eq!(release_notes(&changelog, "v1.2.3").unwrap(), "- New.\n");
    }
}
