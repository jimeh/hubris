use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::{Body, to_bytes};
use axum::extract::ws::{Message as AxumWsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::header::{
    CONNECTION, HOST, PROXY_AUTHENTICATE, PROXY_AUTHORIZATION, SEC_WEBSOCKET_PROTOCOL, TE, TRAILER,
    TRANSFER_ENCODING, UPGRADE,
};
use axum::http::{HeaderMap, Method as HttpMethod, StatusCode};
use axum::response::{IntoResponse, Response};
use flate2::read::GzDecoder;
use futures_util::future::BoxFuture;
use futures_util::{SinkExt, StreamExt, TryStreamExt};
use reqwest::Method;
use semver::Version;
use tar::Archive;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, Notify};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use uuid::Uuid;

use crate::state::AppState;

const PUBLIC_BASE_PATH: &str = "/code";
const UPSTREAM_READY_PATH: &str = "/";
const DEFAULT_HOST: &str = "127.0.0.1";
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(150);
const REQUEST_BODY_LIMIT: usize = 32 * 1024 * 1024;
const RELEASES_BASE_URL: &str = "https://github.com/coder/code-server/releases";
const RUNTIMES_DIR: &str = "runtimes";
const USER_DIR: &str = "user";
const EXTENSIONS_DIR: &str = "extensions";
const CONFIG_DIR: &str = "config";
const TMP_DIR: &str = "tmp";

type FetchLatestFn =
    Arc<dyn Fn() -> BoxFuture<'static, Result<String, CodeServerError>> + Send + Sync>;
type DownloadRuntimeFn = Arc<
    dyn Fn(
            CodeServerDownloadRequest,
        ) -> BoxFuture<'static, Result<InstalledRuntime, CodeServerError>>
        + Send
        + Sync,
>;
type LaunchFn = Arc<
    dyn Fn(
            CodeServerLaunchRequest,
        ) -> BoxFuture<'static, Result<RunningCodeServer, CodeServerError>>
        + Send
        + Sync,
>;

