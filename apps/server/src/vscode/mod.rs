use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::extract::ws::{Message as AxumWsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::header::{
    CONNECTION, COOKIE, HOST, ORIGIN, PROXY_AUTHENTICATE, PROXY_AUTHORIZATION,
    SEC_WEBSOCKET_PROTOCOL, SET_COOKIE, TE, TRAILER, TRANSFER_ENCODING, UPGRADE,
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
use tokio::process::Command;
use tokio::sync::{Mutex, Notify};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use uuid::Uuid;

mod code_server;
mod tasks;
mod vscode_cli;

use crate::api::settings::VscodeRuntimeKind;
use crate::events::EventBus;
#[cfg(target_os = "linux")]
use crate::process_manager::configure_parent_death_signal;
use crate::process_manager::{
    ManagedChildProcess, ManagedProcessActionError, ManagedProcessController, ManagedProcessHandle,
    ManagedProcessLifecycleState, ManagedProcessRuntime, ManagedProcessService,
    ManagedProcessStatusSnapshot, ManagedProcessStopTarget, now_timestamp_string,
};
use crate::settings_manager::SettingsManager;
use crate::state::AppState;
use crate::task_manager::{TaskActionError, TaskActionErrorKind, TaskService};
pub(crate) use tasks::register_vscode_tasks;
use tasks::{
    TASK_VSCODE_CHECK_UPDATE, TASK_VSCODE_INSTALL_RUNTIME, normalize_install_version_input,
    vscode_runtime_scope, vscode_task_input,
};

const PUBLIC_CODE_PREFIX: &str = "/code";
const VSCODE_CLI_PUBLIC_BASE_PATH: &str = "/code/vscode-cli";
const CODE_SERVER_PUBLIC_BASE_PATH: &str = "/code/code-server";
const VSCODE_CLI_UPSTREAM_BASE_PATH: &str = "/code/vscode-cli";
const CODE_SERVER_UPSTREAM_BASE_PATH: &str = "/";
const HUBRIS_PUBLIC_HOST_HEADER: &str = "x-hubris-public-host";
const HUBRIS_PUBLIC_ORIGIN_HEADER: &str = "x-hubris-public-origin";
const UPSTREAM_READY_PATH: &str = "/";
const DEFAULT_HOST: &str = "127.0.0.1";
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(150);
const REQUEST_BODY_LIMIT: usize = 32 * 1024 * 1024;
const RELEASES_BASE_URL: &str = "https://github.com/coder/code-server/releases";
const VSCODE_UPDATE_BASE_URL: &str = "https://update.code.visualstudio.com";
const RUNTIMES_DIR: &str = "runtimes";
const USER_DIR: &str = "user";
const EXTENSIONS_DIR: &str = "extensions";
const CONFIG_DIR: &str = "config";
const TMP_DIR: &str = "tmp";
const VSCODE_CLI_DATA_DIR: &str = "cli-data";
const VSCODE_SERVER_DATA_DIR: &str = "server-data";
const VSCODE_TOKEN_COOKIE_NAME: &str = "vscode-tkn";
const VSCODE_TOKEN_QUERY_PARAM: &str = "tkn";

type FetchLatestFn =
    Arc<dyn Fn() -> BoxFuture<'static, Result<String, CodeServerError>> + Send + Sync>;
type DownloadRuntimeFn = Arc<
    dyn Fn(
            CodeServerDownloadRequest,
        ) -> BoxFuture<'static, Result<InstalledRuntime, CodeServerError>>
        + Send
        + Sync,
>;
type InstallProgressFn =
    Arc<dyn Fn(ManagerCodeServerInstallProgress) -> BoxFuture<'static, ()> + Send + Sync>;
type LaunchFn = Arc<
    dyn Fn(
            CodeServerLaunchRequest,
        ) -> BoxFuture<'static, Result<RunningCodeServer, CodeServerError>>
        + Send
        + Sync,
>;
type StatusCallback = Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>;

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodeServerConnection {
    pub base_url: String,
}

impl CodeServerConnection {
    pub fn http_base_url(&self) -> &str {
        &self.base_url
    }

    pub fn ws_base_url(&self) -> String {
        self.base_url
            .strip_prefix("http://")
            .map(|value| format!("ws://{value}"))
            .or_else(|| {
                self.base_url
                    .strip_prefix("https://")
                    .map(|value| format!("wss://{value}"))
            })
            .unwrap_or_else(|| self.base_url.clone())
    }

    fn http_url(&self, path_and_query: &str) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), path_and_query)
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
    pub install_progress: Option<ManagerCodeServerInstallProgress>,
    pub message: Option<String>,
}

#[derive(Clone)]
pub struct CodeServerManager {
    inner: Arc<Mutex<ManagerState>>,
    notify: Arc<Notify>,
    client: reqwest::Client,
    status_callback: Arc<Mutex<Option<StatusCallback>>>,
    fetch_latest: FetchLatestFn,
    download_runtime: DownloadRuntimeFn,
    launch: LaunchFn,
    root_dir: PathBuf,
    process_handle: ManagedProcessHandle,
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
    latest: Option<ManagerCodeServerLatestCheck>,
    install_progress: Option<ManagerCodeServerInstallProgress>,
    runtime: ManagerRuntimeState,
}

#[derive(Debug, Clone)]
enum ManagerRuntimeState {
    Idle,
    Installing,
    Ready(CodeServerConnection),
}

impl ManagerRuntimeState {
    fn is_installing(&self) -> bool {
        matches!(self, Self::Installing)
    }

    fn connection(&self) -> Option<CodeServerConnection> {
        match self {
            Self::Ready(connection) => Some(connection.clone()),
            Self::Idle | Self::Installing => None,
        }
    }

    fn clear_ready(&mut self) -> bool {
        if matches!(self, Self::Ready(_)) {
            *self = Self::Idle;
            return true;
        }

        false
    }
}

#[derive(Debug)]
struct RunningCodeServer {
    connection: CodeServerConnection,
    process: ManagedProcessRuntime,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VscodeConnection {
    pub runtime: VscodeRuntimeKind,
    pub base_url: String,
    pub ws_base_url: String,
    pub upstream_base_path: String,
    pub connection_token: Option<String>,
}

impl VscodeConnection {
    pub fn http_base_url(&self) -> &str {
        &self.base_url
    }

    pub fn ws_base_url(&self) -> &str {
        &self.ws_base_url
    }

    fn join_upstream_path(&self, runtime_path: &str) -> String {
        let runtime_path = normalize_runtime_path(runtime_path);
        if self.upstream_base_path == "/" {
            return runtime_path;
        }

        format!(
            "{}{}",
            self.upstream_base_path.trim_end_matches('/'),
            runtime_path
        )
    }

    fn http_url(&self, runtime_path: &str) -> String {
        let upstream_path = self.join_upstream_path(runtime_path);
        format!("{}{}", self.base_url.trim_end_matches('/'), upstream_path)
    }

