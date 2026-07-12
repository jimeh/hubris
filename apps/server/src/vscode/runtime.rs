use std::fmt;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use flate2::read::GzDecoder;
use futures_util::TryStreamExt;
use futures_util::future::BoxFuture;
use semver::Version;
use tar::Archive;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::{Mutex, Notify};
use uuid::Uuid;

use super::{
    CodeServerInstallPhaseValue, CodeServerProcessStatusValue, ManagerCodeServerInstallProgress,
    ManagerCodeServerLatestCheck, StatusCallback,
};
use crate::events::EventBus;
use crate::process_manager::{
    ManagedChildProcess, ManagedProcessActionError, ManagedProcessController, ManagedProcessHandle,
    ManagedProcessLifecycleState, ManagedProcessRuntime, ManagedProcessService,
    ManagedProcessStatusSnapshot, ManagedProcessStopTarget, now_timestamp_string,
};
use crate::task_manager::{TaskExecutionError, TaskStateValue, TaskStepContext, TaskStepResult};

pub(super) const DEFAULT_HOST: &str = "127.0.0.1";
pub(super) const READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
pub(super) const READY_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(150);
pub(super) const RUNTIMES_DIR: &str = "runtimes";
pub(super) const TMP_DIR: &str = "tmp";

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArchiveFormat {
    TarGz,
    Zip,
}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Http(#[from] reqwest::Error),
    #[error("{0}")]
    Archive(String),
    #[error("{0}")]
    Spawn(String),
    #[error("{0}")]
    StartupTimeout(&'static str),
    #[error("{0}")]
    UnsupportedPlatform(String),
    #[error("{0}")]
    InvalidVersion(String),
    #[error("{0}")]
    NotInstalled(&'static str),
}

pub struct LaunchConfig<C> {
    pub command: Command,
    pub connection: C,
    pub binary_path: PathBuf,
}

pub trait RuntimeSpec: Clone + Send + Sync + 'static {
    type Platform: Copy + fmt::Debug + Send + Sync + 'static;
    type Connection: Clone + fmt::Debug + Send + Sync + 'static;
    type Error: From<RuntimeError> + fmt::Debug + fmt::Display + Send + Sync + 'static;
    type LaunchRequest: Clone + fmt::Debug + Send + Sync + 'static;
    type Status: Send + 'static;

    const PROCESS_ID: &'static str;
    const PROCESS_KIND: &'static str;
    const CLIENT_LABEL: &'static str;
    const LAUNCH_LABEL: &'static str;
    const INSTALL_CONFLICT_MESSAGE: &'static str;
    const EXIT_MESSAGE: &'static str;

    fn detect_platform() -> Result<Self::Platform, RuntimeError>;
    fn normalize_version(raw: &str) -> Result<String, RuntimeError>;
    fn runtime_dir_name(version: &str, platform: Self::Platform) -> String;
    fn archive_format(platform: Self::Platform) -> ArchiveFormat;
    fn archive_extension(platform: Self::Platform) -> &'static str {
        match Self::archive_format(platform) {
            ArchiveFormat::TarGz => "tar.gz",
            ArchiveFormat::Zip => "zip",
        }
    }
    fn archive_url(version: &str, platform: Self::Platform) -> String;
    fn download_client() -> Result<reqwest::Client, RuntimeError>;
    fn binary_path(runtime_dir: &Path, platform: Self::Platform) -> Option<PathBuf>;
    fn locate_extracted_root(
        extract_dir: &Path,
        dir_name: &str,
        platform: Self::Platform,
    ) -> Option<PathBuf>;
    fn missing_extracted_binary(extract_dir: &Path, dir_name: &str) -> String;
    fn missing_installed_binary(runtime_dir: &Path) -> String;
    fn platform_suffix(platform: Self::Platform) -> String;
    fn runtime_prefix() -> &'static str;

    fn fetch_latest(client: reqwest::Client) -> BoxFuture<'static, Result<String, Self::Error>>;
    fn update_available(installed: &InstalledRuntime<Self>, latest: &str) -> bool;
    fn build_launch_request(
        root_dir: &Path,
        runtime: &InstalledRuntime<Self>,
    ) -> Self::LaunchRequest;
    fn prepare_launch(
        request: Self::LaunchRequest,
    ) -> BoxFuture<'static, Result<LaunchConfig<Self::Connection>, RuntimeError>>;
    fn wait_until_ready(
        connection: Self::Connection,
    ) -> BoxFuture<'static, Result<(), RuntimeError>>;
    fn status(common: RuntimeStatusSnapshot) -> Self::Status;
}

#[derive(Clone, Debug)]
pub struct InstalledRuntime<S: RuntimeSpec> {
    pub version: String,
    pub version_semver: Version,
    pub platform: S::Platform,
    pub runtime_dir: PathBuf,
    pub binary_path: PathBuf,
}

