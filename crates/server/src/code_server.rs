use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::extract::ws::{Message as AxumWsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::header::{CONNECTION, COOKIE, HOST, SEC_WEBSOCKET_PROTOCOL, UPGRADE};
use axum::http::{HeaderMap, HeaderValue, Method as HttpMethod, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::future::BoxFuture;
use futures_util::{SinkExt, StreamExt, TryStreamExt};
use reqwest::Method;
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, Notify};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use uuid::Uuid;

use crate::state::AppState;

const DEFAULT_BASE_PATH: &str = "/code";
const DEFAULT_HOST: &str = "127.0.0.1";
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(150);
const REQUEST_BODY_LIMIT: usize = 32 * 1024 * 1024;

type LaunchFn = Arc<
    dyn Fn(
            CodeServerLaunchRequest,
        ) -> BoxFuture<'static, Result<RunningCodeServer, CodeServerError>>
        + Send
        + Sync,
>;

/// Reverse-proxy a browser request to the shared VS Code server.
pub async fn proxy_code_request(State(state): State<AppState>, request: Request) -> Response {
    match try_extract_websocket_upgrade(request).await {
        Ok(UpgradeOutcome::WebSocket(upgrade, request)) => {
            let path_and_query = request
                .uri()
                .path_and_query()
                .map(|value| value.as_str().to_string())
                .unwrap_or_else(|| DEFAULT_BASE_PATH.to_string());
            let headers = request.headers().clone();
            let manager = state.code_server.clone();

            upgrade
                .on_upgrade(move |socket| async move {
                    if let Err(error) =
                        proxy_websocket_connection(manager, socket, path_and_query, headers).await
                    {
                        tracing::warn!("code websocket proxy failed: {error}");
                    }
                })
                .into_response()
        }
        Ok(UpgradeOutcome::Http(request)) => proxy_http_request(state, request).await,
        Err(error) => {
            tracing::warn!("invalid code websocket upgrade: {error}");
            (StatusCode::BAD_REQUEST, error.to_string()).into_response()
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodeServerConnection {
    pub base_url: String,
    pub token: String,
}

impl CodeServerConnection {
    fn http_url(&self, path_and_query: &str) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), path_and_query)
    }

    fn ws_url(&self, path_and_query: &str) -> String {
        let base = self
            .base_url
            .strip_prefix("http://")
            .map(|value| format!("ws://{value}"))
            .or_else(|| {
                self.base_url
                    .strip_prefix("https://")
                    .map(|value| format!("wss://{value}"))
            })
            .unwrap_or_else(|| self.base_url.clone());
        format!("{}{}", base.trim_end_matches('/'), path_and_query)
    }
}

#[derive(Clone)]
pub struct CodeServerManager {
    inner: Arc<Mutex<ManagerState>>,
    notify: Arc<Notify>,
    client: reqwest::Client,
    launch: LaunchFn,
    code_dir: PathBuf,
}

impl fmt::Debug for CodeServerManager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CodeServerManager")
            .field("code_dir", &self.code_dir)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
enum ManagerState {
    Idle,
    Starting,
    Running(RunningCodeServer),
}

#[derive(Debug)]
struct RunningCodeServer {
    connection: CodeServerConnection,
    process: RunningCodeServerProcess,
}

#[derive(Debug)]
enum RunningCodeServerProcess {
    Child(Child),
    #[cfg(test)]
    External,
}

enum UpgradeOutcome {
    Http(Request),
    WebSocket(WebSocketUpgrade, Request),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodeServerLaunchRequest {
    pub host: String,
    pub port: u16,
    pub base_path: String,
    pub token: String,
    pub token_file: PathBuf,
    pub cli_data_dir: PathBuf,
    pub server_data_dir: PathBuf,
}

#[derive(Debug)]
pub enum CodeServerError {
    Io(std::io::Error),
    Http(reqwest::Error),
    Spawn(String),
    StartupTimeout,
    WebSocket(tokio_tungstenite::tungstenite::Error),
}

impl fmt::Display for CodeServerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::Http(error) => write!(f, "{error}"),
            Self::Spawn(message) => write!(f, "{message}"),
            Self::StartupTimeout => write!(f, "timed out waiting for code serve-web"),
            Self::WebSocket(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for CodeServerError {}

impl From<std::io::Error> for CodeServerError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<reqwest::Error> for CodeServerError {
    fn from(value: reqwest::Error) -> Self {
        Self::Http(value)
    }
}

impl From<tokio_tungstenite::tungstenite::Error> for CodeServerError {
    fn from(value: tokio_tungstenite::tungstenite::Error) -> Self {
        Self::WebSocket(value)
    }
}

impl From<axum::Error> for CodeServerError {
    fn from(value: axum::Error) -> Self {
        Self::Io(std::io::Error::other(value))
    }
}

impl CodeServerManager {
    /// Create a manager that launches a shared `code serve-web` instance.
    pub fn new(code_dir: PathBuf) -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|error| panic!("failed to build code server client: {error}"));
        let launch_client = client.clone();
        let launch: LaunchFn = Arc::new(move |request: CodeServerLaunchRequest| {
            let client = launch_client.clone();
            Box::pin(async move { launch_code_server(request, client).await })
        });

        Self {
            inner: Arc::new(Mutex::new(ManagerState::Idle)),
            notify: Arc::new(Notify::new()),
            client,
            launch,
            code_dir,
        }
    }

    #[cfg(test)]
    fn with_launch(code_dir: PathBuf, launch: LaunchFn) -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|error| panic!("failed to build code server client: {error}"));

        Self {
            inner: Arc::new(Mutex::new(ManagerState::Idle)),
            notify: Arc::new(Notify::new()),
            client,
            launch,
            code_dir,
        }
    }

    pub fn http_client(&self) -> &reqwest::Client {
        &self.client
    }

    pub async fn ensure_ready(&self) -> Result<CodeServerConnection, CodeServerError> {
        loop {
            let mut state = self.inner.lock().await;
            match &mut *state {
                ManagerState::Running(server) => {
                    if server.is_alive()? {
                        return Ok(server.connection.clone());
                    }
                    *state = ManagerState::Idle;
                }
                ManagerState::Starting => {
                    let notified = self.notify.notified();
                    drop(state);
                    notified.await;
                    continue;
                }
                ManagerState::Idle => {
                    *state = ManagerState::Starting;
                }
            }
            drop(state);

            let result = (self.launch)(build_launch_request(&self.code_dir)).await;

            let mut state = self.inner.lock().await;
            let outcome = match result {
                Ok(server) => {
                    let connection = server.connection.clone();
                    *state = ManagerState::Running(server);
                    Ok(connection)
                }
                Err(error) => {
                    *state = ManagerState::Idle;
                    Err(error)
                }
            };
            self.notify.notify_waiters();
            return outcome;
        }
    }
}