    fn ws_url(&self, runtime_path: &str) -> String {
        let upstream_path = self.join_upstream_path(runtime_path);
        format!(
            "{}{}",
            self.ws_base_url().trim_end_matches('/'),
            upstream_path
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VscodeRuntimeStatusSnapshot {
    pub supported: bool,
    pub installed_version: Option<String>,
    pub process_status: CodeServerProcessStatusValue,
    pub latest: Option<ManagerCodeServerLatestCheck>,
    pub install_progress: Option<ManagerCodeServerInstallProgress>,
    pub message: Option<String>,
    pub active_task_id: Option<String>,
}

impl From<CodeServerStatusSnapshot> for VscodeRuntimeStatusSnapshot {
    fn from(value: CodeServerStatusSnapshot) -> Self {
        Self {
            supported: value.supported,
            installed_version: value.installed_version,
            process_status: value.process_status,
            latest: value.latest,
            install_progress: value.install_progress,
            message: value.message,
            active_task_id: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VscodeStatusSnapshot {
    pub selected_runtime: VscodeRuntimeKind,
    pub code_server: VscodeRuntimeStatusSnapshot,
    pub vscode_cli: VscodeRuntimeStatusSnapshot,
}

#[derive(Debug)]
pub enum VscodeError {
    CodeServer(CodeServerError),
    VscodeCli(VscodeCliError),
    Task(TaskActionError),
}

impl fmt::Display for VscodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CodeServer(error) => write!(f, "{error}"),
            Self::VscodeCli(error) => write!(f, "{error}"),
            Self::Task(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for VscodeError {}

impl From<CodeServerError> for VscodeError {
    fn from(value: CodeServerError) -> Self {
        Self::CodeServer(value)
    }
}

impl From<VscodeCliError> for VscodeError {
    fn from(value: VscodeCliError) -> Self {
        Self::VscodeCli(value)
    }
}

impl From<TaskActionError> for VscodeError {
    fn from(value: TaskActionError) -> Self {
        Self::Task(value)
    }
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

#[derive(Clone)]
struct CodeServerDownloadRequest {
    root_dir: PathBuf,
    version: String,
    platform: CodeServerPlatform,
    force: bool,
    install_progress: Option<InstallProgressFn>,
}

#[derive(Clone, Debug)]
struct CodeServerInstallPlan {
    version: String,
    platform: CodeServerPlatform,
    force: bool,
}

#[derive(Debug, Default)]
struct CodeServerInstallTaskState {
    backup_runtime_dir: Option<PathBuf>,
    target_runtime_dir: Option<PathBuf>,
    installed_runtime: Option<InstalledRuntime>,
    restart_previous_runtime: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodeServerInstallPhaseValue {
    Preparing,
    Downloading,
    Extracting,
    Cleaning,
    Starting,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagerCodeServerInstallProgress {
    pub phase: CodeServerInstallPhaseValue,
    pub percent: u8,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
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

#[derive(Clone)]
pub struct VscodeManager {
    settings: Arc<SettingsManager>,
    events: Arc<EventBus>,
    tasks: Arc<TaskService>,
    code_server: Arc<CodeServerManager>,
    vscode_cli: Arc<VscodeCliManager>,
}

impl VscodeManager {
    pub fn new(
        settings: Arc<SettingsManager>,
        events: Arc<EventBus>,
        tasks: Arc<TaskService>,
        code_server: Arc<CodeServerManager>,
        vscode_cli: Arc<VscodeCliManager>,
    ) -> Self {
        Self {
            settings,
            events,
            tasks,
            code_server,
            vscode_cli,
        }
    }

    pub async fn register_status_callbacks(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        self.code_server
            .set_status_callback(Arc::new(move || {
                let weak = weak.clone();
                Box::pin(async move {
                    if let Some(manager) = weak.upgrade() {
                        manager.publish_status_update().await;
                    }
                })
            }))
            .await;

        let weak = Arc::downgrade(self);
        self.vscode_cli
            .set_status_callback(Arc::new(move || {
                let weak = weak.clone();
                Box::pin(async move {
                    if let Some(manager) = weak.upgrade() {
                        manager.publish_status_update().await;
                    }
                })
            }))
            .await;

        let weak = Arc::downgrade(self);
        let mut rx = self.events.subscribe();
        tokio::spawn(async move {
            loop {
                let Ok(event) = rx.recv().await else {
                    break;
                };

                let should_publish = match &event.kind {
                    crate::events::EventKind::TaskUpdated(task) => {
                        task.task.definition_name.starts_with("vscode.")
                            || task
                                .task
                                .scope_key
                                .as_deref()
                                .is_some_and(|scope| scope.starts_with("vscode-runtime:"))
                    }
                    crate::events::EventKind::TaskRemoved(_) => true,
                    _ => false,
                };

                if !should_publish {
                    continue;
                }

                let Some(manager) = weak.upgrade() else {
                    break;
                };
                manager.publish_status_update().await;
            }
        });
    }

    async fn selected_runtime(&self) -> VscodeRuntimeKind {
        self.settings.get().await.settings.vscode.runtime
    }

    pub fn http_client_for(&self, runtime: VscodeRuntimeKind) -> &reqwest::Client {
        match runtime {
            VscodeRuntimeKind::CodeServer => self.code_server.http_client(),
            VscodeRuntimeKind::VscodeCli => self.vscode_cli.http_client(),
        }
    }

    pub async fn status(&self) -> VscodeStatusSnapshot {
        let selected_runtime = self.selected_runtime().await;
        let mut code_server: VscodeRuntimeStatusSnapshot = self.code_server.status().await.into();
        let mut vscode_cli = self.vscode_cli.status().await;
        code_server.active_task_id = self
            .tasks
            .active_invocation_for_scope(&vscode_runtime_scope(VscodeRuntimeKind::CodeServer))
            .await
            .map(|task| task.id);
        vscode_cli.active_task_id = self
            .tasks
            .active_invocation_for_scope(&vscode_runtime_scope(VscodeRuntimeKind::VscodeCli))
            .await
            .map(|task| task.id);
        VscodeStatusSnapshot {
            selected_runtime,
            code_server,
            vscode_cli,
        }
    }

    pub async fn check_for_update(&self) -> Result<VscodeStatusSnapshot, VscodeError> {
        let runtime = self.selected_runtime().await;
        self.tasks
            .start(
                TASK_VSCODE_CHECK_UPDATE,
                vscode_task_input(runtime, None, false),
            )
            .await
            .map_err(VscodeError::Task)?;
        Ok(self.status().await)
    }

    pub async fn install(
        &self,
        requested_version: Option<String>,
        force: bool,
    ) -> Result<VscodeStatusSnapshot, VscodeError> {
        let runtime = self.selected_runtime().await;
        let requested_version = normalize_install_version_input(runtime, requested_version)
            .map_err(VscodeError::Task)?;
        self.tasks
            .start(
                TASK_VSCODE_INSTALL_RUNTIME,
                vscode_task_input(runtime, requested_version, force),
            )
            .await
            .map_err(VscodeError::Task)?;
        Ok(self.status().await)
    }

    pub async fn start(&self) -> Result<VscodeStatusSnapshot, VscodeError> {
        self.ensure_ready().await?;
        Ok(self.status().await)
    }

    pub async fn stop(&self) -> Result<VscodeStatusSnapshot, VscodeError> {
        match self.selected_runtime().await {
            VscodeRuntimeKind::CodeServer => {
                self.code_server.stop().await?;
            }
            VscodeRuntimeKind::VscodeCli => {
                self.vscode_cli.stop().await?;
            }
        }
        Ok(self.status().await)
    }

    pub async fn restart(&self) -> Result<VscodeStatusSnapshot, VscodeError> {
        match self.selected_runtime().await {
            VscodeRuntimeKind::CodeServer => {
                self.code_server.restart().await?;
            }
            VscodeRuntimeKind::VscodeCli => {
                self.vscode_cli.restart().await?;
            }
        }
        Ok(self.status().await)
    }

    pub async fn ensure_ready(&self) -> Result<VscodeConnection, VscodeError> {
        self.ensure_runtime_ready(self.selected_runtime().await)
            .await
    }

    pub async fn ensure_runtime_ready(
        &self,
        runtime: VscodeRuntimeKind,
    ) -> Result<VscodeConnection, VscodeError> {
        match runtime {
            VscodeRuntimeKind::CodeServer => {
                let connection = self.code_server.ensure_ready().await?;
                Ok(VscodeConnection {
                    runtime: VscodeRuntimeKind::CodeServer,
                    base_url: connection.http_base_url().to_string(),
                    ws_base_url: connection.ws_base_url(),
                    upstream_base_path: CODE_SERVER_UPSTREAM_BASE_PATH.to_string(),
                    connection_token: None,
                })
            }
            VscodeRuntimeKind::VscodeCli => {
                self.vscode_cli.ensure_ready().await.map_err(Into::into)
            }
        }
    }

    async fn publish_status_update(&self) {
        self.events
            .emit(crate::events::EventKind::VscodeUpdated(Box::new(
                self.status().await.into(),
            )));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ArchiveFormat {
    TarGz,
    Zip,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct VscodeCliPlatform {
    os: &'static str,
    arch: &'static str,
    cli_download_segment: &'static str,
    update_segment: &'static str,
    archive_format: ArchiveFormat,
}

#[derive(Clone, Debug)]
struct InstalledVscodeCliRuntime {
    version: String,
    version_semver: Version,
    platform: VscodeCliPlatform,
    runtime_dir: PathBuf,
    binary_path: PathBuf,
}

#[derive(Clone, Debug)]
struct VscodeCliLatestRelease {
    version: String,
}

#[derive(Clone, Debug)]
struct VscodeCliLaunchRequest {
    runtime_dir: PathBuf,
    binary_path: PathBuf,
    host: String,
    port: u16,
    cli_data_dir: PathBuf,
    server_data_dir: PathBuf,
    connection_token_file: PathBuf,
    connection_token: String,
}

#[derive(Clone)]
struct VscodeCliDownloadRequest {
    root_dir: PathBuf,
    version: String,
    platform: VscodeCliPlatform,
    force: bool,
    install_progress: Option<InstallProgressFn>,
}

#[derive(Clone, Debug)]
struct VscodeCliInstallPlan {
    version: String,
    platform: VscodeCliPlatform,
    force: bool,
}

#[derive(Debug, Default)]
struct VscodeCliInstallTaskState {
    backup_runtime_dir: Option<PathBuf>,
    target_runtime_dir: Option<PathBuf>,
    installed_runtime: Option<InstalledVscodeCliRuntime>,
    restart_previous_runtime: bool,
}

#[derive(Debug, Clone)]
enum VscodeCliRuntimeState {
    Idle,
    Installing,
    Ready(VscodeConnection),
}

impl VscodeCliRuntimeState {
    fn is_installing(&self) -> bool {
        matches!(self, Self::Installing)
    }

    fn connection(&self) -> Option<VscodeConnection> {
        match self {
            Self::Ready(connection) => Some(connection.clone()),
            Self::Idle | Self::Installing => None,
        }
    }

    fn clear_ready(&mut self) -> bool {
        if matches!(self, Self::Ready(_)) {
            *self = Self::Idle;
            return true;
        }
        false
    }
}

#[derive(Debug)]
struct VscodeCliManagerState {
    latest: Option<ManagerCodeServerLatestCheck>,
    install_progress: Option<ManagerCodeServerInstallProgress>,
    runtime: VscodeCliRuntimeState,
}

#[derive(Debug)]
struct RunningVscodeCli {
    connection: VscodeConnection,
    process: ManagedProcessRuntime,
}

#[derive(Debug)]
pub enum VscodeCliError {
    Io(std::io::Error),
    Http(reqwest::Error),
    Archive(String),
    Spawn(String),
    StartupTimeout,
    UnsupportedPlatform(String),
    InvalidVersion(String),
    NotInstalled,
}

impl fmt::Display for VscodeCliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::Http(error) => write!(f, "{error}"),
            Self::Archive(message) => write!(f, "{message}"),
            Self::Spawn(message) => write!(f, "{message}"),
            Self::StartupTimeout => write!(f, "timed out waiting for VS Code CLI"),
            Self::UnsupportedPlatform(message) => write!(f, "{message}"),
            Self::InvalidVersion(message) => write!(f, "{message}"),
            Self::NotInstalled => write!(f, "VS Code CLI is not installed"),
        }
    }
}

impl std::error::Error for VscodeCliError {}

impl From<std::io::Error> for VscodeCliError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<reqwest::Error> for VscodeCliError {
    fn from(value: reqwest::Error) -> Self {
        Self::Http(value)
    }
}

#[derive(Clone)]
pub struct VscodeCliManager {
    inner: Arc<Mutex<VscodeCliManagerState>>,
    notify: Arc<Notify>,
    client: reqwest::Client,
    status_callback: Arc<Mutex<Option<StatusCallback>>>,
    root_dir: PathBuf,
    process_handle: ManagedProcessHandle,
}

impl fmt::Debug for VscodeCliManager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VscodeCliManager")
            .field("root_dir", &self.root_dir)
            .finish_non_exhaustive()
    }
}

fn map_managed_process_error(error: ManagedProcessActionError) -> CodeServerError {
    CodeServerError::Spawn(error.to_string())
}

fn map_managed_process_error_vscode_cli(error: ManagedProcessActionError) -> VscodeCliError {
    VscodeCliError::Spawn(error.to_string())
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

fn forwarded_public_host(headers: &HeaderMap) -> Option<&axum::http::HeaderValue> {
    headers
        .get(HUBRIS_PUBLIC_HOST_HEADER)
        .or_else(|| headers.get(HOST))
}

fn forwarded_public_origin(headers: &HeaderMap) -> Option<&axum::http::HeaderValue> {
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

fn request_target_from_public_path(path_and_query: &str) -> Option<(VscodeRuntimeKind, String)> {
    for runtime in [VscodeRuntimeKind::VscodeCli, VscodeRuntimeKind::CodeServer] {
        if let Some(stripped) = path_and_query.strip_prefix(public_base_path(runtime)) {
            return Some((runtime, normalize_runtime_path(stripped)));
        }
    }

    None
}

fn normalize_runtime_path(path_and_query: &str) -> String {
    if path_and_query.is_empty() {
        "/".to_string()
    } else if path_and_query.starts_with('/') || path_and_query.starts_with('?') {
        format!("/{}", path_and_query.trim_start_matches('/'))
    } else {
        format!("/{path_and_query}")
    }
}

fn authorized_http_url(
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

fn upsert_query_param(path_and_query: &str, key: &str, value: &str) -> String {
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

fn preparing_install_progress() -> ManagerCodeServerInstallProgress {
    ManagerCodeServerInstallProgress {
        phase: CodeServerInstallPhaseValue::Preparing,
        percent: 5,
        downloaded_bytes: None,
        total_bytes: None,
    }
}

fn downloading_install_progress(
    percent: u8,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
) -> ManagerCodeServerInstallProgress {
    ManagerCodeServerInstallProgress {
        phase: CodeServerInstallPhaseValue::Downloading,
        percent,
        downloaded_bytes,
        total_bytes,
    }
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
    if runtime_dir_is_complete(&runtime_dir).await? && !request.force {
        return Ok(InstalledRuntime {
            version: version.clone(),
            version_semver: Version::parse(&version).expect("validated version"),
            platform: request.platform,
            runtime_dir,
            binary_path,
        });
    }

    if tokio::fs::try_exists(&runtime_dir).await? {
        tokio::fs::remove_dir_all(&runtime_dir).await?;
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
        let total_bytes = response.content_length();
        if let Some(progress) = &request.install_progress {
            progress(downloading_install_progress(
                if total_bytes.is_some() { 10 } else { 35 },
                Some(0),
                total_bytes,
            ))
            .await;
        }
        let mut file = tokio::fs::File::create(&archive_path).await?;
        let mut stream = response.bytes_stream();
        let mut downloaded_bytes = 0_u64;
        let mut last_download_percent = None;
        while let Some(chunk) = stream.try_next().await? {
            downloaded_bytes += chunk.len() as u64;
            file.write_all(&chunk).await?;
            if let (Some(total_bytes), Some(progress)) = (total_bytes, &request.install_progress) {
                let download_percent =
                    10 + ((downloaded_bytes.saturating_mul(60)) / total_bytes.max(1)) as u8;
                let download_percent = download_percent.clamp(10, 70);
                if last_download_percent != Some(download_percent) {
                    last_download_percent = Some(download_percent);
                    progress(downloading_install_progress(
                        download_percent,
                        Some(downloaded_bytes.min(total_bytes)),
                        Some(total_bytes),
                    ))
                    .await;
                }
            }
        }
        file.flush().await?;
        if let Some(progress) = &request.install_progress {
            progress(downloading_install_progress(
                70,
                Some(downloaded_bytes),
                total_bytes,
            ))
            .await;
            progress(ManagerCodeServerInstallProgress {
                phase: CodeServerInstallPhaseValue::Extracting,
                percent: 80,
                downloaded_bytes: None,
                total_bytes: None,
            })
            .await;
        }
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

    if tokio::fs::try_exists(&runtime_dir).await? {
        tokio::fs::remove_dir_all(&runtime_dir).await?;
    }

    tokio::fs::create_dir_all(request.root_dir.join(RUNTIMES_DIR)).await?;
    tokio::fs::rename(&extracted_root, &runtime_dir).await?;
    let _ = tokio::fs::remove_file(&archive_path).await;
    let _ = tokio::fs::remove_dir_all(&extract_dir).await;

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

async fn runtime_dir_is_complete(runtime_dir: &Path) -> Result<bool, CodeServerError> {
    tokio::fs::try_exists(runtime_dir.join("bin").join("code-server"))
        .await
        .map_err(Into::into)
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

    let mut command = Command::new(&request.binary_path);
    command
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
        .arg(CODE_SERVER_PUBLIC_BASE_PATH)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    command.process_group(0);
    #[cfg(target_os = "linux")]
    configure_parent_death_signal(&mut command);

    let mut child = command.spawn().map_err(|error| {
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
        process: ManagedProcessRuntime::Child(ManagedChildProcess::new(child)),
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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VscodeUpdateApiResponse {
    name: String,
}

fn detect_vscode_cli_platform() -> Result<VscodeCliPlatform, VscodeCliError> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok(VscodeCliPlatform {
            os: "linux",
            arch: "x64",
            cli_download_segment: "cli-linux-x64",
            update_segment: "linux-x64",
            archive_format: ArchiveFormat::TarGz,
        }),
        ("macos", "aarch64") => Ok(VscodeCliPlatform {
            os: "darwin",
            arch: "arm64",
            cli_download_segment: "cli-darwin-arm64",
            update_segment: "darwin-arm64",
            archive_format: ArchiveFormat::Zip,
        }),
        ("macos", "x86_64") => Ok(VscodeCliPlatform {
            os: "darwin",
            arch: "x64",
            cli_download_segment: "cli-darwin-x64",
            update_segment: "darwin",
            archive_format: ArchiveFormat::Zip,
        }),
        ("windows", "x86_64") => Ok(VscodeCliPlatform {
            os: "win32",
            arch: "x64",
            cli_download_segment: "cli-win32-x64",
            update_segment: "win32-x64-archive",
            archive_format: ArchiveFormat::Zip,
        }),
        (os, arch) => Err(VscodeCliError::UnsupportedPlatform(format!(
            "unsupported VS Code CLI host platform: {os}/{arch}"
        ))),
    }
}

fn normalize_vscode_cli_version(raw: &str) -> Result<String, VscodeCliError> {
    let version = raw.trim().trim_start_matches('v');
    Version::parse(version)
        .map_err(|_| VscodeCliError::InvalidVersion(format!("invalid VS Code version: {raw}")))?;
    Ok(version.to_string())
}

async fn fetch_latest_vscode_cli_release(
    client: reqwest::Client,
) -> Result<VscodeCliLatestRelease, VscodeCliError> {
    let platform = detect_vscode_cli_platform()?;
    let response = client
        .get(format!(
            "{VSCODE_UPDATE_BASE_URL}/api/update/{}/stable/latest",
            platform.update_segment
        ))
        .send()
        .await?
        .error_for_status()?;
    let payload: VscodeUpdateApiResponse = response.json().await?;
    Ok(VscodeCliLatestRelease {
        version: normalize_vscode_cli_version(&payload.name)?,
    })
}

fn vscode_cli_runtime_dir_name(version: &str, platform: VscodeCliPlatform) -> String {
    format!("vscode-cli-{version}-{}-{}", platform.os, platform.arch)
}

fn build_vscode_cli_launch_request(
    root_dir: &Path,
    runtime: &InstalledVscodeCliRuntime,
) -> VscodeCliLaunchRequest {
    let port = pick_unused_port().unwrap_or(8080);
    VscodeCliLaunchRequest {
        runtime_dir: runtime.runtime_dir.clone(),
        binary_path: runtime.binary_path.clone(),
        host: DEFAULT_HOST.to_string(),
        port,
        cli_data_dir: root_dir.join(VSCODE_CLI_DATA_DIR),
        server_data_dir: root_dir.join(VSCODE_SERVER_DATA_DIR),
        connection_token_file: root_dir.join(CONFIG_DIR).join("vscode-connection-token"),
        connection_token: Uuid::new_v4().to_string(),
    }
}

async fn download_vscode_cli_archive(
    request: VscodeCliDownloadRequest,
    _client: reqwest::Client,
) -> Result<InstalledVscodeCliRuntime, VscodeCliError> {
    let version = normalize_vscode_cli_version(&request.version)?;
    let dir_name = vscode_cli_runtime_dir_name(&version, request.platform);
    let runtime_dir = request.root_dir.join(RUNTIMES_DIR).join(&dir_name);
    if let Some(binary_path) = vscode_cli_runtime_binary(&runtime_dir, request.platform)
        && !request.force
    {
        return Ok(InstalledVscodeCliRuntime {
            version: version.clone(),
            version_semver: Version::parse(&version).expect("validated version"),
            platform: request.platform,
            runtime_dir,
            binary_path,
        });
    }

    if tokio::fs::try_exists(&runtime_dir).await? {
        tokio::fs::remove_dir_all(&runtime_dir).await?;
    }

    tokio::fs::create_dir_all(request.root_dir.join(RUNTIMES_DIR)).await?;
    tokio::fs::create_dir_all(request.root_dir.join(TMP_DIR)).await?;

    let extension = match request.platform.archive_format {
        ArchiveFormat::TarGz => "tar.gz",
        ArchiveFormat::Zip => "zip",
    };
    let asset_url = format!(
        "{VSCODE_UPDATE_BASE_URL}/{version}/{}/stable",
        request.platform.cli_download_segment
    );
    let archive_path =
        request
            .root_dir
            .join(TMP_DIR)
            .join(format!("{dir_name}-{}.{}", Uuid::new_v4(), extension));
    let extract_dir = request
        .root_dir
        .join(TMP_DIR)
        .join(format!("{dir_name}-extract-{}", Uuid::new_v4()));

    let download_client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(VscodeCliError::Http)?;
    let response = download_client
        .get(asset_url)
        .send()
        .await?
        .error_for_status()?;
    let total_bytes = response.content_length();
    if let Some(progress) = &request.install_progress {
        progress(downloading_install_progress(
            if total_bytes.is_some() { 10 } else { 35 },
            Some(0),
            total_bytes,
        ))
        .await;
    }

    let mut file = tokio::fs::File::create(&archive_path).await?;
    let mut stream = response.bytes_stream();
    let mut downloaded_bytes = 0_u64;
    let mut last_download_percent = None;
    while let Some(chunk) = stream.try_next().await? {
        downloaded_bytes += chunk.len() as u64;
        file.write_all(&chunk).await?;
        if let (Some(total_bytes), Some(progress)) = (total_bytes, &request.install_progress) {
            let download_percent =
                10 + ((downloaded_bytes.saturating_mul(60)) / total_bytes.max(1)) as u8;
            let download_percent = download_percent.clamp(10, 70);
            if last_download_percent != Some(download_percent) {
                last_download_percent = Some(download_percent);
                progress(downloading_install_progress(
                    download_percent,
                    Some(downloaded_bytes.min(total_bytes)),
                    Some(total_bytes),
                ))
                .await;
            }
        }
    }
    file.flush().await?;

    if let Some(progress) = &request.install_progress {
        progress(downloading_install_progress(
            70,
            Some(downloaded_bytes),
            total_bytes,
        ))
        .await;
        progress(ManagerCodeServerInstallProgress {
            phase: CodeServerInstallPhaseValue::Extracting,
            percent: 80,
            downloaded_bytes: None,
            total_bytes: None,
        })
        .await;
    }

    let archive_format = request.platform.archive_format;
    let platform = request.platform;
    let archive_path_for_extract = archive_path.clone();
    let extract_dir_for_extract = extract_dir.clone();
    let extracted_root = tokio::task::spawn_blocking(move || {
        extract_vscode_cli_archive(
            &archive_path_for_extract,
            &extract_dir_for_extract,
            archive_format,
            platform,
        )
    })
    .await
    .map_err(|error| VscodeCliError::Spawn(error.to_string()))??;

    if tokio::fs::try_exists(&runtime_dir).await? {
        tokio::fs::remove_dir_all(&runtime_dir).await?;
    }

    tokio::fs::rename(&extracted_root, &runtime_dir).await?;
    let _ = tokio::fs::remove_file(&archive_path).await;
    if extracted_root != extract_dir {
        let _ = tokio::fs::remove_dir_all(&extract_dir).await;
    }

    let binary_path =
        vscode_cli_runtime_binary(&runtime_dir, request.platform).ok_or_else(|| {
            VscodeCliError::Archive(format!(
                "missing VS Code CLI binary after extraction: {}",
                runtime_dir.display()
            ))
        })?;

    Ok(InstalledVscodeCliRuntime {
        version: version.clone(),
        version_semver: Version::parse(&version).expect("validated version"),
        platform: request.platform,
        runtime_dir,
        binary_path,
    })
}

fn extract_vscode_cli_archive(
    archive_path: &Path,
    extract_dir: &Path,
    archive_format: ArchiveFormat,
    platform: VscodeCliPlatform,
) -> Result<PathBuf, VscodeCliError> {
    std::fs::create_dir_all(extract_dir)?;
    match archive_format {
        ArchiveFormat::TarGz => {
            let file = std::fs::File::open(archive_path)?;
            let decoder = GzDecoder::new(file);
            let mut archive = Archive::new(decoder);
            archive
                .unpack(extract_dir)
                .map_err(|error| VscodeCliError::Archive(error.to_string()))?;
        }
        ArchiveFormat::Zip => {
            let file = std::fs::File::open(archive_path)?;
            let mut archive = zip::ZipArchive::new(file)
                .map_err(|error| VscodeCliError::Archive(error.to_string()))?;
            archive
                .extract(extract_dir)
                .map_err(|error| VscodeCliError::Archive(error.to_string()))?;
        }
    }

    locate_extracted_vscode_cli_root(extract_dir, platform).ok_or_else(|| {
        VscodeCliError::Archive(format!(
            "extracted VS Code CLI is missing a runnable binary: {}",
            extract_dir.display()
        ))
    })
}

fn locate_extracted_vscode_cli_root(
    extract_dir: &Path,
    platform: VscodeCliPlatform,
) -> Option<PathBuf> {
    if vscode_cli_runtime_binary(extract_dir, platform).is_some() {
        return Some(extract_dir.to_path_buf());
    }

    std::fs::read_dir(extract_dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.is_dir() && vscode_cli_runtime_binary(path, platform).is_some())
}

async fn cleanup_other_vscode_cli_runtimes(
    root_dir: PathBuf,
    platform: VscodeCliPlatform,
    keep_runtime_dir: &Path,
) -> Result<(), VscodeCliError> {
    let keep_runtime_dir = keep_runtime_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let runtimes_dir = root_dir.join(RUNTIMES_DIR);
        let entries = match std::fs::read_dir(&runtimes_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(VscodeCliError::Io(error)),
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
            if name.starts_with("vscode-cli-") && name.ends_with(&suffix) {
                std::fs::remove_dir_all(path)?;
            }
        }

        Ok(())
    })
    .await
    .map_err(|error| VscodeCliError::Spawn(error.to_string()))?
}

fn find_installed_vscode_cli_runtime_sync(
    root_dir: PathBuf,
    platform: VscodeCliPlatform,
) -> Result<Option<InstalledVscodeCliRuntime>, VscodeCliError> {
    let runtimes_dir = root_dir.join(RUNTIMES_DIR);
    let entries = match std::fs::read_dir(&runtimes_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(VscodeCliError::Io(error)),
    };

    let suffix = format!("-{}-{}", platform.os, platform.arch);
    let mut best: Option<InstalledVscodeCliRuntime> = None;
    for entry in entries {
        let entry = entry?;
        let runtime_dir = entry.path();
        if !runtime_dir.is_dir() {
            continue;
        }
        let Some(name) = runtime_dir.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(rest) = name.strip_prefix("vscode-cli-") else {
            continue;
        };
        let Some(version) = rest.strip_suffix(&suffix) else {
            continue;
        };
        let Ok(version_semver) = Version::parse(version) else {
            continue;
        };
        let Some(binary_path) = vscode_cli_runtime_binary(&runtime_dir, platform) else {
            continue;
        };

        let candidate = InstalledVscodeCliRuntime {
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

fn vscode_cli_runtime_binary(root: &Path, platform: VscodeCliPlatform) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    let wanted = if platform.os == "win32" {
        vec!["code.cmd", "code.exe"]
    } else {
        vec!["code"]
    };

    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if wanted.contains(&name) {
                return Some(path);
            }
        }
    }

    None
}

async fn launch_vscode_cli(
    request: VscodeCliLaunchRequest,
) -> Result<RunningVscodeCli, VscodeCliError> {
    prepare_vscode_cli_dirs(&request).await?;

    let mut command = Command::new(&request.binary_path);
    command
        .arg("serve-web")
        .arg("--host")
        .arg(&request.host)
        .arg("--port")
        .arg(request.port.to_string())
        .arg("--accept-server-license-terms")
        .arg("--server-base-path")
        .arg(VSCODE_CLI_PUBLIC_BASE_PATH)
        .arg("--server-data-dir")
        .arg(&request.server_data_dir)
        .arg("--connection-token-file")
        .arg(&request.connection_token_file)
        .arg("--disable-telemetry")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .current_dir(&request.runtime_dir);

    #[cfg(unix)]
    command.process_group(0);
    #[cfg(target_os = "linux")]
    configure_parent_death_signal(&mut command);

    let mut child = command.spawn().map_err(|error| {
        VscodeCliError::Spawn(format!(
            "failed to launch VS Code CLI binary {}: {error}",
            request.binary_path.display()
        ))
    })?;

    let connection = VscodeConnection {
        runtime: VscodeRuntimeKind::VscodeCli,
        base_url: format!("http://{}:{}", request.host, request.port),
        ws_base_url: format!("ws://{}:{}", request.host, request.port),
        upstream_base_path: VSCODE_CLI_UPSTREAM_BASE_PATH.to_string(),
        connection_token: Some(request.connection_token.clone()),
    };

    if let Err(error) = wait_for_vscode_cli_ready(&connection).await {
        let _ = child.kill().await;
        return Err(error);
    }

    Ok(RunningVscodeCli {
        connection,
        process: ManagedProcessRuntime::Child(ManagedChildProcess::new(child)),
    })
}

async fn prepare_vscode_cli_dirs(request: &VscodeCliLaunchRequest) -> Result<(), VscodeCliError> {
    tokio::fs::create_dir_all(&request.runtime_dir).await?;
    tokio::fs::create_dir_all(&request.cli_data_dir).await?;
    tokio::fs::create_dir_all(&request.server_data_dir).await?;
    tokio::fs::create_dir_all(
        request
            .connection_token_file
            .parent()
            .unwrap_or_else(|| Path::new(".")),
    )
    .await?;
    tokio::fs::write(&request.connection_token_file, &request.connection_token).await?;
    Ok(())
}

async fn wait_for_vscode_cli_ready(connection: &VscodeConnection) -> Result<(), VscodeCliError> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(VscodeCliError::Http)?;
    let started = tokio::time::Instant::now();
    let authenticated_url = connection.http_url(&upsert_query_param(
        "/",
        VSCODE_TOKEN_QUERY_PARAM,
        connection.connection_token.as_deref().unwrap_or_default(),
    ));
    let ready_url = connection.http_url("/");
    let mut cookie = None;

    loop {
        let response = client.get(&authenticated_url).send().await;
        match response {
            Ok(response) if response.status() == StatusCode::ACCEPTED => {}
            Ok(response) => {
                if cookie.is_none() {
                    cookie = extract_vscode_token_cookie(response.headers());
                }

                if let Some(cookie) = cookie.as_deref() {
                    let ready_response = client.get(&ready_url).header(COOKIE, cookie).send().await;
                    if let Ok(ready_response) = ready_response
                        && ready_response.status() == StatusCode::OK
                    {
                        return Ok(());
                    }
                } else if response.status() == StatusCode::OK {
                    return Ok(());
                }
            }
            Err(_) => {}
        }

        if started.elapsed() >= READY_TIMEOUT {
            return Err(VscodeCliError::StartupTimeout);
        }
        tokio::time::sleep(READY_POLL_INTERVAL).await;
    }
}

fn extract_vscode_token_cookie(headers: &HeaderMap) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::extract::Request as AxumRequest;
    use axum::http::HeaderValue;
    use axum::routing::any;
    use axum::{Router, body::Body};
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use tar::Builder;

    use super::*;
    use crate::api::settings::{SettingsPatch, VscodeSettingsPatch};
    use crate::process_manager::TestProcessProbe;
    use crate::{AppState, build_router, events::EventKind};
    #[cfg(unix)]
    use std::fs::Permissions;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

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

    async fn select_code_server_runtime(state: &AppState) {
        state
            .settings
            .patch(SettingsPatch {
                appearance: None,
                terminal: None,
                editor: None,
                worktree: None,
                vscode: Some(VscodeSettingsPatch {
                    runtime: Some(VscodeRuntimeKind::CodeServer),
                }),
            })
            .await
            .unwrap();
    }

    async fn replace_code_server_runtime(
        state: &mut AppState,
        code_server: Arc<CodeServerManager>,
    ) {
        state.processes.register_controller(code_server.clone());
        code_server.register_process_callback().await;

        let vscode_cli = state.vscode.vscode_cli.clone();
        register_vscode_tasks(&state.tasks, code_server.clone(), vscode_cli.clone());
        let vscode = Arc::new(VscodeManager::new(
            state.settings.clone(),
            state.events.clone(),
            state.tasks.clone(),
            code_server,
            vscode_cli,
        ));
        vscode.register_status_callbacks().await;
        state.vscode = vscode;
        select_code_server_runtime(state).await;
    }

    #[cfg(unix)]
    async fn wait_for_file(path: &Path) -> String {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if let Ok(contents) = tokio::fs::read_to_string(path).await
                && !contents.trim().is_empty()
            {
                return contents;
            }

            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for {}",
                path.display()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[cfg(unix)]
    fn process_exists(pid: i32) -> bool {
        let result = unsafe { libc::kill(pid, 0) };
        if result == 0 {
            return true;
        }

        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    #[cfg(target_os = "linux")]
    fn process_is_zombie(pid: i32) -> bool {
        let status_path = format!("/proc/{pid}/status");
        let Ok(status) = std::fs::read_to_string(status_path) else {
            return false;
        };

        status
            .lines()
            .find(|line| line.starts_with("State:"))
            .is_some_and(|line| line.contains("\tZ"))
    }

    #[cfg(unix)]
    async fn wait_for_process_exit(pid: i32) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if !process_exists(pid) {
                return;
            }

            #[cfg(target_os = "linux")]
            if process_is_zombie(pid) {
                return;
            }

            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for process {pid} to exit"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn linux_parent_death_signal_terminates_child_after_parent_exit() {
        let tmp = tempfile::TempDir::new().unwrap();
        let child_pid_path = tmp.path().join("child.pid");

        let status = Command::new(std::env::current_exe().unwrap())
            .arg("--ignored")
            .arg("--exact")
            .arg("vscode::tests::linux_parent_death_signal_helper")
            .env("HUBRIS_TEST_PDEATHSIG_CHILD_PID_FILE", &child_pid_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .unwrap();

        let child_pid: i32 = wait_for_file(&child_pid_path).await.trim().parse().unwrap();
        assert!(
            status.success() || !process_exists(child_pid),
            "helper test exited unsuccessfully before child shutdown was observed: {status:?}"
        );
        wait_for_process_exit(child_pid).await;
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore]
    async fn linux_parent_death_signal_helper() {
        let Some(child_pid_path) = std::env::var_os("HUBRIS_TEST_PDEATHSIG_CHILD_PID_FILE") else {
            return;
        };

        let mut command = Command::new("sleep");
        command
            .arg("1000")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_parent_death_signal(&mut command);

        let child = command.spawn().unwrap();
        let child_pid = child.id().unwrap();
        std::fs::write(PathBuf::from(child_pid_path), format!("{child_pid}")).unwrap();
    }

    #[test]
    fn request_target_from_public_path_extracts_runtime_relative_path() {
        assert_eq!(
            request_target_from_public_path("/code/vscode-cli"),
            Some((VscodeRuntimeKind::VscodeCli, "/".to_string()))
        );
        assert_eq!(
            request_target_from_public_path("/code/vscode-cli/?folder=%2Ftmp%2Fdemo"),
            Some((
                VscodeRuntimeKind::VscodeCli,
                "/?folder=%2Ftmp%2Fdemo".to_string()
            ))
        );
        assert_eq!(
            request_target_from_public_path("/code/code-server/static/out.js"),
            Some((VscodeRuntimeKind::CodeServer, "/static/out.js".to_string()))
        );
        assert_eq!(request_target_from_public_path("/code"), None);
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
                force: false,
                install_progress: None,
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
    async fn download_runtime_archive_replaces_incomplete_target_runtime() {
        let version = "4.114.1";
        let platform = CodeServerPlatform {
            os: "linux",
            arch: "amd64",
        };
        let dir_name = runtime_dir_name(version, platform);
        let asset_name = format!("{dir_name}.tar.gz");
        let archive = Arc::new(runtime_archive(&dir_name));
        let upstream = Router::new().route(
            &format!("/releases/download/v{version}/{asset_name}"),
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
        let root_dir = tmp.path().join("code-server");
        let runtime_dir = root_dir.join(RUNTIMES_DIR).join(&dir_name);
        tokio::fs::create_dir_all(&runtime_dir).await.unwrap();
        tokio::fs::write(runtime_dir.join("stale.txt"), "stale")
            .await
            .unwrap();

        let installed = download_runtime_archive_from_base_url(
            CodeServerDownloadRequest {
                version: version.to_string(),
                platform,
                root_dir: root_dir.clone(),
                force: false,
                install_progress: None,
            },
            reqwest::Client::new(),
            &format!("http://{addr}/releases"),
        )
        .await
        .unwrap();

        assert_eq!(installed.version, version);
        assert!(tokio::fs::try_exists(installed.binary_path).await.unwrap());
        assert!(
            !tokio::fs::try_exists(runtime_dir.join("stale.txt"))
                .await
                .unwrap()
        );
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
                    process: ManagedProcessRuntime::External,
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
        start_code_server_install_task(&manager, Some("4.114.1".to_string()), false).await;
        wait_for_running_status(&manager).await;
        manager.stop().await.unwrap();

        let (first, second) = tokio::join!(manager.ensure_ready(), manager.ensure_ready());

        assert!(first.is_ok());
        assert!(second.is_ok());
        assert_eq!(launches.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn ensure_ready_waits_for_install_completion_without_relaunching() {
        let launches = Arc::new(AtomicUsize::new(0));
        let launches_for_download = launches.clone();
        let download: DownloadRuntimeFn = Arc::new(move |request: CodeServerDownloadRequest| {
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(25)).await;
                let dir_name = runtime_dir_name(&request.version, request.platform);
                let runtime_dir = request.root_dir.join(RUNTIMES_DIR).join(&dir_name);
                tokio::fs::create_dir_all(runtime_dir.join("bin")).await?;
                tokio::fs::write(runtime_dir.join("bin").join("code-server"), "#!/bin/sh\n")
                    .await?;
                Ok(InstalledRuntime {
                    version: request.version.clone(),
                    version_semver: Version::parse(&request.version).unwrap(),
                    platform: request.platform,
                    runtime_dir: runtime_dir.clone(),
                    binary_path: runtime_dir.join("bin").join("code-server"),
                })
            })
        });
        let launch: LaunchFn = Arc::new(move |request| {
            let launches = launches_for_download.clone();
            Box::pin(async move {
                launches.fetch_add(1, Ordering::Relaxed);
                Ok(RunningCodeServer {
                    connection: CodeServerConnection {
                        base_url: format!("http://{}:{}", request.host, request.port),
                    },
                    process: ManagedProcessRuntime::External,
                })
            })
        });

        let tmp = tempfile::TempDir::new().unwrap();
        let manager = CodeServerManager::with_hooks(
            tmp.path().join("code-server"),
            static_fetch_latest("4.114.1"),
            download,
            launch,
        );

        start_code_server_install_task(&manager, Some("4.114.1".to_string()), false).await;
        let install = manager.status().await;
        assert_eq!(
            install.process_status,
            CodeServerProcessStatusValue::Installing
        );

        let connection = tokio::time::timeout(Duration::from_secs(2), manager.ensure_ready())
            .await
            .unwrap()
            .unwrap();

        assert!(connection.base_url.starts_with("http://127.0.0.1:"));
        assert_eq!(launches.load(Ordering::Relaxed), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn managed_child_shutdown_terminates_process_group_gracefully() {
        let tmp = tempfile::TempDir::new().unwrap();
        let script_path = tmp.path().join("graceful-shutdown.sh");
        let child_pid_path = tmp.path().join("child.pid");
        let ready_path = tmp.path().join("ready");
        tokio::fs::write(
            &script_path,
            format!(
                concat!(
                    "#!/bin/sh\n",
                    "set -eu\n",
                    "child_pid_file=\"{}\"\n",
                    "ready_file=\"{}\"\n",
                    "sleep 1000 &\n",
                    "child=$!\n",
                    "echo \"$child\" > \"$child_pid_file\"\n",
                    "echo ready > \"$ready_file\"\n",
                    "trap 'exit 0' TERM INT\n",
                    "wait \"$child\"\n"
                ),
                child_pid_path.display(),
                ready_path.display()
            ),
        )
        .await
        .unwrap();
        tokio::fs::set_permissions(&script_path, Permissions::from_mode(0o755))
            .await
            .unwrap();

        let mut command = Command::new(&script_path);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        let child = command.spawn().unwrap();
        let mut process = ManagedChildProcess::new(child);

        let child_pid: i32 = wait_for_file(&child_pid_path).await.trim().parse().unwrap();
        let _ = wait_for_file(&ready_path).await;

        process
            .shutdown_with_timeout(Duration::from_millis(250))
            .await
            .unwrap();

        wait_for_process_exit(child_pid).await;
        assert!(!process.is_alive().unwrap());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn managed_child_shutdown_escalates_after_timeout() {
        let tmp = tempfile::TempDir::new().unwrap();
        let script_path = tmp.path().join("ignore-term.sh");
        let ready_path = tmp.path().join("ready");
        tokio::fs::write(
            &script_path,
            format!(
                concat!(
                    "#!/bin/sh\n",
                    "set -eu\n",
                    "ready_file=\"{}\"\n",
                    "echo ready > \"$ready_file\"\n",
                    "trap '' TERM INT\n",
                    "while :; do\n",
                    "  sleep 1\n",
                    "done\n"
                ),
                ready_path.display()
            ),
        )
        .await
        .unwrap();
        tokio::fs::set_permissions(&script_path, Permissions::from_mode(0o755))
            .await
            .unwrap();

        let mut command = Command::new(&script_path);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        let child = command.spawn().unwrap();
        let mut process = ManagedChildProcess::new(child);

        let _ = wait_for_file(&ready_path).await;
        let started = tokio::time::Instant::now();
        process
            .shutdown_with_timeout(Duration::from_millis(250))
            .await
            .unwrap();

        assert!(started.elapsed() >= Duration::from_millis(250));
        assert!(!process.is_alive().unwrap());
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
                        process: ManagedProcessRuntime::External,
                    })
                })
            }),
        );
        let probe = TestProcessProbe::new(true);

        {
            let mut state = manager.inner.lock().await;
            state.runtime = ManagerRuntimeState::Ready(CodeServerConnection {
                base_url: "http://127.0.0.1:1234".into(),
            });
        }
        manager.process_handle.finish_running(probe.runtime()).await;

        manager.shutdown().await.unwrap();

        assert_eq!(probe.shutdowns.load(Ordering::Relaxed), 1);
        assert_eq!(probe.drop_kills.load(Ordering::Relaxed), 0);

        let status = manager.process_handle.status().await.unwrap();
        assert_eq!(
            status.lifecycle_state,
            ManagedProcessLifecycleState::Stopped
        );
    }

    #[tokio::test]
    async fn failed_shutdown_recovers_out_of_stopping_state() {
        let manager = CodeServerManager::with_hooks(
            PathBuf::from("/tmp/hubris/code-server"),
            static_fetch_latest("4.114.1"),
            static_download_runtime(PathBuf::from("/tmp/hubris")),
            Arc::new(|_| {
                Box::pin(async {
                    Ok(RunningCodeServer {
                        connection: CodeServerConnection {
                            base_url: "http://127.0.0.1:1234".into(),
                        },
                        process: ManagedProcessRuntime::External,
                    })
                })
            }),
        );
        let probe = TestProcessProbe::new(true).with_shutdown_error();
        manager.process_handle.finish_running(probe.runtime()).await;

        let error = manager.stop().await.unwrap_err();
        assert!(matches!(error, CodeServerError::Spawn(_)));

        let status = manager.process_handle.status().await.unwrap();
        assert_eq!(status.lifecycle_state, ManagedProcessLifecycleState::Error);

        manager.process_handle.finish_stopped().await;
        let recovered = manager.process_handle.status().await.unwrap();
        assert_eq!(
            recovered.lifecycle_state,
            ManagedProcessLifecycleState::Stopped
        );
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
    async fn code_server_proxy_preserves_regular_cookies() {
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
                    process: ManagedProcessRuntime::External,
                })
            })
        });

        let tmp = tempfile::TempDir::new().unwrap();
        let mut state = AppState::new(tmp.path().to_path_buf()).await;
        replace_code_server_runtime(
            &mut state,
            Arc::new(CodeServerManager::with_hooks(
                tmp.path().join("code-server"),
                static_fetch_latest("4.114.1"),
                static_download_runtime(tmp.path().to_path_buf()),
                launch,
            )),
        )
        .await;
        state
            .vscode
            .install(Some("4.114.1".to_string()), false)
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
            .get(format!(
                "http://{addr}/code/code-server/?folder=%2Ftmp%2Fdemo"
            ))
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

    #[test]
    fn forwarded_public_headers_override_host_and_origin() {
        let headers = HeaderMap::from_iter([
            (HOST, HeaderValue::from_static("proxy.test")),
            (ORIGIN, HeaderValue::from_static("https://proxy.test")),
            (
                axum::http::HeaderName::from_static(HUBRIS_PUBLIC_HOST_HEADER),
                HeaderValue::from_static("code-server.desktop.internal.hubris.build"),
            ),
            (
                axum::http::HeaderName::from_static(HUBRIS_PUBLIC_ORIGIN_HEADER),
                HeaderValue::from_static("https://code-server.desktop.internal.hubris.build"),
            ),
        ]);

        assert_eq!(
            forwarded_public_host(&headers),
            Some(&HeaderValue::from_static(
                "code-server.desktop.internal.hubris.build"
            ))
        );
        assert_eq!(
            forwarded_public_origin(&headers),
            Some(&HeaderValue::from_static(
                "https://code-server.desktop.internal.hubris.build"
            ))
        );
    }

    #[tokio::test]
    async fn vscode_cli_proxy_overrides_stale_cookie_with_current_token() {
        let upstream = Router::new().route(
            "/code",
            any(|request: AxumRequest<Body>| async move {
                let path = request
                    .uri()
                    .path_and_query()
                    .map(|value| value.as_str().to_string())
                    .unwrap_or_default();
                let cookie = request
                    .headers()
                    .get(axum::http::header::COOKIE)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                Response::builder()
                    .status(StatusCode::OK)
                    .header(axum::http::header::CONTENT_TYPE, "text/plain")
                    .body(Body::from(format!("{path}\n{cookie}")))
                    .unwrap()
            }),
        );
        let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(upstream_listener, upstream).await.unwrap();
        });

        let connection = VscodeConnection {
            runtime: VscodeRuntimeKind::VscodeCli,
            base_url: format!("http://{}", upstream_addr),
            ws_base_url: format!("ws://{}", upstream_addr),
            upstream_base_path: VSCODE_CLI_UPSTREAM_BASE_PATH.to_string(),
            connection_token: Some("fresh-token".to_string()),
        };

        let path = authorized_http_url(
            &connection,
            "/?folder=%2Ftmp&tkn=stale-query",
            &HeaderMap::from_iter([(
                axum::http::header::COOKIE,
                HeaderValue::from_static("vscode-tkn=stale-cookie; theme=dark"),
            )]),
        );

        assert_eq!(
            path,
            format!(
                "http://{}/code/vscode-cli/?folder=%2Ftmp&tkn=fresh-token",
                upstream_addr
            )
        );
    }

    #[tokio::test]
    async fn removed_shared_code_path_returns_not_found() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = AppState::new(tmp.path().to_path_buf()).await;
        let app = build_router(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let response = reqwest::get(format!("http://{addr}/code")).await.unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn vscode_status_endpoint_reports_not_installed() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = AppState::new(tmp.path().to_path_buf()).await;
        let app = build_router(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let response = reqwest::get(format!("http://{addr}/api/vscode"))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["selectedRuntime"], "vscodeCli");
        assert_eq!(
            body["codeServer"]["installedVersion"],
            serde_json::Value::Null
        );
        assert_eq!(
            body["vscodeCli"]["installedVersion"],
            serde_json::Value::Null
        );
        assert_eq!(body["vscodeCli"]["processStatus"], "stopped");
    }

    #[tokio::test]
    async fn vscode_install_endpoint_installs_and_starts_code_server_runtime() {
        let download: DownloadRuntimeFn = Arc::new(move |request: CodeServerDownloadRequest| {
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                let dir_name = runtime_dir_name(&request.version, request.platform);
                let runtime_dir = request.root_dir.join(RUNTIMES_DIR).join(&dir_name);
                tokio::fs::create_dir_all(runtime_dir.join("bin")).await?;
                tokio::fs::write(runtime_dir.join("bin").join("code-server"), "#!/bin/sh\n")
                    .await?;
                Ok(InstalledRuntime {
                    version: request.version.clone(),
                    version_semver: Version::parse(&request.version).unwrap(),
                    platform: request.platform,
                    runtime_dir: runtime_dir.clone(),
                    binary_path: runtime_dir.join("bin").join("code-server"),
                })
            })
        });
        let launch: LaunchFn = Arc::new(move |request| {
            Box::pin(async move {
                Ok(RunningCodeServer {
                    connection: CodeServerConnection {
                        base_url: format!("http://{}:{}", request.host, request.port),
                    },
                    process: ManagedProcessRuntime::External,
                })
            })
        });

        let tmp = tempfile::TempDir::new().unwrap();
        let mut state = AppState::new(tmp.path().to_path_buf()).await;
        replace_code_server_runtime(
            &mut state,
            Arc::new(CodeServerManager::with_hooks(
                tmp.path().join("code-server"),
                static_fetch_latest("4.114.1"),
                download,
                launch,
            )),
        )
        .await;
        select_code_server_runtime(&state).await;
        let app = build_router(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{addr}/api/vscode/install"))
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["selectedRuntime"], "codeServer");
        assert_eq!(
            body["codeServer"]["installedVersion"],
            serde_json::Value::Null
        );
        assert!(
            body["codeServer"]["processStatus"] == "stopped"
                || body["codeServer"]["processStatus"] == "installing"
        );
        assert_eq!(
            body["codeServer"]["latest"]["latestVersion"],
            serde_json::Value::Null
        );

        let started = tokio::time::Instant::now();
        loop {
            let response = client
                .get(format!("http://{addr}/api/vscode"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            let body: serde_json::Value = response.json().await.unwrap();
            if body["codeServer"]["processStatus"] == "running" {
                assert_eq!(body["codeServer"]["installedVersion"], "4.114.1");
                assert_eq!(
                    body["codeServer"]["installProgress"],
                    serde_json::Value::Null
                );
                break;
            }

            assert!(
                started.elapsed() < Duration::from_secs(2),
                "code-server install never reached running state: {body}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn vscode_install_endpoint_rejects_invalid_code_server_versions() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = AppState::new(tmp.path().to_path_buf()).await;
        select_code_server_runtime(&state).await;
        let app = build_router(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{addr}/api/vscode/install"))
            .json(&serde_json::json!({ "version": "latest" }))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(
            body["message"],
            serde_json::Value::String("invalid code-server version: latest".to_string())
        );

        let status = client
            .get(format!("http://{addr}/api/vscode"))
            .send()
            .await
            .unwrap();
        let body: serde_json::Value = status.json().await.unwrap();
        assert_eq!(body["selectedRuntime"], "codeServer");
        assert_eq!(body["codeServer"]["processStatus"], "stopped");
        assert_eq!(
            body["codeServer"]["installProgress"],
            serde_json::Value::Null
        );
    }

    #[tokio::test]
    async fn force_reinstall_reuses_installed_version() {
        let requests = Arc::new(Mutex::new(Vec::<(String, bool)>::new()));
        let requests_for_download = requests.clone();
        let download: DownloadRuntimeFn = Arc::new(move |request: CodeServerDownloadRequest| {
            let requests = requests_for_download.clone();
            Box::pin(async move {
                requests
                    .lock()
                    .await
                    .push((request.version.clone(), request.force));
                let dir_name = runtime_dir_name(&request.version, request.platform);
                let runtime_dir = request.root_dir.join(RUNTIMES_DIR).join(&dir_name);
                tokio::fs::create_dir_all(runtime_dir.join("bin")).await?;
                tokio::fs::write(runtime_dir.join("bin").join("code-server"), "#!/bin/sh\n")
                    .await?;
                Ok(InstalledRuntime {
                    version: request.version.clone(),
                    version_semver: Version::parse(&request.version).unwrap(),
                    platform: request.platform,
                    runtime_dir: runtime_dir.clone(),
                    binary_path: runtime_dir.join("bin").join("code-server"),
                })
            })
        });
        let launch: LaunchFn = Arc::new(move |request| {
            Box::pin(async move {
                Ok(RunningCodeServer {
                    connection: CodeServerConnection {
                        base_url: format!("http://{}:{}", request.host, request.port),
                    },
                    process: ManagedProcessRuntime::External,
                })
            })
        });
        let tmp = tempfile::TempDir::new().unwrap();
        let manager = CodeServerManager::with_hooks(
            tmp.path().join("code-server"),
            static_fetch_latest("9.9.9"),
            download,
            launch,
        );

        start_code_server_install_task(&manager, Some("4.114.1".to_string()), false).await;
        wait_for_running_status(&manager).await;

        start_code_server_install_task(&manager, None, true).await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while tokio::time::Instant::now() < deadline {
            if requests.lock().await.len() == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        wait_for_running_status(&manager).await;

        let requests = requests.lock().await.clone();
        assert_eq!(
            requests,
            vec![
                ("4.114.1".to_string(), false),
                ("4.114.1".to_string(), true),
            ]
        );
    }

    #[tokio::test]
    async fn install_emits_code_server_updated_events_with_progress() {
        let events = Arc::new(EventBus::new());
        let mut rx = events.subscribe();
        let download: DownloadRuntimeFn = Arc::new(move |request: CodeServerDownloadRequest| {
            Box::pin(async move {
                if let Some(progress) = &request.install_progress {
                    progress(ManagerCodeServerInstallProgress {
                        phase: CodeServerInstallPhaseValue::Downloading,
                        percent: 42,
                        downloaded_bytes: Some(42),
                        total_bytes: Some(100),
                    })
                    .await;
                }

                let dir_name = runtime_dir_name(&request.version, request.platform);
                let runtime_dir = request.root_dir.join(RUNTIMES_DIR).join(&dir_name);
                tokio::fs::create_dir_all(runtime_dir.join("bin")).await?;
                tokio::fs::write(runtime_dir.join("bin").join("code-server"), "#!/bin/sh\n")
                    .await?;

                Ok(InstalledRuntime {
                    version: request.version.clone(),
                    version_semver: Version::parse(&request.version).unwrap(),
                    platform: request.platform,
                    runtime_dir: runtime_dir.clone(),
                    binary_path: runtime_dir.join("bin").join("code-server"),
                })
            })
        });
        let launch: LaunchFn = Arc::new(move |_request| {
            Box::pin(async {
                Ok(RunningCodeServer {
                    connection: CodeServerConnection {
                        base_url: "http://127.0.0.1:1234".into(),
                    },
                    process: ManagedProcessRuntime::External,
                })
            })
        });
        let tmp = tempfile::TempDir::new().unwrap();
        let process_service = Arc::new(ManagedProcessService::new(events.clone()));
        let code_server = Arc::new(CodeServerManager {
            inner: Arc::new(Mutex::new(ManagerState {
                latest: None,
                install_progress: None,
                runtime: ManagerRuntimeState::Idle,
            })),
            notify: Arc::new(Notify::new()),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            status_callback: Arc::new(Mutex::new(None)),
            fetch_latest: static_fetch_latest("4.114.1"),
            download_runtime: download,
            launch,
            root_dir: tmp.path().join("code-server"),
            process_handle: process_service.register_process("code_server", "code-server"),
        });
        code_server.register_process_callback().await;

        let settings = Arc::new(
            SettingsManager::new(tmp.path().join("settings.toml"))
                .await
                .unwrap(),
        );
        settings
            .patch(SettingsPatch {
                appearance: None,
                terminal: None,
                editor: None,
                worktree: None,
                vscode: Some(VscodeSettingsPatch {
                    runtime: Some(VscodeRuntimeKind::CodeServer),
                }),
            })
            .await
            .unwrap();
        let vscode_cli = Arc::new(VscodeCliManager::new(
            tmp.path().join("vscode-cli"),
            events.clone(),
            process_service.clone(),
        ));
        vscode_cli.register_process_callback().await;
        let tasks = Arc::new(TaskService::new(events.clone()));
        register_vscode_tasks(&tasks, code_server.clone(), vscode_cli.clone());
        let manager = Arc::new(VscodeManager::new(
            settings,
            events.clone(),
            tasks,
            code_server,
            vscode_cli,
        ));
        manager.register_status_callbacks().await;

        let initial = manager
            .install(Some("4.114.1".to_string()), false)
            .await
            .unwrap();
        assert_eq!(
            initial.code_server.process_status,
            CodeServerProcessStatusValue::Installing
        );

        let mut saw_preparing = false;
        let mut saw_downloading = false;
        let mut saw_task_backed_update = false;
        let mut saw_running = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);

        while tokio::time::Instant::now() < deadline && !saw_running {
            let timeout = deadline.saturating_duration_since(tokio::time::Instant::now());
            let event = tokio::time::timeout(timeout, rx.recv())
                .await
                .unwrap()
                .unwrap();

            let EventKind::VscodeUpdated(status) = &event.kind else {
                continue;
            };

            let code_server_status = &status.code_server;

            if code_server_status.process_status
                == crate::api::vscode::VscodeProcessStatus::Installing
            {
                if code_server_status.active_task_id.is_some() {
                    saw_task_backed_update = true;
                }

                if code_server_status
                    .install_progress
                    .as_ref()
                    .is_some_and(|progress| {
                        progress.phase == crate::api::vscode::VscodeInstallPhase::Preparing
                    })
                {
                    saw_preparing = true;
                }

                if code_server_status
                    .install_progress
                    .as_ref()
                    .is_some_and(|progress| {
                        progress.phase == crate::api::vscode::VscodeInstallPhase::Downloading
                            && progress.percent == 42
                            && progress.downloaded_bytes == Some(42)
                            && progress.total_bytes == Some(100)
                    })
                {
                    saw_downloading = true;
                }
            }

            if code_server_status.process_status == crate::api::vscode::VscodeProcessStatus::Running
            {
                if code_server_status.active_task_id.is_some() {
                    saw_task_backed_update = true;
                }

                if code_server_status.active_task_id.is_none()
                    && code_server_status.install_progress.is_none()
                {
                    assert_eq!(
                        code_server_status.installed_version.as_deref(),
                        Some("4.114.1")
                    );
                    saw_running = true;
                }
            }
        }

        assert!(
            saw_task_backed_update,
            "missing active task id during install"
        );
        assert!(saw_preparing, "missing preparing code-server event");
        assert!(saw_downloading, "missing downloading code-server event");
        assert!(saw_running, "missing running code-server event");
    }

    #[tokio::test]
    async fn vscode_cli_install_stop_does_not_wait_on_its_own_install_state() {
        let events = Arc::new(EventBus::new());
        let process_service = Arc::new(ManagedProcessService::new(events.clone()));
        let manager = Arc::new(VscodeCliManager::new(
            tempfile::TempDir::new().unwrap().path().join("vscode-cli"),
            events,
            process_service,
        ));

        {
            let mut state = manager.inner.lock().await;
            state.runtime = VscodeCliRuntimeState::Installing;
        }

        tokio::time::timeout(
            Duration::from_millis(200),
            manager.stop_managed_process_for_install(),
        )
        .await
        .expect("install stop path should not block on current install state")
        .unwrap();
    }

    #[tokio::test]
    async fn vscode_cli_stop_waits_for_in_progress_install() {
        let events = Arc::new(EventBus::new());
        let process_service = Arc::new(ManagedProcessService::new(events.clone()));
        let manager = Arc::new(VscodeCliManager::new(
            tempfile::TempDir::new().unwrap().path().join("vscode-cli"),
            events,
            process_service,
        ));

        {
            let mut state = manager.inner.lock().await;
            state.runtime = VscodeCliRuntimeState::Installing;
        }

        let manager_for_stop = manager.clone();
        let stop_task = tokio::spawn(async move { manager_for_stop.stop().await });

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !stop_task.is_finished(),
            "stop should wait for install completion"
        );

        {
            let mut state = manager.inner.lock().await;
            state.runtime = VscodeCliRuntimeState::Idle;
        }
        manager.notify.notify_waiters();

        stop_task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn vscode_cli_restart_waits_for_in_progress_install_before_starting() {
        let events = Arc::new(EventBus::new());
        let process_service = Arc::new(ManagedProcessService::new(events.clone()));
        let manager = Arc::new(VscodeCliManager::new(
            tempfile::TempDir::new().unwrap().path().join("vscode-cli"),
            events,
            process_service,
        ));

        {
            let mut state = manager.inner.lock().await;
            state.runtime = VscodeCliRuntimeState::Installing;
        }

        let manager_for_restart = manager.clone();
        let restart_task = tokio::spawn(async move { manager_for_restart.restart().await });

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !restart_task.is_finished(),
            "restart should wait for install completion before starting"
        );

        {
            let mut state = manager.inner.lock().await;
            state.runtime = VscodeCliRuntimeState::Idle;
        }
        manager.notify.notify_waiters();

        let error = restart_task.await.unwrap().unwrap_err();
        assert!(matches!(error, VscodeCliError::NotInstalled));
    }

    async fn wait_for_running_status(manager: &CodeServerManager) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while tokio::time::Instant::now() < deadline {
            let status = manager.status().await;
            if status.process_status == CodeServerProcessStatusValue::Running {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        panic!("code-server never reached running state");
    }

    async fn start_code_server_install_task(
        manager: &CodeServerManager,
        version: Option<String>,
        force: bool,
    ) {
        let events = Arc::new(EventBus::new());
        let tasks = TaskService::new(events.clone());
        let processes = Arc::new(ManagedProcessService::new(events));
        let runtime_root = manager
            .root_dir
            .parent()
            .unwrap_or(manager.root_dir.as_path())
            .to_path_buf();
        let vscode_cli = Arc::new(VscodeCliManager::new(
            runtime_root.join("vscode-cli-test"),
            Arc::new(EventBus::new()),
            processes,
        ));
        register_vscode_tasks(&tasks, Arc::new(manager.clone()), vscode_cli);
        tasks
            .start(
                TASK_VSCODE_INSTALL_RUNTIME,
                vscode_task_input(VscodeRuntimeKind::CodeServer, version, force),
            )
            .await
            .unwrap();
    }
}