#[derive(Clone)]
pub struct RuntimeDownloadRequest<S: RuntimeSpec> {
    pub root_dir: PathBuf,
    pub version: String,
    pub platform: S::Platform,
    pub force: bool,
    pub install_progress: Option<InstallProgressFn>,
}

#[derive(Clone, Debug)]
struct RuntimeInstallPlan<S: RuntimeSpec> {
    version: String,
    platform: S::Platform,
    force: bool,
}

#[derive(Debug)]
struct RuntimeInstallTaskState<S: RuntimeSpec> {
    backup_runtime_dir: Option<PathBuf>,
    target_runtime_dir: Option<PathBuf>,
    installed_runtime: Option<InstalledRuntime<S>>,
    restart_previous_runtime: bool,
}

impl<S: RuntimeSpec> Default for RuntimeInstallTaskState<S> {
    fn default() -> Self {
        Self {
            backup_runtime_dir: None,
            target_runtime_dir: None,
            installed_runtime: None,
            restart_previous_runtime: false,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) enum RuntimeState<C> {
    Idle,
    Installing,
    Ready(C),
}

impl<C: Clone> RuntimeState<C> {
    fn is_installing(&self) -> bool {
        matches!(self, Self::Installing)
    }

    fn connection(&self) -> Option<C> {
        match self {
            Self::Ready(connection) => Some(connection.clone()),
            Self::Idle | Self::Installing => None,
        }
    }

    fn clear_ready(&mut self) {
        if matches!(self, Self::Ready(_)) {
            *self = Self::Idle;
        }
    }
}

#[derive(Debug)]
pub(super) struct RuntimeManagerState<S: RuntimeSpec> {
    pub latest: Option<ManagerCodeServerLatestCheck>,
    pub install_progress: Option<ManagerCodeServerInstallProgress>,
    pub runtime: RuntimeState<S::Connection>,
}

#[derive(Debug)]
pub(super) struct RunningRuntime<S: RuntimeSpec> {
    pub connection: S::Connection,
    pub process: ManagedProcessRuntime,
}

pub(super) type FetchLatestFn<S> =
    Arc<dyn Fn() -> BoxFuture<'static, Result<String, <S as RuntimeSpec>::Error>> + Send + Sync>;
pub(super) type DownloadRuntimeFn<S> = Arc<
    dyn Fn(
            RuntimeDownloadRequest<S>,
        ) -> BoxFuture<'static, Result<InstalledRuntime<S>, <S as RuntimeSpec>::Error>>
        + Send
        + Sync,
>;
pub(super) type InstallProgressFn =
    Arc<dyn Fn(ManagerCodeServerInstallProgress) -> BoxFuture<'static, ()> + Send + Sync>;
pub(super) type LaunchFn<S> = Arc<
    dyn Fn(
            <S as RuntimeSpec>::LaunchRequest,
        ) -> BoxFuture<'static, Result<RunningRuntime<S>, <S as RuntimeSpec>::Error>>
        + Send
        + Sync,
>;

#[derive(Clone, Debug)]
pub struct RuntimeStatusSnapshot {
    pub supported: bool,
    pub installed_version: Option<String>,
    pub process_status: CodeServerProcessStatusValue,
    pub latest: Option<ManagerCodeServerLatestCheck>,
    pub install_progress: Option<ManagerCodeServerInstallProgress>,
    pub message: Option<String>,
}

#[derive(Clone)]
pub struct RuntimeManager<S: RuntimeSpec> {
    pub(super) inner: Arc<Mutex<RuntimeManagerState<S>>>,
    pub(super) notify: Arc<Notify>,
    pub(super) client: reqwest::Client,
    pub(super) status_callback: Arc<Mutex<Option<StatusCallback>>>,
    pub(super) fetch_latest: FetchLatestFn<S>,
    pub(super) download_runtime: DownloadRuntimeFn<S>,
    pub(super) launch: LaunchFn<S>,
    pub(super) root_dir: PathBuf,
    pub(super) process_handle: ManagedProcessHandle,
    spec: PhantomData<S>,
}

impl<S: RuntimeSpec> fmt::Debug for RuntimeManager<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct(S::PROCESS_KIND)
            .field("root_dir", &self.root_dir)
            .finish_non_exhaustive()
    }
}