impl RunningCodeServer {
    fn is_alive(&mut self) -> Result<bool, CodeServerError> {
        match &mut self.process {
            RunningCodeServerProcess::Child(child) => Ok(child.try_wait()?.is_none()),
            #[cfg(test)]
            RunningCodeServerProcess::External => Ok(true),
        }
    }
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

async fn proxy_http_request(state: AppState, request: Request) -> Response {
    let connection = match state.code_server.ensure_ready().await {
        Ok(connection) => connection,
        Err(error) => {
            tracing::error!("failed to ensure code server: {error}");
            return (StatusCode::BAD_GATEWAY, error.to_string()).into_response();
        }
    };

    let (parts, body) = request.into_parts();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| DEFAULT_BASE_PATH.to_string());
    let body = match to_bytes(body, REQUEST_BODY_LIMIT).await {
        Ok(body) => body,
        Err(error) => {
            tracing::warn!("failed to buffer code proxy body: {error}");
            return (StatusCode::PAYLOAD_TOO_LARGE, error.to_string()).into_response();
        }
    };

    let mut upstream = state.code_server.http_client().request(
        reqwest_method(parts.method),
        connection.http_url(&path_and_query),
    );
    upstream = copy_request_headers(upstream, &parts.headers, &connection.token);
    if !body.is_empty() {
        upstream = upstream.body(body);
    }