/// Reverse-proxy a browser request to the shared code-server instance.
pub async fn proxy_code_request(State(state): State<AppState>, request: Request) -> Response {
    match try_extract_websocket_upgrade(request).await {
        Ok(UpgradeOutcome::WebSocket(upgrade, request)) => {
            let path_and_query = strip_public_base_path(&request);
            let headers = request.headers().clone();
            let manager = state.code_server.clone();

            upgrade
                .on_upgrade(move |socket| async move {
                    if let Err(error) =
                        proxy_websocket_connection(manager, socket, path_and_query, headers).await
                    {
                        tracing::warn!("code-server websocket proxy failed: {error}");
                    }
                })
                .into_response()
        }
        Ok(UpgradeOutcome::Http(request)) => proxy_http_request(state, request).await,
        Err(error) => {
            tracing::warn!("invalid code-server websocket upgrade: {error}");
            (StatusCode::BAD_REQUEST, error.to_string()).into_response()
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodeServerConnection {
    pub base_url: String,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodeServerProcessStatusValue {
    Running,
    Stopped,
    Starting,
    Stopping,
    Installing,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagerCodeServerLatestCheck {
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub checked_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodeServerStatusSnapshot {
    pub supported: bool,
    pub installed_version: Option<String>,
    pub process_status: CodeServerProcessStatusValue,
    pub latest: Option<ManagerCodeServerLatestCheck>,
    pub message: Option<String>,
}

#[derive(Clone)]
pub struct CodeServerManager {
    inner: Arc<Mutex<ManagerState>>,
    notify: Arc<Notify>,
    client: reqwest::Client,
    fetch_latest: FetchLatestFn,
    download_runtime: DownloadRuntimeFn,
    launch: LaunchFn,
    root_dir: PathBuf,
}

impl fmt::Debug for CodeServerManager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CodeServerManager")
            .field("root_dir", &self.root_dir)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct ManagerState {
    lifecycle: LifecycleState,
    latest: Option<ManagerCodeServerLatestCheck>,
}

#[derive(Debug)]
enum LifecycleState {
    Stopped,
    Starting,
    Stopping,
    Installing,
    Running(Box<RunningCodeServer>),
    Error(String),
}

#[derive(Debug)]
struct RunningCodeServer {
    connection: CodeServerConnection,
    process: RunningCodeServerProcess,
}

#[cfg(test)]
#[derive(Debug, Clone)]
struct TestProcessProbe {
    alive: Arc<std::sync::atomic::AtomicBool>,
    shutdowns: Arc<std::sync::atomic::AtomicUsize>,
    drop_kills: Arc<std::sync::atomic::AtomicUsize>,
}

#[derive(Debug)]
enum RunningCodeServerProcess {
    Child(Child),
    #[cfg(test)]
    External,
    #[cfg(test)]
    TestProbe(TestProcessProbe),
}

enum UpgradeOutcome {
    Http(Request),
    WebSocket(WebSocketUpgrade, Request),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CodeServerPlatform {
    os: &'static str,
    arch: &'static str,
}

#[derive(Clone, Debug)]
struct InstalledRuntime {
    version: String,
    version_semver: Version,
    platform: CodeServerPlatform,
    runtime_dir: PathBuf,
    binary_path: PathBuf,
}

#[derive(Clone, Debug)]
struct CodeServerDownloadRequest {
    root_dir: PathBuf,
    version: String,
    platform: CodeServerPlatform,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodeServerLaunchRequest {
    pub runtime_dir: PathBuf,
    pub binary_path: PathBuf,
    pub host: String,
    pub port: u16,
    pub user_data_dir: PathBuf,
    pub extensions_dir: PathBuf,
    pub config_file: PathBuf,
}

#[derive(Debug)]
pub enum CodeServerError {
    Io(std::io::Error),
    Http(reqwest::Error),
    Archive(String),
    Spawn(String),
    StartupTimeout,
    UnsupportedPlatform(String),
    InvalidReleaseRedirect(String),
    InvalidVersion(String),
    NotInstalled,
    WebSocket(tokio_tungstenite::tungstenite::Error),
}

impl fmt::Display for CodeServerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::Http(error) => write!(f, "{error}"),
            Self::Archive(message) => write!(f, "{message}"),
            Self::Spawn(message) => write!(f, "{message}"),
            Self::StartupTimeout => write!(f, "timed out waiting for code-server"),
            Self::UnsupportedPlatform(message) => write!(f, "{message}"),
            Self::InvalidReleaseRedirect(message) => write!(f, "{message}"),
            Self::InvalidVersion(message) => write!(f, "{message}"),
            Self::NotInstalled => write!(f, "code-server is not installed"),
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
    /// Create a manager that launches a shared `code-server` instance.
    pub fn new(root_dir: PathBuf) -> Self {
        let metadata_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|error| panic!("failed to build code-server client: {error}"));
        let fetch_client = metadata_client.clone();
        let fetch_latest: FetchLatestFn =
            Arc::new(move || Box::pin(fetch_latest_version(fetch_client.clone())));
        let download_client = reqwest::Client::new();
        let download_runtime: DownloadRuntimeFn =
            Arc::new(move |request: CodeServerDownloadRequest| {
                Box::pin(download_runtime_archive(request, download_client.clone()))
            });
        let ready_client = reqwest::Client::new();
        let launch: LaunchFn = Arc::new(move |request: CodeServerLaunchRequest| {
            let ready_client = ready_client.clone();
            Box::pin(async move { launch_code_server(request, ready_client).await })
        });

        Self {
            inner: Arc::new(Mutex::new(ManagerState {
                lifecycle: LifecycleState::Stopped,
                latest: None,
            })),
            notify: Arc::new(Notify::new()),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_else(|error| {
                    panic!("failed to build code-server proxy client: {error}")
                }),
            fetch_latest,
            download_runtime,
            launch,
            root_dir,
        }
    }

    #[cfg(test)]
    fn with_hooks(
        root_dir: PathBuf,
        fetch_latest: FetchLatestFn,
        download_runtime: DownloadRuntimeFn,
        launch: LaunchFn,
    ) -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|error| panic!("failed to build code-server client: {error}"));

        Self {
            inner: Arc::new(Mutex::new(ManagerState {
                lifecycle: LifecycleState::Stopped,
                latest: None,
            })),
            notify: Arc::new(Notify::new()),
            client,
            fetch_latest,
            download_runtime,
            launch,
            root_dir,
        }
    }

    pub fn http_client(&self) -> &reqwest::Client {
        &self.client
    }

    pub async fn status(&self) -> CodeServerStatusSnapshot {
        let supported = detect_platform().is_ok();
        let installed = self.find_installed_runtime().await.ok().flatten();
        let mut state = self.inner.lock().await;
        let exited = normalize_dead_process(&mut state).unwrap_or_default();

        let (process_status, mut message) = match &state.lifecycle {
            LifecycleState::Running(_) => (CodeServerProcessStatusValue::Running, None),
            LifecycleState::Starting => (CodeServerProcessStatusValue::Starting, None),
            LifecycleState::Stopping => (CodeServerProcessStatusValue::Stopping, None),
            LifecycleState::Installing => (CodeServerProcessStatusValue::Installing, None),
            LifecycleState::Stopped => (CodeServerProcessStatusValue::Stopped, None),
            LifecycleState::Error(message) => {
                (CodeServerProcessStatusValue::Error, Some(message.clone()))
            }
        };

        if message.is_none() {
            if let Err(error) = detect_platform() {
                message = Some(error.to_string());
            } else if exited {
                message = Some("code-server exited".to_string());
            }
        }

        CodeServerStatusSnapshot {
            supported,
            installed_version: installed.map(|runtime| runtime.version),
            process_status,
            latest: state.latest.clone(),
            message,
        }
    }

    pub async fn check_for_update(&self) -> Result<CodeServerStatusSnapshot, CodeServerError> {
        let latest = (self.fetch_latest)().await?;
        let installed = self.find_installed_runtime().await?;
        let update_available = installed
            .as_ref()
            .map(|runtime| {
                Version::parse(&latest).is_ok_and(|version| runtime.version_semver < version)
            })
            .unwrap_or(false);

        {
            let mut state = self.inner.lock().await;
            state.latest = Some(ManagerCodeServerLatestCheck {
                latest_version: Some(latest),
                update_available,
                checked_at: Some(now_timestamp_string()),
            });
        }

        Ok(self.status().await)
    }

    pub async fn install(
        &self,
        requested_version: Option<String>,
    ) -> Result<CodeServerStatusSnapshot, CodeServerError> {
        let previous = self
            .begin_lifecycle_transition(LifecycleTransition::Installing)
            .await?;
        shutdown_previous(previous).await?;

        let platform = detect_platform()?;
        let version = match requested_version {
            Some(version) => normalize_version(&version)?,
            None => (self.fetch_latest)().await?,
        };

        let target = (self.download_runtime)(CodeServerDownloadRequest {
            root_dir: self.root_dir.clone(),
            version,
            platform,
        })
        .await;

        let runtime = match target {
            Ok(runtime) => runtime,
            Err(error) => {
                self.finish_with_error(error.to_string()).await;
                return Err(error);
            }
        };

        if let Err(error) = cleanup_other_platform_runtimes(
            self.root_dir.clone(),
            runtime.platform,
            &runtime.runtime_dir,
        )
        .await
        {
            self.finish_with_error(error.to_string()).await;
            return Err(error);
        }

        let result = (self.launch)(build_launch_request(&self.root_dir, &runtime)).await;
        match result {
            Ok(server) => {
                self.finish_with_running(server).await;
                Ok(self.status().await)
            }
            Err(error) => {
                self.finish_with_error(error.to_string()).await;
                Err(error)
            }
        }
    }

    pub async fn start(&self) -> Result<CodeServerStatusSnapshot, CodeServerError> {
        self.ensure_ready().await?;
        Ok(self.status().await)
    }

    pub async fn stop(&self) -> Result<CodeServerStatusSnapshot, CodeServerError> {
        let previous = self
            .begin_lifecycle_transition(LifecycleTransition::Stopping)
            .await?;
        shutdown_previous(previous).await?;
        self.finish_stopped().await;
        Ok(self.status().await)
    }

    pub async fn restart(&self) -> Result<CodeServerStatusSnapshot, CodeServerError> {
        self.stop().await?;
        self.start().await
    }

    pub async fn shutdown(&self) -> Result<(), CodeServerError> {
        let previous = self
            .begin_lifecycle_transition(LifecycleTransition::Stopping)
            .await?;
        shutdown_previous(previous).await?;
        self.finish_stopped().await;
        Ok(())
    }

    pub async fn ensure_ready(&self) -> Result<CodeServerConnection, CodeServerError> {
        loop {
            let runtime = self.find_installed_runtime().await?;
            let mut state = self.inner.lock().await;
            normalize_dead_process(&mut state)?;
            match &state.lifecycle {
                LifecycleState::Running(server) => {
                    return Ok(server.connection.clone());
                }
                LifecycleState::Starting
                | LifecycleState::Stopping
                | LifecycleState::Installing => {
                    let notified = self.notify.notified();
                    drop(state);
                    notified.await;
                    continue;
                }
                LifecycleState::Stopped | LifecycleState::Error(_) => {
                    let runtime = runtime.ok_or(CodeServerError::NotInstalled)?;
                    state.lifecycle = LifecycleState::Starting;
                    drop(state);

                    let result =
                        (self.launch)(build_launch_request(&self.root_dir, &runtime)).await;
                    match result {
                        Ok(server) => {
                            let connection = server.connection.clone();
                            self.finish_with_running(server).await;
                            return Ok(connection);
                        }
                        Err(error) => {
                            self.finish_with_error(error.to_string()).await;
                            return Err(error);
                        }
                    }
                }
            }
        }
    }

    async fn begin_lifecycle_transition(
        &self,
        next: LifecycleTransition,
    ) -> Result<Option<Box<RunningCodeServer>>, CodeServerError> {
        loop {
            let mut state = self.inner.lock().await;
            normalize_dead_process(&mut state)?;

            match state.lifecycle {
                LifecycleState::Starting
                | LifecycleState::Stopping
                | LifecycleState::Installing => {
                    let notified = self.notify.notified();
                    drop(state);
                    notified.await;
                }
                _ => {
                    let previous = match std::mem::replace(
                        &mut state.lifecycle,
                        match next {
                            LifecycleTransition::Stopping => LifecycleState::Stopping,
                            LifecycleTransition::Installing => LifecycleState::Installing,
                        },
                    ) {
                        LifecycleState::Running(server) => Some(server),
                        LifecycleState::Stopped | LifecycleState::Error(_) => None,
                        LifecycleState::Starting
                        | LifecycleState::Stopping
                        | LifecycleState::Installing => unreachable!(),
                    };
                    drop(state);
                    self.notify.notify_waiters();
                    return Ok(previous);
                }
            }
        }
    }

    async fn finish_stopped(&self) {
        let mut state = self.inner.lock().await;
        state.lifecycle = LifecycleState::Stopped;
        drop(state);
        self.notify.notify_waiters();
    }

    async fn finish_with_running(&self, server: RunningCodeServer) {
        let mut state = self.inner.lock().await;
        state.lifecycle = LifecycleState::Running(Box::new(server));
        drop(state);
        self.notify.notify_waiters();
    }

    async fn finish_with_error(&self, message: String) {
        let mut state = self.inner.lock().await;
        state.lifecycle = LifecycleState::Error(message);
        drop(state);
        self.notify.notify_waiters();
    }

    async fn find_installed_runtime(&self) -> Result<Option<InstalledRuntime>, CodeServerError> {
        let root_dir = self.root_dir.clone();
        let platform = detect_platform()?;
        tokio::task::spawn_blocking(move || find_installed_runtime_sync(root_dir, platform))
            .await
            .map_err(|error| CodeServerError::Spawn(error.to_string()))?
    }
}

#[derive(Clone, Copy)]
enum LifecycleTransition {
    Stopping,
    Installing,
}

impl RunningCodeServer {
    fn is_alive(&mut self) -> Result<bool, CodeServerError> {
        self.process.is_alive()
    }

    async fn shutdown(&mut self) -> Result<(), CodeServerError> {
        self.process.shutdown().await
    }
}

impl RunningCodeServerProcess {
    fn is_alive(&mut self) -> Result<bool, CodeServerError> {
        match self {
            Self::Child(child) => Ok(child.try_wait()?.is_none()),
            #[cfg(test)]
            Self::External => Ok(true),
            #[cfg(test)]
            Self::TestProbe(probe) => Ok(probe.alive.load(std::sync::atomic::Ordering::Relaxed)),
        }
    }

    async fn shutdown(&mut self) -> Result<(), CodeServerError> {
        match self {
            Self::Child(child) => {
                if child.try_wait()?.is_none() {
                    child.start_kill()?;
                    let _ = child.wait().await?;
                }
                Ok(())
            }
            #[cfg(test)]
            Self::External => Ok(()),
            #[cfg(test)]
            Self::TestProbe(probe) => {
                probe
                    .shutdowns
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                probe
                    .alive
                    .store(false, std::sync::atomic::Ordering::Relaxed);
                Ok(())
            }
        }
    }
}

impl Drop for RunningCodeServerProcess {
    fn drop(&mut self) {
        match self {
            Self::Child(child) => {
                let _ = child.start_kill();
            }
            #[cfg(test)]
            Self::External => {}
            #[cfg(test)]
            Self::TestProbe(probe) => {
                if probe
                    .alive
                    .swap(false, std::sync::atomic::Ordering::Relaxed)
                {
                    probe
                        .drop_kills
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
            }
        }
    }
}

async fn shutdown_previous(
    previous: Option<Box<RunningCodeServer>>,
) -> Result<(), CodeServerError> {
    if let Some(mut server) = previous {
        server.shutdown().await?;
    }
    Ok(())
}

fn normalize_dead_process(state: &mut ManagerState) -> Result<bool, CodeServerError> {
    let exited = match &mut state.lifecycle {
        LifecycleState::Running(server) => !server.is_alive()?,
        _ => false,
    };
    if exited {
        state.lifecycle = LifecycleState::Error("code-server exited".to_string());
    }
    Ok(exited)
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
            tracing::error!("failed to ensure code-server: {error}");
            return proxy_error_response(error);
        }
    };

    let path_and_query = strip_public_base_path(&request);
    let (parts, body) = request.into_parts();
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
    upstream = copy_request_headers(upstream, &parts.headers);
    if !body.is_empty() {
        upstream = upstream.body(body);
    }

    match upstream.send().await {
        Ok(response) => build_http_proxy_response(response),
        Err(error) => {
            tracing::warn!("code-server proxy request failed: {error}");
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
    copy_websocket_headers(upstream_request.headers_mut(), &headers);
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

fn proxy_error_response(error: CodeServerError) -> Response {
    let status = match error {
        CodeServerError::NotInstalled => StatusCode::SERVICE_UNAVAILABLE,
        CodeServerError::UnsupportedPlatform(_) | CodeServerError::InvalidVersion(_) => {
            StatusCode::BAD_REQUEST
        }
        CodeServerError::StartupTimeout => StatusCode::BAD_GATEWAY,
        CodeServerError::Io(_)
        | CodeServerError::Http(_)
        | CodeServerError::Archive(_)
        | CodeServerError::Spawn(_)
        | CodeServerError::InvalidReleaseRedirect(_)
        | CodeServerError::WebSocket(_) => StatusCode::BAD_GATEWAY,
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
        if *name == CONNECTION || *name == UPGRADE {
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
    if let Some(host) = source.get(HOST) {
        target.insert(HOST, host.clone());
    }
    if let Some(protocol) = source.get(SEC_WEBSOCKET_PROTOCOL) {
        target.insert(SEC_WEBSOCKET_PROTOCOL, protocol.clone());
    }
    if let Some(cookie) = source.get(axum::http::header::COOKIE) {
        target.insert(axum::http::header::COOKIE, cookie.clone());
    }
    if let Some(origin) = source.get(axum::http::header::ORIGIN) {
        target.insert(axum::http::header::ORIGIN, origin.clone());
    }
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

fn strip_public_base_path(request: &Request) -> String {
    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or(PUBLIC_BASE_PATH);
    rewrite_public_path(path_and_query)
}

fn rewrite_public_path(path_and_query: &str) -> String {
    let stripped = path_and_query
        .strip_prefix(PUBLIC_BASE_PATH)
        .unwrap_or(path_and_query);
    if stripped.is_empty() {
        "/".to_string()
    } else if stripped.starts_with('/') || stripped.starts_with('?') {
        format!("/{}", stripped.trim_start_matches('/'))
    } else {
        format!("/{stripped}")
    }
}

fn detect_platform() -> Result<CodeServerPlatform, CodeServerError> {
    let os = match std::env::consts::OS {
        "linux" => "linux",
        "macos" => "macos",
        other => {
            return Err(CodeServerError::UnsupportedPlatform(format!(
                "unsupported code-server host OS: {other}"
            )));
        }
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        "arm" | "armv7l" => "armv7l",
        other => {
            return Err(CodeServerError::UnsupportedPlatform(format!(
                "unsupported code-server host architecture: {other}"
            )));
        }
    };

    Ok(CodeServerPlatform { os, arch })
}

fn now_timestamp_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn normalize_version(raw: &str) -> Result<String, CodeServerError> {
    let version = raw.trim().trim_start_matches('v');
    Version::parse(version).map_err(|_| {
        CodeServerError::InvalidVersion(format!("invalid code-server version: {raw}"))
    })?;
    Ok(version.to_string())
}

fn runtime_dir_name(version: &str, platform: CodeServerPlatform) -> String {
    format!("code-server-{version}-{}-{}", platform.os, platform.arch)
}

fn build_launch_request(root_dir: &Path, runtime: &InstalledRuntime) -> CodeServerLaunchRequest {
    let port = pick_unused_port().unwrap_or(8080);
    CodeServerLaunchRequest {
        runtime_dir: runtime.runtime_dir.clone(),
        binary_path: runtime.binary_path.clone(),
        host: DEFAULT_HOST.to_string(),
        port,
        user_data_dir: root_dir.join(USER_DIR),
        extensions_dir: root_dir.join(EXTENSIONS_DIR),
        config_file: root_dir.join(CONFIG_DIR).join("config.yaml"),
    }
}

fn pick_unused_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind((DEFAULT_HOST, 0))?;
    Ok(listener.local_addr()?.port())
}

async fn fetch_latest_version(client: reqwest::Client) -> Result<String, CodeServerError> {
    let response = client
        .get(format!("{RELEASES_BASE_URL}/latest"))
        .send()
        .await?;
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            CodeServerError::InvalidReleaseRedirect(
                "missing redirect location from /releases/latest".to_string(),
            )
        })?;
    let tag = location
        .rsplit('/')
        .next()
        .and_then(|segment| segment.strip_prefix('v'))
        .ok_or_else(|| {
            CodeServerError::InvalidReleaseRedirect(format!(
                "invalid release redirect location: {location}"
            ))
        })?;
    normalize_version(tag)
}

async fn download_runtime_archive(
    request: CodeServerDownloadRequest,
    client: reqwest::Client,
) -> Result<InstalledRuntime, CodeServerError> {
    download_runtime_archive_from_base_url(request, client, RELEASES_BASE_URL).await
}

async fn download_runtime_archive_from_base_url(
    request: CodeServerDownloadRequest,
    client: reqwest::Client,
    releases_base_url: &str,
) -> Result<InstalledRuntime, CodeServerError> {
    let version = normalize_version(&request.version)?;
    let dir_name = runtime_dir_name(&version, request.platform);
    let runtime_dir = request.root_dir.join(RUNTIMES_DIR).join(&dir_name);
    let binary_path = runtime_dir.join("bin").join("code-server");
    if tokio::fs::try_exists(&binary_path).await? {
        return Ok(InstalledRuntime {
            version: version.clone(),
            version_semver: Version::parse(&version).expect("validated version"),
            platform: request.platform,
            runtime_dir,
            binary_path,
        });
    }

    tokio::fs::create_dir_all(request.root_dir.join(RUNTIMES_DIR)).await?;
    tokio::fs::create_dir_all(request.root_dir.join(TMP_DIR)).await?;

    let asset_name = format!("{dir_name}.tar.gz");
    let asset_url = format!("{releases_base_url}/download/v{version}/{asset_name}");
    let archive_path = request
        .root_dir
        .join(TMP_DIR)
        .join(format!("{dir_name}-{}.tar.gz", Uuid::new_v4()));
    let extract_dir = request
        .root_dir
        .join(TMP_DIR)
        .join(format!("{dir_name}-extract-{}", Uuid::new_v4()));

    let download = async {
        let response = client.get(asset_url).send().await?.error_for_status()?;
        let mut file = tokio::fs::File::create(&archive_path).await?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.try_next().await? {
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        Ok::<(), CodeServerError>(())
    }
    .await;

    if let Err(error) = download {
        let _ = tokio::fs::remove_file(&archive_path).await;
        return Err(error);
    }

    let archive_path_for_extract = archive_path.clone();
    let extract_dir_for_extract = extract_dir.clone();
    let dir_name_for_extract = dir_name.clone();
    let extracted_root = tokio::task::spawn_blocking(move || {
        extract_archive(
            &archive_path_for_extract,
            &extract_dir_for_extract,
            &dir_name_for_extract,
        )
    })
    .await
    .map_err(|error| CodeServerError::Spawn(error.to_string()))??;

    let move_result = if tokio::fs::try_exists(&runtime_dir).await? {
        Ok(())
    } else {
        tokio::fs::rename(&extracted_root, &runtime_dir).await
    };

    let _ = tokio::fs::remove_file(&archive_path).await;
    let _ = tokio::fs::remove_dir_all(&extract_dir).await;

    move_result?;

    if !tokio::fs::try_exists(&binary_path).await? {
        return Err(CodeServerError::Archive(format!(
            "missing code-server binary after extraction: {}",
            binary_path.display()
        )));
    }

    Ok(InstalledRuntime {
        version: version.clone(),
        version_semver: Version::parse(&version).expect("validated version"),
        platform: request.platform,
        runtime_dir,
        binary_path,
    })
}

fn extract_archive(
    archive_path: &Path,
    extract_dir: &Path,
    dir_name: &str,
) -> Result<PathBuf, CodeServerError> {
    std::fs::create_dir_all(extract_dir)?;
    let file = std::fs::File::open(archive_path)?;
    let decoder = GzDecoder::new(file);
    let mut archive = Archive::new(decoder);
    archive
        .unpack(extract_dir)
        .map_err(|error| CodeServerError::Archive(error.to_string()))?;
    let extracted_root = extract_dir.join(dir_name);
    if !extracted_root.join("bin").join("code-server").exists() {
        return Err(CodeServerError::Archive(format!(
            "extracted runtime is missing bin/code-server: {}",
            extracted_root.display()
        )));
    }
    Ok(extracted_root)
}

async fn cleanup_other_platform_runtimes(
    root_dir: PathBuf,
    platform: CodeServerPlatform,
    keep_runtime_dir: &Path,
) -> Result<(), CodeServerError> {
    let keep_runtime_dir = keep_runtime_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let runtimes_dir = root_dir.join(RUNTIMES_DIR);
        let entries = match std::fs::read_dir(&runtimes_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(CodeServerError::Io(error)),
        };

        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if path == keep_runtime_dir || !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let suffix = format!("-{}-{}", platform.os, platform.arch);
            if name.starts_with("code-server-") && name.ends_with(&suffix) {
                std::fs::remove_dir_all(path)?;
            }
        }

        Ok(())
    })
    .await
    .map_err(|error| CodeServerError::Spawn(error.to_string()))?
}

fn find_installed_runtime_sync(
    root_dir: PathBuf,
    platform: CodeServerPlatform,
) -> Result<Option<InstalledRuntime>, CodeServerError> {
    let runtimes_dir = root_dir.join(RUNTIMES_DIR);
    let entries = match std::fs::read_dir(&runtimes_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(CodeServerError::Io(error)),
    };

    let suffix = format!("-{}-{}", platform.os, platform.arch);
    let mut best: Option<InstalledRuntime> = None;

    for entry in entries {
        let entry = entry?;
        let runtime_dir = entry.path();
        if !runtime_dir.is_dir() {
            continue;
        }
        let Some(name) = runtime_dir.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(rest) = name.strip_prefix("code-server-") else {
            continue;
        };
        let Some(version) = rest.strip_suffix(&suffix) else {
            continue;
        };
        let binary_path = runtime_dir.join("bin").join("code-server");
        if !binary_path.exists() {
            continue;
        }
        let Ok(version_semver) = Version::parse(version) else {
            continue;
        };

        let candidate = InstalledRuntime {
            version: version.to_string(),
            version_semver,
            platform,
            runtime_dir,
            binary_path,
        };

        if best
            .as_ref()
            .is_none_or(|current| candidate.version_semver > current.version_semver)
        {
            best = Some(candidate);
        }
    }

    Ok(best)
}

async fn launch_code_server(
    request: CodeServerLaunchRequest,
    client: reqwest::Client,
) -> Result<RunningCodeServer, CodeServerError> {
    prepare_dirs(&request).await?;

    let mut child = Command::new(&request.binary_path)
        .arg("--bind-addr")
        .arg(format!("{}:{}", request.host, request.port))
        .arg("--auth")
        .arg("none")
        .arg("--user-data-dir")
        .arg(&request.user_data_dir)
        .arg("--extensions-dir")
        .arg(&request.extensions_dir)
        .arg("--config")
        .arg(&request.config_file)
        .arg("--disable-update-check")
        .arg("--abs-proxy-base-path")
        .arg(PUBLIC_BASE_PATH)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            CodeServerError::Spawn(format!(
                "failed to launch code-server binary {}: {error}",
                request.binary_path.display()
            ))
        })?;

    let connection = CodeServerConnection {
        base_url: format!("http://{}:{}", request.host, request.port),
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
    tokio::fs::create_dir_all(&request.runtime_dir).await?;
    tokio::fs::create_dir_all(&request.user_data_dir).await?;
    tokio::fs::create_dir_all(&request.extensions_dir).await?;
    tokio::fs::create_dir_all(
        request
            .config_file
            .parent()
            .unwrap_or_else(|| Path::new(".")),
    )
    .await?;
    tokio::fs::write(
        &request.config_file,
        "bind-addr: 127.0.0.1:8080\nauth: none\ncert: false\n",
    )
    .await?;
    Ok(())
}

async fn wait_for_ready(
    client: &reqwest::Client,
    connection: &CodeServerConnection,
) -> Result<(), CodeServerError> {
    let started = tokio::time::Instant::now();
    loop {
        let response = client
            .get(connection.http_url(UPSTREAM_READY_PATH))
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
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use axum::extract::Request as AxumRequest;
    use axum::routing::any;
    use axum::{Router, body::Body};
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use tar::Builder;

    use super::*;
    use crate::{AppState, build_router};

    #[cfg(test)]
    impl TestProcessProbe {
        fn new(alive: bool) -> Self {
            Self {
                alive: Arc::new(AtomicBool::new(alive)),
                shutdowns: Arc::new(AtomicUsize::new(0)),
                drop_kills: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn process(&self) -> RunningCodeServerProcess {
            RunningCodeServerProcess::TestProbe(self.clone())
        }
    }

    fn static_fetch_latest(version: &'static str) -> FetchLatestFn {
        Arc::new(move || Box::pin(async move { Ok(version.to_string()) }))
    }

    fn static_download_runtime(temp_root: PathBuf) -> DownloadRuntimeFn {
        Arc::new(move |request: CodeServerDownloadRequest| {
            let temp_root = temp_root.clone();
            Box::pin(async move {
                let dir_name = runtime_dir_name(&request.version, request.platform);
                let runtime_dir = request.root_dir.join(RUNTIMES_DIR).join(&dir_name);
                tokio::fs::create_dir_all(runtime_dir.join("bin")).await?;
                tokio::fs::write(runtime_dir.join("bin").join("code-server"), "#!/bin/sh\n")
                    .await?;
                tokio::fs::write(temp_root.join("downloaded"), dir_name.as_bytes()).await?;
                Ok(InstalledRuntime {
                    version: request.version.clone(),
                    version_semver: Version::parse(&request.version).unwrap(),
                    platform: request.platform,
                    runtime_dir: runtime_dir.clone(),
                    binary_path: runtime_dir.join("bin").join("code-server"),
                })
            })
        })
    }

    fn runtime_archive(dir_name: &str) -> Vec<u8> {
        let mut tar_bytes = Vec::new();
        {
            let mut builder = Builder::new(&mut tar_bytes);
            let file_contents = b"#!/bin/sh\n";
            let mut header = tar::Header::new_gnu();
            header.set_mode(0o755);
            header.set_size(file_contents.len() as u64);
            header.set_cksum();
            builder
                .append_data(
                    &mut header,
                    format!("{dir_name}/bin/code-server"),
                    &file_contents[..],
                )
                .unwrap();
            builder.finish().unwrap();
        }

        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&tar_bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn rewrite_public_path_strips_code_prefix() {
        assert_eq!(rewrite_public_path("/code"), "/");
        assert_eq!(rewrite_public_path("/code/"), "/");
        assert_eq!(
            rewrite_public_path("/code/?folder=%2Ftmp%2Fdemo"),
            "/?folder=%2Ftmp%2Fdemo"
        );
        assert_eq!(rewrite_public_path("/code/static/out.js"), "/static/out.js");
    }

    #[test]
    fn runtime_dir_name_uses_version_platform_suffix() {
        let platform = CodeServerPlatform {
            os: "macos",
            arch: "arm64",
        };
        assert_eq!(
            runtime_dir_name("4.114.1", platform),
            "code-server-4.114.1-macos-arm64"
        );
    }

    #[test]
    fn normalize_version_accepts_tags_and_rejects_invalid_values() {
        assert_eq!(normalize_version("v4.114.1").unwrap(), "4.114.1");
        assert!(matches!(
            normalize_version("latest"),
            Err(CodeServerError::InvalidVersion(_))
        ));
    }

    #[test]
    fn build_launch_request_uses_managed_dirs_and_runtime_binary() {
        let platform = CodeServerPlatform {
            os: "linux",
            arch: "amd64",
        };
        let runtime = InstalledRuntime {
            version: "4.114.1".to_string(),
            version_semver: Version::parse("4.114.1").unwrap(),
            platform,
            runtime_dir: PathBuf::from(
                "/tmp/hubris/code-server/runtimes/code-server-4.114.1-linux-amd64",
            ),
            binary_path: PathBuf::from(
                "/tmp/hubris/code-server/runtimes/code-server-4.114.1-linux-amd64/bin/code-server",
            ),
        };

        let request = build_launch_request(Path::new("/tmp/hubris/code-server"), &runtime);

        assert_eq!(
            request.user_data_dir,
            PathBuf::from("/tmp/hubris/code-server/user")
        );
        assert_eq!(
            request.extensions_dir,
            PathBuf::from("/tmp/hubris/code-server/extensions")
        );
        assert_eq!(
            request.config_file,
            PathBuf::from("/tmp/hubris/code-server/config/config.yaml")
        );
        assert_eq!(request.binary_path, runtime.binary_path);
    }

    #[tokio::test]
    async fn cleanup_other_platform_runtimes_keeps_other_arches() {
        let tmp = tempfile::TempDir::new().unwrap();
        let runtimes = tmp.path().join(RUNTIMES_DIR);
        tokio::fs::create_dir_all(&runtimes).await.unwrap();
        tokio::fs::create_dir_all(runtimes.join("code-server-4.113.0-linux-amd64"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(runtimes.join("code-server-4.114.1-linux-amd64"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(runtimes.join("code-server-4.114.1-macos-arm64"))
            .await
            .unwrap();

        cleanup_other_platform_runtimes(
            tmp.path().to_path_buf(),
            CodeServerPlatform {
                os: "linux",
                arch: "amd64",
            },
            &runtimes.join("code-server-4.114.1-linux-amd64"),
        )
        .await
        .unwrap();

        assert!(
            !tokio::fs::try_exists(runtimes.join("code-server-4.113.0-linux-amd64"))
                .await
                .unwrap()
        );
        assert!(
            tokio::fs::try_exists(runtimes.join("code-server-4.114.1-linux-amd64"))
                .await
                .unwrap()
        );
        assert!(
            tokio::fs::try_exists(runtimes.join("code-server-4.114.1-macos-arm64"))
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn download_runtime_archive_follows_release_asset_redirects() {
        let version = "4.114.1";
        let platform = CodeServerPlatform {
            os: "linux",
            arch: "amd64",
        };
        let dir_name = runtime_dir_name(version, platform);
        let asset_name = format!("{dir_name}.tar.gz");
        let archive = Arc::new(runtime_archive(&dir_name));
        let redirected_asset_path = format!("/assets/{asset_name}");
        let upstream = Router::new()
            .route(
                &format!("/releases/download/v{version}/{asset_name}"),
                any({
                    let redirected_asset_path = redirected_asset_path.clone();
                    move || async move {
                        Response::builder()
                            .status(StatusCode::FOUND)
                            .header(axum::http::header::LOCATION, redirected_asset_path.clone())
                            .body(Body::empty())
                            .unwrap()
                    }
                }),
            )
            .route(
                &redirected_asset_path,
                any({
                    let archive = archive.clone();
                    move || async move {
                        Response::builder()
                            .status(StatusCode::OK)
                            .header(axum::http::header::CONTENT_TYPE, "application/gzip")
                            .body(Body::from(archive.as_ref().clone()))
                            .unwrap()
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, upstream).await.unwrap();
        });

        let tmp = tempfile::TempDir::new().unwrap();
        let installed = download_runtime_archive_from_base_url(
            CodeServerDownloadRequest {
                version: version.to_string(),
                platform,
                root_dir: tmp.path().join("code-server"),
            },
            reqwest::Client::new(),
            &format!("http://{addr}/releases"),
        )
        .await
        .unwrap();

        assert_eq!(installed.version, version);
        assert_eq!(
            installed.runtime_dir.file_name().unwrap(),
            dir_name.as_str()
        );
        assert!(tokio::fs::try_exists(installed.binary_path).await.unwrap());
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
                    },
                    process: RunningCodeServerProcess::External,
                })
            })
        });

        let tmp = tempfile::TempDir::new().unwrap();
        let manager = CodeServerManager::with_hooks(
            tmp.path().join("code-server"),
            static_fetch_latest("4.114.1"),
            static_download_runtime(tmp.path().to_path_buf()),
            launch,
        );
        manager.install(Some("4.114.1".to_string())).await.unwrap();
        manager.stop().await.unwrap();

        let (first, second) = tokio::join!(manager.ensure_ready(), manager.ensure_ready());

        assert!(first.is_ok());
        assert!(second.is_ok());
        assert_eq!(launches.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn shutdown_stops_running_process_and_resets_state() {
        let manager = CodeServerManager::with_hooks(
            PathBuf::from("/tmp/hubris/code-server"),
            static_fetch_latest("4.114.1"),
            Arc::new(|_| Box::pin(async { Err(CodeServerError::Archive("unused".to_string())) })),
            Arc::new(|_| {
                Box::pin(async {
                    Ok(RunningCodeServer {
                        connection: CodeServerConnection {
                            base_url: "http://127.0.0.1:1234".into(),
                        },
                        process: RunningCodeServerProcess::External,
                    })
                })
            }),
        );
        let probe = TestProcessProbe::new(true);

        {
            let mut state = manager.inner.lock().await;
            state.lifecycle = LifecycleState::Running(Box::new(RunningCodeServer {
                connection: CodeServerConnection {
                    base_url: "http://127.0.0.1:1234".into(),
                },
                process: probe.process(),
            }));
        }

        manager.shutdown().await.unwrap();

        assert_eq!(probe.shutdowns.load(Ordering::Relaxed), 1);
        assert_eq!(probe.drop_kills.load(Ordering::Relaxed), 0);

        let state = manager.inner.lock().await;
        assert!(matches!(state.lifecycle, LifecycleState::Stopped));
    }

    #[tokio::test]
    async fn wait_for_ready_retries_until_server_stops_returning_accepted() {
        let requests = Arc::new(AtomicUsize::new(0));
        let request_counter = requests.clone();
        let app = Router::new().route(
            "/",
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
        };

        wait_for_ready(&client, &connection).await.unwrap();

        assert!(requests.load(Ordering::Relaxed) >= 3);
    }

    #[tokio::test]
    async fn code_proxy_strips_public_prefix_and_preserves_regular_cookies() {
        let upstream = Router::new().route(
            "/",
            any(|request: AxumRequest<Body>| async move {
                let cookie = request
                    .headers()
                    .get(axum::http::header::COOKIE)
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
                    .header(axum::http::header::SET_COOKIE, "other-cookie=ok; Path=/")
                    .header(axum::http::header::CONTENT_TYPE, "text/plain")
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
                    },
                    process: RunningCodeServerProcess::External,
                })
            })
        });

        let tmp = tempfile::TempDir::new().unwrap();
        let mut state = AppState::new(tmp.path().to_path_buf()).await;
        state.code_server = Arc::new(CodeServerManager::with_hooks(
            tmp.path().join("code-server"),
            static_fetch_latest("4.114.1"),
            static_download_runtime(tmp.path().to_path_buf()),
            launch,
        ));
        state
            .code_server
            .install(Some("4.114.1".to_string()))
            .await
            .unwrap();
        let app = build_router(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{addr}/code/?folder=%2Ftmp%2Fdemo"))
            .header(HOST, format!("proxy.test:{}", addr.port()))
            .header(
                axum::http::header::COOKIE,
                "theme=dark; hubris-session=test",
            )
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
            vec!["other-cookie=ok; Path=/".to_string()]
        );

        let body = response.text().await.unwrap();
        let mut lines = body.lines();
        let expected_host = format!("proxy.test:{}", addr.port());
        assert_eq!(lines.next(), Some("/?folder=%2Ftmp%2Fdemo"));
        assert_eq!(lines.next(), Some("theme=dark; hubris-session=test"));
        assert_eq!(lines.next(), Some(expected_host.as_str()));
    }

    #[tokio::test]
    async fn code_proxy_returns_service_unavailable_when_runtime_is_missing() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = AppState::new(tmp.path().to_path_buf()).await;
        let app = build_router(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let response = reqwest::get(format!("http://{addr}/code")).await.unwrap();

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response.text().await.unwrap(),
            "code-server is not installed"
        );
    }

    #[tokio::test]
    async fn code_server_status_endpoint_reports_not_installed() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = AppState::new(tmp.path().to_path_buf()).await;
        let app = build_router(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let response = reqwest::get(format!("http://{addr}/api/code-server"))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["installedVersion"], serde_json::Value::Null);
        assert_eq!(body["processStatus"], "stopped");
        assert_eq!(body["supported"], true);
    }

    #[tokio::test]
    async fn code_server_install_endpoint_installs_and_starts_runtime() {
        let launch: LaunchFn = Arc::new(move |request| {
            Box::pin(async move {
                Ok(RunningCodeServer {
                    connection: CodeServerConnection {
                        base_url: format!("http://{}:{}", request.host, request.port),
                    },
                    process: RunningCodeServerProcess::External,
                })
            })
        });

        let tmp = tempfile::TempDir::new().unwrap();
        let mut state = AppState::new(tmp.path().to_path_buf()).await;
        state.code_server = Arc::new(CodeServerManager::with_hooks(
            tmp.path().join("code-server"),
            static_fetch_latest("4.114.1"),
            static_download_runtime(tmp.path().to_path_buf()),
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
            .post(format!("http://{addr}/api/code-server/install"))
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["installedVersion"], "4.114.1");
        assert_eq!(body["processStatus"], "running");
        assert_eq!(body["latest"]["latestVersion"], serde_json::Value::Null);
    }
}