impl<S: RuntimeSpec> RuntimeManager<S> {
    pub fn new(
        root_dir: PathBuf,
        _events: Arc<EventBus>,
        processes: Arc<ManagedProcessService>,
    ) -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|error| panic!("failed to build {} client: {error}", S::CLIENT_LABEL));
        let fetch_client = client.clone();
        let fetch_latest: FetchLatestFn<S> =
            Arc::new(move || S::fetch_latest(fetch_client.clone()));
        let download_runtime: DownloadRuntimeFn<S> = Arc::new(move |request| {
            Box::pin(async move { download_runtime::<S>(request).await.map_err(Into::into) })
        });
        let launch: LaunchFn<S> = Arc::new(move |request| {
            Box::pin(async move { launch_runtime::<S>(request).await.map_err(Into::into) })
        });

        Self::from_parts(
            root_dir,
            client,
            fetch_latest,
            download_runtime,
            launch,
            processes.register_process(S::PROCESS_ID, S::PROCESS_KIND),
        )
    }

    #[cfg(test)]
    pub(super) fn with_hooks(
        root_dir: PathBuf,
        fetch_latest: FetchLatestFn<S>,
        download_runtime: DownloadRuntimeFn<S>,
        launch: LaunchFn<S>,
    ) -> Self {
        let events = Arc::new(EventBus::new());
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|error| panic!("failed to build {} client: {error}", S::CLIENT_LABEL));
        Self::from_parts(
            root_dir,
            client,
            fetch_latest,
            download_runtime,
            launch,
            ManagedProcessService::new(events).register_process(S::PROCESS_ID, S::PROCESS_KIND),
        )
    }

    fn from_parts(
        root_dir: PathBuf,
        client: reqwest::Client,
        fetch_latest: FetchLatestFn<S>,
        download_runtime: DownloadRuntimeFn<S>,
        launch: LaunchFn<S>,
        process_handle: ManagedProcessHandle,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(RuntimeManagerState {
                latest: None,
                install_progress: None,
                runtime: RuntimeState::Idle,
            })),
            notify: Arc::new(Notify::new()),
            client,
            status_callback: Arc::new(Mutex::new(None)),
            fetch_latest,
            download_runtime,
            launch,
            root_dir,
            process_handle,
            spec: PhantomData,
        }
    }

    pub async fn set_status_callback(&self, callback: StatusCallback) {
        *self.status_callback.lock().await = Some(callback);
    }

    pub fn http_client(&self) -> &reqwest::Client {
        &self.client
    }

    pub async fn register_process_callback(self: Arc<Self>) {
        let weak = Arc::downgrade(&self);
        self.process_handle
            .set_on_change(Arc::new(move |snapshot| {
                let weak = weak.clone();
                Box::pin(async move {
                    if let Some(manager) = weak.upgrade() {
                        manager.apply_process_snapshot(&snapshot).await;
                        manager.notify.notify_waiters();
                        manager.publish_status_update().await;
                    }
                })
            }))
            .await;
    }

    async fn apply_process_snapshot(&self, snapshot: &ManagedProcessStatusSnapshot) {
        if snapshot.lifecycle_state == ManagedProcessLifecycleState::Running {
            return;
        }
        self.inner.lock().await.runtime.clear_ready();
    }

    pub async fn status(&self) -> S::Status {
        let supported = S::detect_platform().is_ok();
        let installed = self.find_installed_runtime().await.ok().flatten();
        let process = self.process_handle.status().await.ok();
        let state = self.inner.lock().await;
        let (process_status, mut message) = if state.runtime.is_installing() {
            (CodeServerProcessStatusValue::Installing, None)
        } else {
            match process.as_ref().map(|status| status.lifecycle_state) {
                Some(ManagedProcessLifecycleState::Running) => {
                    (CodeServerProcessStatusValue::Running, None)
                }
                Some(ManagedProcessLifecycleState::Starting) => {
                    (CodeServerProcessStatusValue::Starting, None)
                }
                Some(ManagedProcessLifecycleState::Stopping) => {
                    (CodeServerProcessStatusValue::Stopping, None)
                }
                Some(ManagedProcessLifecycleState::Stopped) | None => {
                    (CodeServerProcessStatusValue::Stopped, None)
                }
                Some(ManagedProcessLifecycleState::Exited) => (
                    CodeServerProcessStatusValue::Error,
                    Some(S::EXIT_MESSAGE.to_string()),
                ),
                Some(ManagedProcessLifecycleState::Error) => (
                    CodeServerProcessStatusValue::Error,
                    process
                        .as_ref()
                        .and_then(|status| status.last_error.clone()),
                ),
            }
        };
        if message.is_none() {
            if let Err(error) = S::detect_platform() {
                message = Some(error.to_string());
            } else if process
                .as_ref()
                .and_then(|status| status.last_exit.as_ref())
                .is_some()
                && process_status == CodeServerProcessStatusValue::Error
            {
                message = Some(S::EXIT_MESSAGE.to_string());
            }
        }
        S::status(RuntimeStatusSnapshot {
            supported,
            installed_version: installed.map(|runtime| runtime.version),
            process_status,
            latest: state.latest.clone(),
            install_progress: state.install_progress.clone(),
            message,
        })
    }

    pub async fn check_for_update(&self) -> Result<S::Status, S::Error> {
        let latest = (self.fetch_latest)().await?;
        let installed = self.find_installed_runtime().await?;
        let update_available = installed
            .as_ref()
            .is_some_and(|runtime| S::update_available(runtime, &latest));
        self.inner.lock().await.latest = Some(ManagerCodeServerLatestCheck {
            latest_version: Some(latest),
            update_available,
            checked_at: Some(now_timestamp_string()),
        });
        self.publish_status_update().await;
        Ok(self.status().await)
    }

    pub async fn start(&self) -> Result<S::Status, S::Error> {
        self.ensure_ready().await?;
        Ok(self.status().await)
    }

    pub async fn stop(&self) -> Result<S::Status, S::Error> {
        self.stop_managed_process().await?;
        Ok(self.status().await)
    }

    pub async fn restart(&self) -> Result<S::Status, S::Error> {
        self.stop().await?;
        self.start().await
    }

    pub async fn shutdown(&self) -> Result<(), S::Error> {
        self.stop_managed_process().await
    }

    pub async fn ensure_ready(&self) -> Result<S::Connection, S::Error> {
        loop {
            let process = self
                .process_handle
                .status()
                .await
                .map_err(map_managed_process_error::<S>)?;
            let state = self.inner.lock().await;
            if state.runtime.is_installing() {
                let notified = self.notify.notified();
                drop(state);
                notified.await;
                continue;
            }
            if process.lifecycle_state == ManagedProcessLifecycleState::Running {
                if let Some(connection) = state.runtime.connection() {
                    return Ok(connection);
                }
                let notified = self.notify.notified();
                drop(state);
                notified.await;
                continue;
            }
            if matches!(
                process.lifecycle_state,
                ManagedProcessLifecycleState::Starting | ManagedProcessLifecycleState::Stopping
            ) {
                let notified = self.notify.notified();
                drop(state);
                notified.await;
                continue;
            }
            drop(state);
            return self.start_managed_process().await;
        }
    }

    async fn find_installed_runtime(&self) -> Result<Option<InstalledRuntime<S>>, S::Error> {
        let root_dir = self.root_dir.clone();
        let platform = S::detect_platform().map_err(S::Error::from)?;
        tokio::task::spawn_blocking(move || find_installed_runtime_sync::<S>(root_dir, platform))
            .await
            .map_err(|error| S::Error::from(RuntimeError::Spawn(error.to_string())))?
            .map_err(Into::into)
    }

    fn task_install_progress_callback(&self, step: TaskStepContext) -> InstallProgressFn {
        let manager = self.clone();
        Arc::new(move |progress| {
            let manager = manager.clone();
            let step = step.clone();
            Box::pin(async move {
                manager.set_install_progress(progress.clone()).await;
                step.set_step_progress(progress.percent).await;
            })
        })
    }

    async fn set_install_progress(&self, progress: ManagerCodeServerInstallProgress) {
        let should_emit = {
            let mut state = self.inner.lock().await;
            if state.install_progress.as_ref() == Some(&progress) {
                false
            } else {
                state.install_progress = Some(progress);
                true
            }
        };
        if should_emit {
            self.notify.notify_waiters();
            self.publish_status_update().await;
        }
    }

    async fn publish_status_update(&self) {
        if let Some(callback) = self.status_callback.lock().await.clone() {
            callback().await;
        }
    }

    async fn prepare_install_plan(
        &self,
        requested_version: Option<String>,
        force: bool,
    ) -> Result<RuntimeInstallPlan<S>, S::Error> {
        let platform = S::detect_platform().map_err(S::Error::from)?;
        let version = match requested_version {
            Some(version) => S::normalize_version(&version).map_err(S::Error::from)?,
            None if force => match self.find_installed_runtime().await? {
                Some(installed) => installed.version,
                None => (self.fetch_latest)().await?,
            },
            None => (self.fetch_latest)().await?,
        };
        Ok(RuntimeInstallPlan {
            version,
            platform,
            force,
        })
    }

    async fn start_managed_process(&self) -> Result<S::Connection, S::Error> {
        let runtime = self
            .find_installed_runtime()
            .await?
            .ok_or_else(|| S::Error::from(RuntimeError::NotInstalled(S::PROCESS_KIND)))?;
        loop {
            if let Some(status) = self
                .process_handle
                .begin_start()
                .await
                .map_err(map_managed_process_error::<S>)?
            {
                let state = self.inner.lock().await;
                if let Some(connection) = state.runtime.connection() {
                    return Ok(connection);
                }
                if status.lifecycle_state == ManagedProcessLifecycleState::Running {
                    let notified = self.notify.notified();
                    drop(state);
                    notified.await;
                    continue;
                }
            }
            break;
        }
        match (self.launch)(S::build_launch_request(&self.root_dir, &runtime)).await {
            Ok(server) => {
                let connection = server.connection.clone();
                self.process_handle.finish_running(server.process).await;
                {
                    let mut state = self.inner.lock().await;
                    state.install_progress = None;
                    state.runtime = RuntimeState::Ready(connection.clone());
                }
                self.notify.notify_waiters();
                self.publish_status_update().await;
                Ok(connection)
            }
            Err(error) => {
                self.process_handle.finish_error(error.to_string()).await;
                {
                    let mut state = self.inner.lock().await;
                    state.install_progress = None;
                    state.runtime = RuntimeState::Idle;
                }
                self.notify.notify_waiters();
                self.publish_status_update().await;
                Err(error)
            }
        }
    }

    async fn stop_managed_process(&self) -> Result<(), S::Error> {
        self.stop_managed_process_inner(true).await.map(|_| ())
    }

    pub(super) async fn stop_managed_process_for_install(&self) -> Result<bool, S::Error> {
        self.stop_managed_process_inner(false).await
    }

    async fn stop_managed_process_inner(&self, wait_for_install: bool) -> Result<bool, S::Error> {
        loop {
            let state = self.inner.lock().await;
            if wait_for_install && state.runtime.is_installing() {
                let notified = self.notify.notified();
                drop(state);
                notified.await;
                continue;
            }
            drop(state);
            break;
        }
        let had_running = match self
            .process_handle
            .begin_stop()
            .await
            .map_err(map_managed_process_error::<S>)?
        {
            ManagedProcessStopTarget::Running(mut runtime) => {
                if let Err(error) = runtime
                    .shutdown()
                    .await
                    .map_err(map_managed_process_error::<S>)
                {
                    self.process_handle.finish_error(error.to_string()).await;
                    return Err(error);
                }
                true
            }
            ManagedProcessStopTarget::NotRunning => false,
        };
        {
            let mut state = self.inner.lock().await;
            state.install_progress = None;
            if wait_for_install || !state.runtime.is_installing() {
                state.runtime = RuntimeState::Idle;
            }
        }
        self.notify.notify_waiters();
        self.process_handle.finish_stopped().await;
        Ok(had_running)
    }
}