    match upstream.send().await {
        Ok(response) => build_http_proxy_response(response),
        Err(error) => {
            tracing::warn!("code proxy request failed: {error}");
            (StatusCode::BAD_GATEWAY, error.to_string()).into_response()
        }
    }
}

async fn proxy_websocket_connection(
    manager: Arc<CodeServerManager>,
    browser_socket: WebSocket,
    path_and_query: String,
    headers: HeaderMap,
) -> Result<(), CodeServerError> {
    let connection = manager.ensure_ready().await?;
    let mut upstream_request = connection.ws_url(&path_and_query).into_client_request()?;
    copy_websocket_headers(upstream_request.headers_mut(), &headers, &connection.token)?;
    let (upstream_socket, _) = connect_async(upstream_request).await?;

    let (mut browser_sink, mut browser_stream) = browser_socket.split();
    let (mut upstream_sink, mut upstream_stream) = upstream_socket.split();

    let browser_to_upstream = async {
        while let Some(message) = browser_stream.next().await {
            let Some(message) = map_browser_message(message?) else {
                break;
            };
            upstream_sink.send(message).await?;
        }
        upstream_sink.close().await?;
        Ok::<(), CodeServerError>(())
    };

    let upstream_to_browser = async {
        while let Some(message) = upstream_stream.next().await {
            let Some(message) = map_upstream_message(message?) else {
                break;
            };
            browser_sink
                .send(message)
                .await
                .map_err(std::io::Error::other)?;
        }
        Ok::<(), CodeServerError>(())
    };

    tokio::select! {
        result = browser_to_upstream => result,
        result = upstream_to_browser => result,
    }
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
    token: &str,
) -> reqwest::RequestBuilder {
    let mut builder = builder;
    for (name, value) in headers {
        if *name == COOKIE || *name == CONNECTION || *name == UPGRADE {
            continue;
        }
        builder = builder.header(name, value);
    }

    let cookie = build_upstream_cookie(headers, token);
    if !cookie.is_empty() {
        builder = builder.header(COOKIE, cookie);
    }
    builder
}

fn copy_response_headers(target: &mut HeaderMap, source: &HeaderMap) {
    for (name, value) in source {
        if *name == CONNECTION {
            continue;
        }
        target.append(name, value.clone());
    }
}

fn copy_websocket_headers(
    target: &mut HeaderMap,
    source: &HeaderMap,
    token: &str,
) -> Result<(), CodeServerError> {
    if let Some(host) = source.get(HOST) {
        target.insert(HOST, host.clone());
    }
    if let Some(protocol) = source.get(SEC_WEBSOCKET_PROTOCOL) {
        target.insert(SEC_WEBSOCKET_PROTOCOL, protocol.clone());
    }

    let cookie = build_upstream_cookie(source, token);
    if !cookie.is_empty() {
        target.insert(
            COOKIE,
            HeaderValue::from_str(&cookie)
                .map_err(|error| CodeServerError::Spawn(error.to_string()))?,
        );
    }
    Ok(())
}

fn build_upstream_cookie(headers: &HeaderMap, token: &str) -> String {
    let mut cookies = Vec::new();
    if let Some(cookie) = headers.get(COOKIE).and_then(|value| value.to_str().ok()) {
        for part in cookie.split(';') {
            let part = part.trim();
            if part.is_empty() || part.starts_with("vscode-tkn=") {
                continue;
            }
            cookies.push(part.to_string());
        }
    }
    cookies.push(format!("vscode-tkn={token}"));
    cookies.join("; ")
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

fn build_launch_request(code_dir: &Path) -> CodeServerLaunchRequest {
    let port = pick_unused_port().unwrap_or(8000);
    CodeServerLaunchRequest {
        host: DEFAULT_HOST.to_string(),
        port,
        base_path: DEFAULT_BASE_PATH.to_string(),
        token: Uuid::new_v4().to_string(),
        token_file: code_dir.join("connection-token"),
        cli_data_dir: code_dir.join("cli-data"),
        server_data_dir: code_dir.join("server-data"),
    }
}

fn pick_unused_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind((DEFAULT_HOST, 0))?;
    Ok(listener.local_addr()?.port())
}

