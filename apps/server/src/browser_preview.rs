use std::sync::LazyLock;

use axum::body::{Body, to_bytes};
use axum::extract::{Path, Request};
use axum::http::header::{
    CONNECTION, HOST, PROXY_AUTHENTICATE, PROXY_AUTHORIZATION, TE, TRAILER, TRANSFER_ENCODING,
    UPGRADE,
};
use axum::http::{HeaderMap, HeaderName, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::TryStreamExt;

const REQUEST_BODY_LIMIT: usize = 32 * 1024 * 1024;
static PREVIEW_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);

pub async fn proxy_browser_preview_request_root(
    Path((scheme, authority)): Path<(String, String)>,
    request: Request,
) -> Response {
    proxy_browser_preview_request_inner(request, scheme, authority, None).await
}

pub async fn proxy_browser_preview_request(
    Path((scheme, authority, path)): Path<(String, String, String)>,
    request: Request,
) -> Response {
    proxy_browser_preview_request_inner(request, scheme, authority, Some(path)).await
}

async fn proxy_browser_preview_request_inner(
    request: Request,
    scheme: String,
    authority: String,
    path: Option<String>,
) -> Response {
    let Some(upstream_url) =
        browser_preview_upstream_url(request.uri().query(), &scheme, &authority, path.as_deref())
    else {
        return (
            StatusCode::BAD_REQUEST,
            "Browser preview only supports loopback http:// and https:// URLs.",
        )
            .into_response();
    };

    let (parts, body) = request.into_parts();
    let body = match to_bytes(body, REQUEST_BODY_LIMIT).await {
        Ok(body) => body,
        Err(error) => {
            tracing::warn!("failed to buffer browser preview proxy body: {error}");
            return (StatusCode::PAYLOAD_TOO_LARGE, error.to_string()).into_response();
        }
    };

    let mut upstream = PREVIEW_CLIENT.request(reqwest_method(parts.method), upstream_url);
    upstream = copy_request_headers(upstream, &parts.headers);
    if !body.is_empty() {
        upstream = upstream.body(body);
    }

    match upstream.send().await {
        Ok(response) => build_http_proxy_response(response),
        Err(error) => {
            tracing::warn!("browser preview proxy request failed: {error}");
            (StatusCode::BAD_GATEWAY, error.to_string()).into_response()
        }
    }
}

pub fn browser_preview_upstream_url(
    query: Option<&str>,
    scheme: &str,
    authority: &str,
    path: Option<&str>,
) -> Option<String> {
    if scheme != "http" && scheme != "https" {
        return None;
    }

    let normalized_path = match path {
        Some(path) if !path.is_empty() => format!("/{}", path.trim_start_matches('/')),
        _ => "/".to_string(),
    };
    let candidate = match query {
        Some(query) if !query.is_empty() => {
            format!("{scheme}://{authority}{normalized_path}?{query}")
        }
        _ => format!("{scheme}://{authority}{normalized_path}"),
    };

    is_allowed_loopback_url(&candidate).then_some(candidate)
}

fn is_allowed_loopback_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };

    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return false;
    }

    matches!(
        parsed.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("::1")
    )
}

fn build_http_proxy_response(response: reqwest::Response) -> Response {
    let mut builder = Response::builder().status(response.status());
    if let Some(headers) = builder.headers_mut() {
        copy_response_headers(headers, response.headers());
    }
    let body = Body::from_stream(response.bytes_stream().map_err(std::io::Error::other));
    builder
        .body(body)
        .unwrap_or_else(|error| panic!("failed to build browser preview response: {error}"))
}

fn copy_request_headers(
    builder: reqwest::RequestBuilder,
    headers: &HeaderMap,
) -> reqwest::RequestBuilder {
    let mut builder = builder;
    for (name, value) in headers {
        if *name == CONNECTION || *name == UPGRADE || *name == HOST {
            continue;
        }
        builder = builder.header(name, value);
    }
    builder
}

fn copy_response_headers(target: &mut HeaderMap, source: &HeaderMap) {
    for (name, value) in source {
        if is_hop_by_hop_header(name) {
            continue;
        }
        target.append(name, value.clone());
    }
}

fn is_hop_by_hop_header(name: &HeaderName) -> bool {
    *name == CONNECTION
        || *name == HeaderName::from_static("keep-alive")
        || *name == PROXY_AUTHENTICATE
        || *name == PROXY_AUTHORIZATION
        || *name == TE
        || *name == TRAILER
        || *name == TRANSFER_ENCODING
        || *name == UPGRADE
}

fn reqwest_method(method: axum::http::Method) -> reqwest::Method {
    reqwest::Method::from_bytes(method.as_str().as_bytes())
        .unwrap_or_else(|error| panic!("unsupported request method {}: {error}", method))
}
