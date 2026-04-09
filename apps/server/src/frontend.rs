use std::io;
use std::path::{Path, PathBuf};

use axum::Router;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get_service;
use tower_http::services::{ServeDir, ServeFile};

/// Frontend asset source for SPA fallback routes.
#[derive(Clone, Debug, Default)]
pub enum FrontendAssets {
    #[default]
    Disabled,
    #[cfg(feature = "embed-frontend")]
    Embedded,
    Directory(PathBuf),
}

impl FrontendAssets {
    /// Return a disabled SPA asset source.
    pub const fn disabled() -> Self {
        Self::Disabled
    }

    /// Return an embedded SPA asset source.
    #[cfg(feature = "embed-frontend")]
    pub const fn embedded() -> Self {
        Self::Embedded
    }

    /// Validate and use a filesystem directory for SPA assets.
    pub fn from_dir(path: impl Into<PathBuf>) -> io::Result<Self> {
        let path = path.into();
        validate_frontend_dir(&path)?;
        Ok(Self::Directory(path))
    }
}

/// Apply SPA fallback routing for the chosen frontend asset source.
pub fn apply_frontend_fallback(router: Router, frontend: FrontendAssets) -> Router {
    match frontend {
        FrontendAssets::Disabled => router.fallback(disabled_spa_handler),
        #[cfg(feature = "embed-frontend")]
        FrontendAssets::Embedded => router.fallback(embedded_spa_handler),
        FrontendAssets::Directory(path) => {
            let index = path.join("index.html");
            router.fallback_service(get_service(
                ServeDir::new(path).fallback(ServeFile::new(index)),
            ))
        }
    }
}

fn validate_frontend_dir(path: &Path) -> io::Result<()> {
    let meta = std::fs::metadata(path).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "frontend asset directory {} is not available: {error}",
                path.display()
            ),
        )
    })?;

    if !meta.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "frontend asset directory {} is not a directory",
                path.display()
            ),
        ));
    }

    let index = path.join("index.html");
    let index_meta = std::fs::metadata(&index).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "frontend asset entrypoint {} is not available: {error}",
                index.display()
            ),
        )
    })?;

    if !index_meta.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "frontend asset entrypoint {} is not a file",
                index.display()
            ),
        ));
    }

    Ok(())
}

#[cfg(feature = "embed-frontend")]
mod embedded {
    use super::*;
    use axum::http::{HeaderMap, Uri, header};
    use rust_embed::Embed;

    #[derive(Embed)]
    #[folder = "../web/dist"]
    pub struct Assets;

    /// Serve an embedded file by URI path, falling back to
    /// index.html for SPA client-side routing.
    pub async fn spa_handler(headers: HeaderMap, uri: Uri) -> Response {
        let path = uri.path().trim_start_matches('/');

        if let Some(file) = Assets::get(path) {
            return file_response(&file, &headers);
        }
        if let Some(file) = Assets::get("index.html") {
            return file_response(&file, &headers);
        }

        (StatusCode::NOT_FOUND, "frontend not available").into_response()
    }

    fn etag(file: &rust_embed::EmbeddedFile) -> String {
        let hash = file.metadata.sha256_hash();
        format!(
            "\"{}\"",
            hash.iter().map(|b| format!("{b:02x}")).collect::<String>()
        )
    }

    fn file_response(file: &rust_embed::EmbeddedFile, req_headers: &HeaderMap) -> Response {
        let etag_value = etag(file);

        if let Some(if_none_match) = req_headers.get(header::IF_NONE_MATCH) {
            if if_none_match.as_bytes() == etag_value.as_bytes() {
                return (StatusCode::NOT_MODIFIED, [(header::ETAG, etag_value)]).into_response();
            }
        }

        let mime = file.metadata.mimetype();
        (
            [
                (header::CONTENT_TYPE, mime.to_string()),
                (header::ETAG, etag_value),
            ],
            file.data.clone(),
        )
            .into_response()
    }
}

#[cfg(feature = "embed-frontend")]
use embedded::spa_handler as embedded_spa_handler;

async fn disabled_spa_handler() -> Response {
    (StatusCode::NOT_FOUND, "frontend not embedded").into_response()
}