async fn launch_code_server(
    request: CodeServerLaunchRequest,
    client: reqwest::Client,
) -> Result<RunningCodeServer, CodeServerError> {
    prepare_dirs(&request).await?;

    let mut child = Command::new("code")
        .arg("serve-web")
        .arg("--host")
        .arg(&request.host)
        .arg("--port")
        .arg(request.port.to_string())
        .arg("--accept-server-license-terms")
        .arg("--server-base-path")
        .arg(&request.base_path)
        .arg("--server-data-dir")
        .arg(&request.server_data_dir)
        .arg("--cli-data-dir")
        .arg(&request.cli_data_dir)
        .arg("--connection-token-file")
        .arg(&request.token_file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            CodeServerError::Spawn(format!("failed to launch `code serve-web`: {error}"))
        })?;

    let connection = CodeServerConnection {
        base_url: format!("http://{}:{}", request.host, request.port),
        token: request.token.clone(),
    };

    if let Err(error) = wait_for_ready(&client, &connection).await {
        let _ = child.kill().await;
        return Err(error);
    }

    Ok(RunningCodeServer {
        connection,
        process: RunningCodeServerProcess::Child(child),
    })
}

async fn prepare_dirs(request: &CodeServerLaunchRequest) -> Result<(), CodeServerError> {
    tokio::fs::create_dir_all(
        request
            .token_file
            .parent()
            .unwrap_or_else(|| Path::new(".")),
    )
    .await?;
    tokio::fs::create_dir_all(&request.cli_data_dir).await?;
    tokio::fs::create_dir_all(&request.server_data_dir).await?;
    tokio::fs::write(&request.token_file, &request.token).await?;
    Ok(())
}

