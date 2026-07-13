use std::sync::Arc;

use axum::body::{Body, to_bytes};
use axum::extract::ws::{Message as AxumWsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::header::{
    CONNECTION, COOKIE, HOST, ORIGIN, PROXY_AUTHENTICATE, PROXY_AUTHORIZATION,
    SEC_WEBSOCKET_PROTOCOL, SET_COOKIE, TE, TRAILER, TRANSFER_ENCODING, UPGRADE,
};
use axum::http::{HeaderMap, Method as HttpMethod, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt, TryStreamExt};
use reqwest::Method;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use super::{
    CODE_SERVER_PUBLIC_BASE_PATH, CodeServerError, HUBRIS_PUBLIC_HOST_HEADER,
    HUBRIS_PUBLIC_ORIGIN_HEADER, PUBLIC_CODE_PREFIX, REQUEST_BODY_LIMIT,
    VSCODE_CLI_PUBLIC_BASE_PATH, VSCODE_TOKEN_COOKIE_NAME, VSCODE_TOKEN_QUERY_PARAM,
    VscodeCliError, VscodeConnection, VscodeError, VscodeManager,
};
use crate::domain::settings::VscodeRuntimeKind;
use crate::state::AppState;
use crate::task_manager::TaskActionErrorKind;

/// Reverse-proxy a browser request to the shared code-server instance.
pub async fn proxy_code_request(State(state): State<AppState>, request: Request) -> Response {
    let (runtime, runtime_path) = match runtime_request_target(&request) {
        Ok(target) => target,
        Err(status) => return status.into_response(),
    };

    match try_extract_websocket_upgrade(request).await {
        Ok(UpgradeOutcome::WebSocket(upgrade, request)) => {
            let headers = request.headers().clone();
            let manager = state.vscode.clone();

            upgrade
                .on_upgrade(move |socket| async move {
                    if let Err(error) =
                        proxy_websocket_connection(manager, runtime, socket, runtime_path, headers)
                            .await
                    {
                        tracing::warn!("code-server websocket proxy failed: {error}");
                    }
                })
                .into_response()
        }
        Ok(UpgradeOutcome::Http(request)) => {
            proxy_http_request(state, request, runtime, runtime_path).await
        }
        Err(error) => {
            tracing::warn!("invalid vscode websocket upgrade: {error}");
            (StatusCode::BAD_REQUEST, error.to_string()).into_response()
        }
    }
}
enum UpgradeOutcome {
    Http(Request),
    WebSocket(WebSocketUpgrade, Request),
}
async fn try_extract_websocket_upgrade(
    request: Request,
) -> Result<UpgradeOutcome, axum::extract::ws::rejection::WebSocketUpgradeRejection> {
    use axum::extract::FromRequestParts;

    let (mut parts, body) = request.into_parts();
    if !looks_like_websocket_request(&parts.headers, &parts.method) {
        return Ok(UpgradeOutcome::Http(Request::from_parts(parts, body)));
    }

    WebSocketUpgrade::from_request_parts(&mut parts, &())
        .await
        .map(|upgrade| UpgradeOutcome::WebSocket(upgrade, Request::from_parts(parts, body)))
}

async fn proxy_http_request(
    state: AppState,
    request: Request,
    runtime: VscodeRuntimeKind,
    runtime_path: String,
) -> Response {
    let connection = match state.vscode.ensure_runtime_ready(runtime).await {
        Ok(connection) => connection,
        Err(error) => {
            tracing::error!("failed to ensure vscode runtime: {error}");
            return proxy_error_response(error);
        }
    };

    let (parts, body) = request.into_parts();
    let body = match to_bytes(body, REQUEST_BODY_LIMIT).await {
        Ok(body) => body,
        Err(error) => {
            tracing::warn!("failed to buffer code proxy body: {error}");
            return (StatusCode::PAYLOAD_TOO_LARGE, error.to_string()).into_response();
        }
    };

    let mut upstream = state.vscode.http_client_for(connection.runtime).request(
        reqwest_method(parts.method),
        authorized_http_url(&connection, &runtime_path, &parts.headers),
    );
    upstream = copy_request_headers(upstream, &parts.headers);
    if !body.is_empty() {
        upstream = upstream.body(body);
    }

    match upstream.send().await {
        Ok(response) => build_http_proxy_response(response),
        Err(error) => {
            tracing::warn!("vscode proxy request failed: {error}");
            (StatusCode::BAD_GATEWAY, error.to_string()).into_response()
        }
    }
}

async fn proxy_websocket_connection(
    manager: Arc<VscodeManager>,
    runtime: VscodeRuntimeKind,
    browser_socket: WebSocket,
    runtime_path: String,
    headers: HeaderMap,
) -> Result<(), VscodeError> {
    let connection = manager.ensure_runtime_ready(runtime).await?;
    let mut upstream_request = authorized_ws_url(&connection, &runtime_path, &headers)
        .into_client_request()
        .map_err(CodeServerError::from)
        .map_err(VscodeError::from)?;
    copy_websocket_headers(upstream_request.headers_mut(), &headers);
    let (upstream_socket, _) = connect_async(upstream_request)
        .await
        .map_err(CodeServerError::from)
        .map_err(VscodeError::from)?;

    let (mut browser_sink, mut browser_stream) = browser_socket.split();
    let (mut upstream_sink, mut upstream_stream) = upstream_socket.split();

    let browser_to_upstream = async {
        while let Some(message) = browser_stream.next().await {
            let message = message
                .map_err(CodeServerError::from)
                .map_err(VscodeError::from)?;
            let Some(message) = map_browser_message(message) else {
                break;
            };
            upstream_sink
                .send(message)
                .await
                .map_err(CodeServerError::from)
                .map_err(VscodeError::from)?;
        }
        upstream_sink
            .close()
            .await
            .map_err(CodeServerError::from)
            .map_err(VscodeError::from)?;
        Ok::<(), VscodeError>(())
    };

    let upstream_to_browser = async {
        while let Some(message) = upstream_stream.next().await {
            let message = message
                .map_err(CodeServerError::from)
                .map_err(VscodeError::from)?;
            let Some(message) = map_upstream_message(message) else {
                break;
            };
            browser_sink
                .send(message)
                .await
                .map_err(CodeServerError::from)
                .map_err(VscodeError::from)?;
        }
        Ok::<(), VscodeError>(())
    };

    tokio::select! {
        result = browser_to_upstream => result,
        result = upstream_to_browser => result,
    }
}

fn proxy_error_response(error: VscodeError) -> Response {
    let status = match &error {
        VscodeError::CodeServer(error) => match error {
            CodeServerError::NotInstalled => StatusCode::SERVICE_UNAVAILABLE,
            CodeServerError::UnsupportedPlatform(_)
            | CodeServerError::InvalidVersion(_)
            | CodeServerError::InvalidReleaseRedirect(_) => StatusCode::BAD_REQUEST,
            CodeServerError::StartupTimeout => StatusCode::BAD_GATEWAY,
            CodeServerError::Io(_)
            | CodeServerError::Http(_)
            | CodeServerError::Archive(_)
            | CodeServerError::Spawn(_)
            | CodeServerError::WebSocket(_) => StatusCode::BAD_GATEWAY,
        },
        VscodeError::VscodeCli(error) => match error {
            VscodeCliError::NotInstalled => StatusCode::SERVICE_UNAVAILABLE,
            VscodeCliError::UnsupportedPlatform(_) | VscodeCliError::InvalidVersion(_) => {
                StatusCode::BAD_REQUEST
            }
            VscodeCliError::StartupTimeout => StatusCode::BAD_GATEWAY,
            VscodeCliError::Io(_)
            | VscodeCliError::Http(_)
            | VscodeCliError::Archive(_)
            | VscodeCliError::Spawn(_) => StatusCode::BAD_GATEWAY,
        },
        VscodeError::Task(error) => match error.kind() {
            TaskActionErrorKind::NotFound => StatusCode::NOT_FOUND,
            TaskActionErrorKind::InvalidRequest => StatusCode::BAD_REQUEST,
            TaskActionErrorKind::Conflict => StatusCode::CONFLICT,
            TaskActionErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        },
    };
    (status, error.to_string()).into_response()
}

fn build_http_proxy_response(response: reqwest::Response) -> Response {
    let mut builder = Response::builder().status(response.status());
    if let Some(headers) = builder.headers_mut() {
        copy_response_headers(headers, response.headers());
    }
    let body = Body::from_stream(response.bytes_stream().map_err(std::io::Error::other));
    builder
        .body(body)
        .unwrap_or_else(|error| panic!("failed to build proxy response: {error}"))
}

fn copy_request_headers(
    builder: reqwest::RequestBuilder,
    headers: &HeaderMap,
) -> reqwest::RequestBuilder {
    let mut builder = builder;
    for (name, value) in headers {
        if *name == CONNECTION
            || *name == UPGRADE
            || *name == HOST
            || *name == ORIGIN
            || name.as_str() == HUBRIS_PUBLIC_HOST_HEADER
            || name.as_str() == HUBRIS_PUBLIC_ORIGIN_HEADER
        {
            continue;
        }
        builder = builder.header(name, value);
    }
    if let Some(host) = forwarded_public_host(headers) {
        builder = builder.header(HOST, host);
    }
    if let Some(origin) = forwarded_public_origin(headers) {
        builder = builder.header(ORIGIN, origin);
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

fn is_hop_by_hop_header(name: &axum::http::HeaderName) -> bool {
    *name == CONNECTION
        || *name == axum::http::HeaderName::from_static("keep-alive")
        || *name == PROXY_AUTHENTICATE
        || *name == PROXY_AUTHORIZATION
        || *name == TE
        || *name == TRAILER
        || *name == TRANSFER_ENCODING
        || *name == UPGRADE
}

fn copy_websocket_headers(target: &mut HeaderMap, source: &HeaderMap) {
    if let Some(host) = forwarded_public_host(source) {
        target.insert(HOST, host.clone());
    }
    if let Some(protocol) = source.get(SEC_WEBSOCKET_PROTOCOL) {
        target.insert(SEC_WEBSOCKET_PROTOCOL, protocol.clone());
    }
    if let Some(cookie) = source.get(axum::http::header::COOKIE) {
        target.insert(axum::http::header::COOKIE, cookie.clone());
    }
    if let Some(origin) = forwarded_public_origin(source) {
        target.insert(axum::http::header::ORIGIN, origin.clone());
    }
}

pub(super) fn forwarded_public_host(headers: &HeaderMap) -> Option<&axum::http::HeaderValue> {
    headers
        .get(HUBRIS_PUBLIC_HOST_HEADER)
        .or_else(|| headers.get(HOST))
}

pub(super) fn forwarded_public_origin(headers: &HeaderMap) -> Option<&axum::http::HeaderValue> {
    headers
        .get(HUBRIS_PUBLIC_ORIGIN_HEADER)
        .or_else(|| headers.get(ORIGIN))
}

fn map_browser_message(message: AxumWsMessage) -> Option<TungsteniteMessage> {
    match message {
        AxumWsMessage::Text(text) => Some(TungsteniteMessage::Text(text.to_string().into())),
        AxumWsMessage::Binary(bytes) => Some(TungsteniteMessage::Binary(bytes)),
        AxumWsMessage::Ping(bytes) => Some(TungsteniteMessage::Ping(bytes)),
        AxumWsMessage::Pong(bytes) => Some(TungsteniteMessage::Pong(bytes)),
        AxumWsMessage::Close(_) => None,
    }
}

fn map_upstream_message(message: TungsteniteMessage) -> Option<AxumWsMessage> {
    match message {
        TungsteniteMessage::Text(text) => Some(AxumWsMessage::Text(text.to_string().into())),
        TungsteniteMessage::Binary(bytes) => Some(AxumWsMessage::Binary(bytes)),
        TungsteniteMessage::Ping(bytes) => Some(AxumWsMessage::Ping(bytes)),
        TungsteniteMessage::Pong(bytes) => Some(AxumWsMessage::Pong(bytes)),
        TungsteniteMessage::Frame(_) => None,
        TungsteniteMessage::Close(_) => None,
    }
}

fn reqwest_method(method: axum::http::Method) -> Method {
    Method::from_bytes(method.as_str().as_bytes())
        .unwrap_or_else(|error| panic!("unsupported request method {}: {error}", method))
}

fn looks_like_websocket_request(headers: &HeaderMap, method: &HttpMethod) -> bool {
    if *method != HttpMethod::GET {
        return false;
    }

    let is_upgrade = headers
        .get(UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    let has_upgrade_connection = headers
        .get(CONNECTION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .any(|part| part.trim().eq_ignore_ascii_case("upgrade"))
        });

    is_upgrade && has_upgrade_connection
}

pub fn public_base_path(runtime: VscodeRuntimeKind) -> &'static str {
    match runtime {
        VscodeRuntimeKind::CodeServer => CODE_SERVER_PUBLIC_BASE_PATH,
        VscodeRuntimeKind::VscodeCli => VSCODE_CLI_PUBLIC_BASE_PATH,
    }
}

fn runtime_request_target(request: &Request) -> Result<(VscodeRuntimeKind, String), StatusCode> {
    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or(PUBLIC_CODE_PREFIX);

    request_target_from_public_path(path_and_query).ok_or(StatusCode::NOT_FOUND)
}

pub(super) fn request_target_from_public_path(
    path_and_query: &str,
) -> Option<(VscodeRuntimeKind, String)> {
    for runtime in [VscodeRuntimeKind::VscodeCli, VscodeRuntimeKind::CodeServer] {
        if let Some(stripped) = path_and_query.strip_prefix(public_base_path(runtime)) {
            return Some((runtime, normalize_runtime_path(stripped)));
        }
    }

    None
}

pub(super) fn normalize_runtime_path(path_and_query: &str) -> String {
    if path_and_query.is_empty() {
        "/".to_string()
    } else if path_and_query.starts_with('/') || path_and_query.starts_with('?') {
        format!("/{}", path_and_query.trim_start_matches('/'))
    } else {
        format!("/{path_and_query}")
    }
}

pub(super) fn authorized_http_url(
    connection: &VscodeConnection,
    path_and_query: &str,
    headers: &HeaderMap,
) -> String {
    let path_and_query = maybe_add_vscode_auth(connection, path_and_query, headers);
    connection.http_url(&path_and_query)
}

fn authorized_ws_url(
    connection: &VscodeConnection,
    path_and_query: &str,
    headers: &HeaderMap,
) -> String {
    let path_and_query = maybe_add_vscode_auth(connection, path_and_query, headers);
    connection.ws_url(&path_and_query)
}

fn maybe_add_vscode_auth(
    connection: &VscodeConnection,
    path_and_query: &str,
    headers: &HeaderMap,
) -> String {
    if connection.runtime != VscodeRuntimeKind::VscodeCli {
        return path_and_query.to_string();
    }

    let Some(token) = connection.connection_token.as_deref() else {
        return path_and_query.to_string();
    };

    if request_has_current_vscode_auth(headers, path_and_query, token) {
        return path_and_query.to_string();
    }

    upsert_query_param(path_and_query, VSCODE_TOKEN_QUERY_PARAM, token)
}

fn request_has_current_vscode_auth(
    headers: &HeaderMap,
    path_and_query: &str,
    current_token: &str,
) -> bool {
    headers
        .get(COOKIE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|cookie| cookie_token(cookie).is_some_and(|token| token == current_token))
        || query_param_value(path_and_query, VSCODE_TOKEN_QUERY_PARAM)
            .is_some_and(|token| token == current_token)
}

fn cookie_token(cookie_header: &str) -> Option<&str> {
    cookie_header.split(';').find_map(|part| {
        let trimmed = part.trim_start();
        let prefix = format!("{VSCODE_TOKEN_COOKIE_NAME}=");
        trimmed.strip_prefix(&prefix)
    })
}

fn query_param_value<'a>(path_and_query: &'a str, key: &str) -> Option<&'a str> {
    let (_, query) = path_and_query.split_once('?')?;
    query.split('&').find_map(|part| {
        let (param_key, value) = part.split_once('=')?;
        (param_key == key).then_some(value)
    })
}

pub(super) fn upsert_query_param(path_and_query: &str, key: &str, value: &str) -> String {
    let (path, query) = match path_and_query.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (path_and_query, None),
    };

    let mut params = query
        .into_iter()
        .flat_map(|query| query.split('&'))
        .filter(|part| !part.is_empty())
        .filter_map(|part| {
            let (param_key, param_value) = part.split_once('=')?;
            (param_key != key).then_some((param_key, param_value))
        })
        .collect::<Vec<_>>();
    params.push((key, value));

    if params.is_empty() {
        return path.to_string();
    }

    let query = params
        .into_iter()
        .map(|(param_key, param_value)| format!("{param_key}={param_value}"))
        .collect::<Vec<_>>()
        .join("&");
    format!("{path}?{query}")
}

pub(super) fn extract_vscode_token_cookie(headers: &HeaderMap) -> Option<String> {
    headers.get_all(SET_COOKIE).iter().find_map(|value| {
        let cookie = value.to_str().ok()?;
        let first = cookie.split(';').next()?.trim();
        if first.starts_with(&format!("{VSCODE_TOKEN_COOKIE_NAME}=")) {
            Some(first.to_string())
        } else {
            None
        }
    })
}
