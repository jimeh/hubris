use futures_util::future::BoxFuture;
use std::path::PathBuf;
use std::sync::Arc;

mod code_server;
mod proxy;
mod runtime;
mod tasks;
mod vscode_cli;

pub use code_server::CodeServerManager;
pub use proxy::proxy_code_request;
pub use vscode_cli::VscodeCliManager;

use crate::api::settings::VscodeRuntimeKind;
use crate::events::EventBus;
use crate::settings_manager::SettingsManager;
use crate::task_manager::{TaskActionError, TaskService};
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
const REQUEST_BODY_LIMIT: usize = 32 * 1024 * 1024;
const RELEASES_BASE_URL: &str = "https://github.com/coder/code-server/releases";
const VSCODE_UPDATE_BASE_URL: &str = "https://update.code.visualstudio.com";
const USER_DIR: &str = "user";
const EXTENSIONS_DIR: &str = "extensions";
const CONFIG_DIR: &str = "config";
const VSCODE_CLI_DATA_DIR: &str = "cli-data";
const VSCODE_SERVER_DATA_DIR: &str = "server-data";
const VSCODE_TOKEN_COOKIE_NAME: &str = "vscode-tkn";
const VSCODE_TOKEN_QUERY_PARAM: &str = "tkn";

type StatusCallback = Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>;

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
        let runtime_path = proxy::normalize_runtime_path(runtime_path);
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

#[derive(Debug, thiserror::Error)]
pub enum VscodeError {
    #[error(transparent)]
    CodeServer(#[from] CodeServerError),
    #[error(transparent)]
    VscodeCli(#[from] VscodeCliError),
    #[error(transparent)]
    Task(#[from] TaskActionError),
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

#[derive(Debug, thiserror::Error)]
pub enum CodeServerError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Http(#[from] reqwest::Error),
    #[error("{0}")]
    Archive(String),
    #[error("{0}")]
    Spawn(String),
    #[error("timed out waiting for code-server")]
    StartupTimeout,
    #[error("{0}")]
    UnsupportedPlatform(String),
    #[error("{0}")]
    InvalidReleaseRedirect(String),
    #[error("{0}")]
    InvalidVersion(String),
    #[error("code-server is not installed")]
    NotInstalled,
    #[error("{0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),
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

    pub async fn register_status_callbacks(self: Arc<Self>) {
        let weak = Arc::downgrade(&self);
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

        let weak = Arc::downgrade(&self);
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

        let weak = Arc::downgrade(&self);
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

#[derive(Debug, thiserror::Error)]
pub enum VscodeCliError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Http(#[from] reqwest::Error),
    #[error("{0}")]
    Archive(String),
    #[error("{0}")]
    Spawn(String),
    #[error("timed out waiting for VS Code CLI")]
    StartupTimeout,
    #[error("{0}")]
    UnsupportedPlatform(String),
    #[error("{0}")]
    InvalidVersion(String),
    #[error("VS Code CLI is not installed")]
    NotInstalled,
}

#[cfg(test)]
mod tests;