fn map_managed_process_error<S: RuntimeSpec>(error: ManagedProcessActionError) -> S::Error {
    RuntimeError::Spawn(error.to_string()).into()
}

impl<S: RuntimeSpec> ManagedProcessController for RuntimeManager<S> {
    fn id(&self) -> &str {
        self.process_handle.id()
    }

    fn kind(&self) -> &str {
        self.process_handle.kind()
    }

    fn start(
        &self,
    ) -> BoxFuture<'_, Result<ManagedProcessStatusSnapshot, ManagedProcessActionError>> {
        Box::pin(async move {
            self.start_managed_process()
                .await
                .map_err(|error| ManagedProcessActionError::internal(error.to_string()))?;
            self.process_handle.status().await
        })
    }

    fn stop(
        &self,
    ) -> BoxFuture<'_, Result<ManagedProcessStatusSnapshot, ManagedProcessActionError>> {
        Box::pin(async move {
            self.stop_managed_process()
                .await
                .map_err(|error| ManagedProcessActionError::internal(error.to_string()))?;
            self.process_handle.status().await
        })
    }

    fn restart(
        &self,
    ) -> BoxFuture<'_, Result<ManagedProcessStatusSnapshot, ManagedProcessActionError>> {
        Box::pin(async move {
            self.stop_managed_process()
                .await
                .map_err(|error| ManagedProcessActionError::internal(error.to_string()))?;
            self.start_managed_process()
                .await
                .map_err(|error| ManagedProcessActionError::internal(error.to_string()))?;
            self.process_handle.status().await
        })
    }
}

