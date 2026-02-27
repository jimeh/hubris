use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "../../frontend/dist"]
pub struct Assets;

/// Serve an embedded file by URI path, falling back to
/// index.html for SPA client-side routing.
pub async fn spa_handler(
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let path = uri.path().trim_start_matches('/');

    // Try exact path first, then fall back to index.html.
    if let Some(file) = Assets::get(path) {
        return file_response(&file, &headers);
    }
    if let Some(file) = Assets::get("index.html") {
        return file_response(&file, &headers);
    }

    (StatusCode::NOT_FOUND, "frontend not available")
        .into_response()
}

fn etag(file: &rust_embed::EmbeddedFile) -> String {
    let hash = file.metadata.sha256_hash();
    format!(
        "\"{}\"",
        hash.iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

fn file_response(
    file: &rust_embed::EmbeddedFile,
    req_headers: &HeaderMap,
) -> Response {
    let etag_value = etag(file);

    // If client has matching ETag, return 304.
    if let Some(if_none_match) =
        req_headers.get(header::IF_NONE_MATCH)
    {
        if if_none_match.as_bytes()
            == etag_value.as_bytes()
        {
            return (
                StatusCode::NOT_MODIFIED,
                [(header::ETAG, etag_value)],
            )
                .into_response();
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