async fn wait_for_ready(
    client: &reqwest::Client,
    connection: &CodeServerConnection,
) -> Result<(), CodeServerError> {
    let started = tokio::time::Instant::now();
    loop {
        let response = client
            .get(connection.http_url(DEFAULT_BASE_PATH))
            .header(COOKIE, format!("vscode-tkn={}", connection.token))
            .send()
            .await;

        match response {
            Ok(response) if response.status() != StatusCode::ACCEPTED => return Ok(()),
            Ok(_) | Err(_) => {}
        }

        if started.elapsed() >= READY_TIMEOUT {
            return Err(CodeServerError::StartupTimeout);
        }
        tokio::time::sleep(READY_POLL_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::extract::Request as AxumRequest;
    use axum::routing::any;
    use axum::{Router, body::Body};

    use super::*;
    use crate::{AppState, build_router};

    #[test]
    fn build_launch_request_uses_hubris_code_dirs() {
        let request = build_launch_request(Path::new("/tmp/hubris/code"));

        assert_eq!(request.base_path, "/code");
        assert!(request.token_file.ends_with("connection-token"));
        assert!(request.cli_data_dir.ends_with("cli-data"));
        assert!(request.server_data_dir.ends_with("server-data"));
    }

    #[test]
    fn build_upstream_cookie_strips_browser_token_cookie() {
        let mut headers = HeaderMap::new();
        headers.insert(
            COOKIE,
            HeaderValue::from_static("theme=dark; vscode-tkn=bad; sidebar=open"),
        );

        let cookie = build_upstream_cookie(&headers, "good");

        assert_eq!(cookie, "theme=dark; sidebar=open; vscode-tkn=good");
    }

    #[tokio::test]
    async fn ensure_ready_serializes_concurrent_startup() {
        let launches = Arc::new(AtomicUsize::new(0));
        let launches_clone = launches.clone();
        let launch: LaunchFn = Arc::new(move |request| {
            let launches = launches_clone.clone();
            Box::pin(async move {
                launches.fetch_add(1, Ordering::Relaxed);
                tokio::time::sleep(Duration::from_millis(25)).await;
                Ok(RunningCodeServer {
                    connection: CodeServerConnection {
                        base_url: format!("http://{}:{}", request.host, request.port),
                        token: request.token,
                    },
                    process: RunningCodeServerProcess::External,
                })
            })
        });
        let manager = CodeServerManager::with_launch(PathBuf::from("/tmp/hubris/code"), launch);

        let (first, second) = tokio::join!(manager.ensure_ready(), manager.ensure_ready());

        assert!(first.is_ok());
        assert!(second.is_ok());
        assert_eq!(launches.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn wait_for_ready_retries_until_server_stops_returning_accepted() {
        let requests = Arc::new(AtomicUsize::new(0));
        let request_counter = requests.clone();
        let app = Router::new().route(
            "/code",
            any(move || {
                let request_counter = request_counter.clone();
                async move {
                    let count = request_counter.fetch_add(1, Ordering::Relaxed);
                    if count < 2 {
                        (StatusCode::ACCEPTED, "warming up").into_response()
                    } else {
                        (StatusCode::OK, "ready").into_response()
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let connection = CodeServerConnection {
            base_url: format!("http://{}", addr),
            token: "test-token".into(),
        };

        wait_for_ready(&client, &connection).await.unwrap();

        assert!(requests.load(Ordering::Relaxed) >= 3);
    }

    #[tokio::test]
    async fn code_proxy_accepts_trailing_slash_root_and_preserves_other_set_cookies() {
        let upstream = Router::new().route(
            "/code/",
            any(|request: AxumRequest<Body>| async move {
                let cookie = request
                    .headers()
                    .get(COOKIE)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let path = request
                    .uri()
                    .path_and_query()
                    .map(|value| value.as_str().to_string())
                    .unwrap_or_default();
                Response::builder()
                    .status(StatusCode::OK)
                    .header(
                        axum::http::header::SET_COOKIE,
                        "vscode-tkn=upstream-secret; Max-Age=60",
                    )
                    .header(axum::http::header::SET_COOKIE, "other-cookie=ok; Path=/")
                    .body(Body::from(format!(
                        "{path}\n{cookie}\n{}",
                        request
                            .headers()
                            .get(HOST)
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or("")
                    )))
                    .unwrap()
            }),
        );
        let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(upstream_listener, upstream).await.unwrap();
        });

        let launch: LaunchFn = Arc::new(move |_request| {
            Box::pin(async move {
                Ok(RunningCodeServer {
                    connection: CodeServerConnection {
                        base_url: format!("http://{}", upstream_addr),
                        token: "hubris-token".into(),
                    },
                    process: RunningCodeServerProcess::External,
                })
            })
        });

        let tmp = tempfile::TempDir::new().unwrap();
        let mut state = AppState::new(tmp.path().to_path_buf()).await;
        state.code_server = Arc::new(CodeServerManager::with_launch(
            tmp.path().join("code"),
            launch,
        ));
        let app = build_router(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{addr}/code/?folder=%2Ftmp%2Fdemo"))
            .header(HOST, format!("proxy.test:{addr}", addr = addr.port()))
            .header(COOKIE, "theme=dark; vscode-tkn=browser-token")
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let set_cookies = response.headers().get_all(axum::http::header::SET_COOKIE);
        let set_cookie_values = set_cookies
            .iter()
            .map(|value| value.to_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            set_cookie_values,
            vec![
                "vscode-tkn=upstream-secret; Max-Age=60".to_string(),
                "other-cookie=ok; Path=/".to_string(),
            ]
        );

        let body = response.text().await.unwrap();
        let mut lines = body.lines();
        let expected_host = format!("proxy.test:{}", addr.port());
        assert_eq!(lines.next(), Some("/code/?folder=%2Ftmp%2Fdemo"));
        assert_eq!(lines.next(), Some("theme=dark; vscode-tkn=hubris-token"),);
        assert_eq!(lines.next(), Some(expected_host.as_str()));
    }
}