pub(super) struct RuntimeInstallState<S: RuntimeSpec> {
    manager: Arc<RuntimeManager<S>>,
    plan: RuntimeInstallPlan<S>,
    rollback_state: Arc<Mutex<RuntimeInstallTaskState<S>>>,
}

impl<S: RuntimeSpec> RuntimeInstallState<S> {
    pub(super) async fn initialize(
        manager: Arc<RuntimeManager<S>>,
        requested_version: Option<String>,
        force: bool,
    ) -> Result<Self, TaskExecutionError> {
        loop {
            let process = manager
                .process_handle
                .status()
                .await
                .map_err(map_managed_process_error::<S>)
                .map_err(|error| TaskExecutionError::new(error.to_string()))?;
            let state = manager.inner.lock().await;
            if state.runtime.is_installing() {
                return Err(TaskExecutionError::new(S::INSTALL_CONFLICT_MESSAGE));
            }
            if matches!(
                process.lifecycle_state,
                ManagedProcessLifecycleState::Starting | ManagedProcessLifecycleState::Stopping
            ) {
                let notified = manager.notify.notified();
                drop(state);
                notified.await;
                continue;
            }
            drop(state);
            break;
        }
        let plan = manager
            .prepare_install_plan(requested_version, force)
            .await
            .map_err(|error| TaskExecutionError::new(error.to_string()))?;
        let rollback_state = Arc::new(Mutex::new(RuntimeInstallTaskState {
            target_runtime_dir: Some(
                manager
                    .root_dir
                    .join(RUNTIMES_DIR)
                    .join(S::runtime_dir_name(&plan.version, plan.platform)),
            ),
            ..Default::default()
        }));
        {
            let mut state = manager.inner.lock().await;
            state.runtime = RuntimeState::Installing;
            state.install_progress = Some(preparing_install_progress());
        }
        manager.notify.notify_waiters();
        manager.publish_status_update().await;
        Ok(Self {
            manager,
            plan,
            rollback_state,
        })
    }

    pub(super) async fn stop_runtime(
        &mut self,
        context: TaskStepContext,
    ) -> Result<TaskStepResult, TaskExecutionError> {
        context.set_status_text("Stopping current runtime").await;
        let had_running = self
            .manager
            .stop_managed_process_for_install()
            .await
            .map_err(|error| TaskExecutionError::new(error.to_string()))?;
        self.rollback_state.lock().await.restart_previous_runtime = had_running;
        if had_running {
            context.set_step_progress(100).await;
            Ok(TaskStepResult::Completed)
        } else {
            Ok(TaskStepResult::Skipped)
        }
    }

    pub(super) async fn download_runtime(
        &mut self,
        context: TaskStepContext,
    ) -> Result<TaskStepResult, TaskExecutionError> {
        let plan = self.plan.clone();
        context.set_status_text("Downloading runtime").await;
        let target_runtime_dir = self
            .manager
            .root_dir
            .join(RUNTIMES_DIR)
            .join(S::runtime_dir_name(&plan.version, plan.platform));
        if plan.force
            && tokio::fs::try_exists(&target_runtime_dir)
                .await
                .map_err(|error| TaskExecutionError::new(error.to_string()))?
        {
            let backup_runtime_dir = self.manager.root_dir.join(TMP_DIR).join(format!(
                "{}-rollback-{}",
                S::runtime_dir_name(&plan.version, plan.platform),
                Uuid::new_v4()
            ));
            tokio::fs::create_dir_all(self.manager.root_dir.join(TMP_DIR))
                .await
                .map_err(|error| TaskExecutionError::new(error.to_string()))?;
            tokio::fs::rename(&target_runtime_dir, &backup_runtime_dir)
                .await
                .map_err(|error| TaskExecutionError::new(error.to_string()))?;
            self.rollback_state.lock().await.backup_runtime_dir = Some(backup_runtime_dir);
        }
        let runtime = (self.manager.download_runtime)(RuntimeDownloadRequest {
            root_dir: self.manager.root_dir.clone(),
            version: plan.version.clone(),
            platform: plan.platform,
            force: plan.force,
            install_progress: Some(self.manager.task_install_progress_callback(context.clone())),
        })
        .await
        .map_err(|error| TaskExecutionError::new(error.to_string()))?;
        self.rollback_state.lock().await.installed_runtime = Some(runtime);
        context.set_step_progress(100).await;
        Ok(TaskStepResult::Completed)
    }

    pub(super) async fn start_runtime(
        &mut self,
        context: TaskStepContext,
    ) -> Result<TaskStepResult, TaskExecutionError> {
        self.manager
            .set_install_progress(ManagerCodeServerInstallProgress {
                phase: CodeServerInstallPhaseValue::Starting,
                percent: 95,
                downloaded_bytes: None,
                total_bytes: None,
            })
            .await;
        context.set_status_text("Starting runtime").await;
        let runtime = self
            .rollback_state
            .lock()
            .await
            .installed_runtime
            .clone()
            .ok_or_else(|| TaskExecutionError::new("missing installed runtime"))?;
        let server =
            (self.manager.launch)(S::build_launch_request(&self.manager.root_dir, &runtime))
                .await
                .map_err(|error| TaskExecutionError::new(error.to_string()))?;
        self.manager
            .process_handle
            .finish_running(server.process)
            .await;
        self.manager.inner.lock().await.runtime = RuntimeState::Ready(server.connection);
        self.manager.notify.notify_waiters();
        self.manager.publish_status_update().await;
        context.set_step_progress(100).await;
        Ok(TaskStepResult::Completed)
    }

    pub(super) async fn cleanup_runtimes(
        &mut self,
        context: TaskStepContext,
    ) -> Result<TaskStepResult, TaskExecutionError> {
        self.manager
            .set_install_progress(ManagerCodeServerInstallProgress {
                phase: CodeServerInstallPhaseValue::Cleaning,
                percent: 90,
                downloaded_bytes: None,
                total_bytes: None,
            })
            .await;
        context.set_status_text("Cleaning old runtimes").await;
        let runtime = self
            .rollback_state
            .lock()
            .await
            .installed_runtime
            .clone()
            .ok_or_else(|| TaskExecutionError::new("missing installed runtime"))?;
        cleanup_other_runtimes::<S>(
            self.manager.root_dir.clone(),
            runtime.platform,
            &runtime.runtime_dir,
        )
        .await
        .map_err(|error| TaskExecutionError::new(error.to_string()))?;
        context.set_step_progress(100).await;
        Ok(TaskStepResult::Completed)
    }

    pub(super) async fn rollback_stop_runtime(
        &mut self,
        context: TaskStepContext,
    ) -> Result<(), TaskExecutionError> {
        if self.rollback_state.lock().await.restart_previous_runtime {
            context.set_status_text("Restarting previous runtime").await;
            self.manager
                .start_managed_process()
                .await
                .map_err(|error| TaskExecutionError::new(error.to_string()))?;
        }
        context.set_step_progress(100).await;
        Ok(())
    }

    pub(super) async fn rollback_download_runtime(
        &mut self,
        context: TaskStepContext,
    ) -> Result<(), TaskExecutionError> {
        context.set_status_text("Restoring previous runtime").await;
        let mut state = self.rollback_state.lock().await;
        if let Some(runtime) = state.installed_runtime.take() {
            let _ = tokio::fs::remove_dir_all(&runtime.runtime_dir).await;
        }
        if let (Some(backup_runtime_dir), Some(target_runtime_dir)) = (
            state.backup_runtime_dir.take(),
            state.target_runtime_dir.clone(),
        ) && tokio::fs::try_exists(&backup_runtime_dir)
            .await
            .map_err(|error| TaskExecutionError::new(error.to_string()))?
        {
            tokio::fs::rename(&backup_runtime_dir, &target_runtime_dir)
                .await
                .map_err(|error| TaskExecutionError::new(error.to_string()))?;
        }
        context.set_step_progress(100).await;
        Ok(())
    }

    pub(super) async fn rollback_start_runtime(
        &mut self,
        context: TaskStepContext,
    ) -> Result<(), TaskExecutionError> {
        context.set_status_text("Stopping failed runtime").await;
        self.manager
            .stop_managed_process_for_install()
            .await
            .map_err(|error| TaskExecutionError::new(error.to_string()))?;
        context.set_step_progress(100).await;
        Ok(())
    }

    pub(super) async fn finalize(&mut self, _final_status: TaskStateValue) {
        let mut state = self.manager.inner.lock().await;
        state.install_progress = None;
        if state.runtime.is_installing() {
            state.runtime = RuntimeState::Idle;
        }
        drop(state);
        self.manager.notify.notify_waiters();
        self.manager.publish_status_update().await;
    }
}

pub(super) async fn download_runtime<S: RuntimeSpec>(
    request: RuntimeDownloadRequest<S>,
) -> Result<InstalledRuntime<S>, RuntimeError> {
    let version = S::normalize_version(&request.version)?;
    let asset_url = S::archive_url(&version, request.platform);
    let client = S::download_client()?;
    download_runtime_from_url::<S>(request, version, asset_url, client).await
}

pub(super) async fn download_runtime_from_url<S: RuntimeSpec>(
    request: RuntimeDownloadRequest<S>,
    version: String,
    asset_url: String,
    client: reqwest::Client,
) -> Result<InstalledRuntime<S>, RuntimeError> {
    let dir_name = S::runtime_dir_name(&version, request.platform);
    let runtime_dir = request.root_dir.join(RUNTIMES_DIR).join(&dir_name);
    if let Some(binary_path) = S::binary_path(&runtime_dir, request.platform)
        && !request.force
    {
        return installed_runtime::<S>(version, request.platform, runtime_dir, binary_path);
    }
    if tokio::fs::try_exists(&runtime_dir).await? {
        tokio::fs::remove_dir_all(&runtime_dir).await?;
    }
    tokio::fs::create_dir_all(request.root_dir.join(RUNTIMES_DIR)).await?;
    tokio::fs::create_dir_all(request.root_dir.join(TMP_DIR)).await?;
    let archive_path = request.root_dir.join(TMP_DIR).join(format!(
        "{dir_name}-{}.{}",
        Uuid::new_v4(),
        S::archive_extension(request.platform)
    ));
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
        Ok::<(), RuntimeError>(())
    }
    .await;
    if let Err(error) = download {
        let _ = tokio::fs::remove_file(&archive_path).await;
        return Err(error);
    }
    let archive_path_for_extract = archive_path.clone();
    let extract_dir_for_extract = extract_dir.clone();
    let dir_name_for_extract = dir_name.clone();
    let archive_format = S::archive_format(request.platform);
    let platform = request.platform;
    let extracted_root = tokio::task::spawn_blocking(move || {
        extract_archive(
            &archive_path_for_extract,
            &extract_dir_for_extract,
            archive_format,
        )?;
        S::locate_extracted_root(&extract_dir_for_extract, &dir_name_for_extract, platform)
            .ok_or_else(|| {
                RuntimeError::Archive(S::missing_extracted_binary(
                    &extract_dir_for_extract,
                    &dir_name_for_extract,
                ))
            })
    })
    .await
    .map_err(|error| RuntimeError::Spawn(error.to_string()))??;
    if tokio::fs::try_exists(&runtime_dir).await? {
        tokio::fs::remove_dir_all(&runtime_dir).await?;
    }
    tokio::fs::create_dir_all(request.root_dir.join(RUNTIMES_DIR)).await?;
    tokio::fs::rename(&extracted_root, &runtime_dir).await?;
    let _ = tokio::fs::remove_file(&archive_path).await;
    if extracted_root != extract_dir {
        let _ = tokio::fs::remove_dir_all(&extract_dir).await;
    }
    let binary_path = S::binary_path(&runtime_dir, request.platform)
        .ok_or_else(|| RuntimeError::Archive(S::missing_installed_binary(&runtime_dir)))?;
    installed_runtime::<S>(version, request.platform, runtime_dir, binary_path)
}

fn installed_runtime<S: RuntimeSpec>(
    version: String,
    platform: S::Platform,
    runtime_dir: PathBuf,
    binary_path: PathBuf,
) -> Result<InstalledRuntime<S>, RuntimeError> {
    let version_semver = Version::parse(&version)
        .map_err(|_| RuntimeError::InvalidVersion(format!("invalid version: {version}")))?;
    Ok(InstalledRuntime {
        version,
        version_semver,
        platform,
        runtime_dir,
        binary_path,
    })
}

fn extract_archive(
    archive_path: &Path,
    extract_dir: &Path,
    archive_format: ArchiveFormat,
) -> Result<(), RuntimeError> {
    std::fs::create_dir_all(extract_dir)?;
    let file = std::fs::File::open(archive_path)?;
    match archive_format {
        ArchiveFormat::TarGz => Archive::new(GzDecoder::new(file))
            .unpack(extract_dir)
            .map_err(|error| RuntimeError::Archive(error.to_string())),
        ArchiveFormat::Zip => zip::ZipArchive::new(file)
            .map_err(|error| RuntimeError::Archive(error.to_string()))?
            .extract(extract_dir)
            .map_err(|error| RuntimeError::Archive(error.to_string())),
    }
}

pub(super) async fn cleanup_other_runtimes<S: RuntimeSpec>(
    root_dir: PathBuf,
    platform: S::Platform,
    keep_runtime_dir: &Path,
) -> Result<(), RuntimeError> {
    let keep_runtime_dir = keep_runtime_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let runtimes_dir = root_dir.join(RUNTIMES_DIR);
        let entries = match std::fs::read_dir(&runtimes_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(());
            }
            Err(error) => return Err(RuntimeError::Io(error)),
        };
        let suffix = S::platform_suffix(platform);
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if path == keep_runtime_dir || !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if name.starts_with(S::runtime_prefix()) && name.ends_with(&suffix) {
                std::fs::remove_dir_all(path)?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| RuntimeError::Spawn(error.to_string()))?
}

fn find_installed_runtime_sync<S: RuntimeSpec>(
    root_dir: PathBuf,
    platform: S::Platform,
) -> Result<Option<InstalledRuntime<S>>, RuntimeError> {
    let runtimes_dir = root_dir.join(RUNTIMES_DIR);
    let entries = match std::fs::read_dir(&runtimes_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None);
        }
        Err(error) => return Err(RuntimeError::Io(error)),
    };
    let suffix = S::platform_suffix(platform);
    let mut best: Option<InstalledRuntime<S>> = None;
    for entry in entries {
        let entry = entry?;
        let runtime_dir = entry.path();
        if !runtime_dir.is_dir() {
            continue;
        }
        let Some(name) = runtime_dir.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(rest) = name.strip_prefix(S::runtime_prefix()) else {
            continue;
        };
        let Some(version) = rest.strip_suffix(&suffix) else {
            continue;
        };
        let Ok(version_semver) = Version::parse(version) else {
            continue;
        };
        let Some(binary_path) = S::binary_path(&runtime_dir, platform) else {
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

async fn launch_runtime<S: RuntimeSpec>(
    request: S::LaunchRequest,
) -> Result<RunningRuntime<S>, RuntimeError> {
    let LaunchConfig {
        mut command,
        connection,
        binary_path,
    } = S::prepare_launch(request).await?;
    let mut child = command.spawn().map_err(|error| {
        RuntimeError::Spawn(format!(
            "failed to launch {} binary {}: {error}",
            S::LAUNCH_LABEL,
            binary_path.display()
        ))
    })?;
    if let Err(error) = S::wait_until_ready(connection.clone()).await {
        let _ = child.kill().await;
        return Err(error);
    }
    Ok(RunningRuntime {
        connection,
        process: ManagedProcessRuntime::Child(ManagedChildProcess::new(child)),
    })
}

pub(super) fn pick_unused_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind((DEFAULT_HOST, 0))?;
    Ok(listener.local_addr()?.port())
}
