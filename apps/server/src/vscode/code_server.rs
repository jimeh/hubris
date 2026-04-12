use super::*;
use crate::task_manager::{TaskExecutionError, TaskStateValue, TaskStepContext, TaskStepResult};

pub(super) struct CodeServerInstallState {
    manager: Arc<CodeServerManager>,
    requested_version: Option<String>,
    force: bool,
    initialized: bool,
    plan: Option<CodeServerInstallPlan>,
    rollback_state: Arc<Mutex<CodeServerInstallTaskState>>,
}

impl CodeServerInstallState {
    pub(super) fn new(
        manager: Arc<CodeServerManager>,
        requested_version: Option<String>,
        force: bool,
    ) -> Self {
        Self {
            manager,
            requested_version,
            force,
            initialized: false,
            plan: None,
            rollback_state: Arc::new(Mutex::new(CodeServerInstallTaskState::default())),
        }
    }

    async fn ensure_initialized(&mut self) -> Result<(), TaskExecutionError> {
        if self.initialized {
            return Ok(());
        }

        loop {
            let process = self
                .manager
                .process_handle
                .status()
                .await
                .map_err(map_managed_process_error)
                .map_err(|error| TaskExecutionError::new(error.to_string()))?;
            let state = self.manager.inner.lock().await;

            if state.runtime.is_installing() {
                return Err(TaskExecutionError::new(
                    "code-server install is already running",
                ));
            }

            if matches!(
                process.lifecycle_state,
                ManagedProcessLifecycleState::Starting | ManagedProcessLifecycleState::Stopping
            ) {
                let notified = self.manager.notify.notified();
                drop(state);
                notified.await;
                continue;
            }

            drop(state);
            break;
        }

        let plan = self
            .manager
            .prepare_install_plan(self.requested_version.clone(), self.force)
            .await
            .map_err(|error| TaskExecutionError::new(error.to_string()))?;
        {
            let mut rollback_state = self.rollback_state.lock().await;
            rollback_state.target_runtime_dir = Some(
                self.manager
                    .root_dir
                    .join(RUNTIMES_DIR)
                    .join(runtime_dir_name(&plan.version, plan.platform)),
            );
        }

        {
            let mut state = self.manager.inner.lock().await;
            state.runtime = ManagerRuntimeState::Installing;
            state.install_progress = Some(preparing_install_progress());
        }
        self.manager.notify.notify_waiters();
        self.manager.publish_status_update().await;

        self.plan = Some(plan);
        self.initialized = true;
        Ok(())
    }

    fn plan(&self) -> Result<CodeServerInstallPlan, TaskExecutionError> {
        self.plan
            .clone()
            .ok_or_else(|| TaskExecutionError::new("missing install plan"))
    }
    pub(super) async fn stop_runtime(
        &mut self,
        context: TaskStepContext,
    ) -> Result<TaskStepResult, TaskExecutionError> {
        self.ensure_initialized().await?;
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
        self.ensure_initialized().await?;
        let plan = self.plan()?;
        context.set_status_text("Downloading runtime").await;
        let target_runtime_dir = self
            .manager
            .root_dir
            .join(RUNTIMES_DIR)
            .join(runtime_dir_name(&plan.version, plan.platform));
        if plan.force
            && tokio::fs::try_exists(&target_runtime_dir)
                .await
                .map_err(|error| TaskExecutionError::new(error.to_string()))?
        {
            let backup_runtime_dir = self.manager.root_dir.join(TMP_DIR).join(format!(
                "{}-rollback-{}",
                runtime_dir_name(&plan.version, plan.platform),
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
        let runtime = (self.manager.download_runtime)(CodeServerDownloadRequest {
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
        self.ensure_initialized().await?;
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
        let server = (self.manager.launch)(build_launch_request(&self.manager.root_dir, &runtime))
            .await
            .map_err(|error| TaskExecutionError::new(error.to_string()))?;
        self.manager
            .process_handle
            .finish_running(server.process)
            .await;
        {
            let mut state = self.manager.inner.lock().await;
            state.runtime = ManagerRuntimeState::Ready(server.connection);
        }
        self.manager.notify.notify_waiters();
        self.manager.publish_status_update().await;
        context.set_step_progress(100).await;
        Ok(TaskStepResult::Completed)
    }

    pub(super) async fn cleanup_runtimes(
        &mut self,
        context: TaskStepContext,
    ) -> Result<TaskStepResult, TaskExecutionError> {
        self.ensure_initialized().await?;
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
        cleanup_other_platform_runtimes(
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
            state.runtime = ManagerRuntimeState::Idle;
        }
        drop(state);
        self.manager.notify.notify_waiters();
        self.manager.publish_status_update().await;
    }
}

impl CodeServerManager {
    /// Create a manager that launches a shared `code-server` instance.
    pub fn new(
        root_dir: PathBuf,
        _events: Arc<EventBus>,
        processes: Arc<ManagedProcessService>,
    ) -> Self {
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
                latest: None,
                install_progress: None,
                runtime: ManagerRuntimeState::Idle,
            })),
            notify: Arc::new(Notify::new()),
            status_callback: Arc::new(Mutex::new(None)),
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
            process_handle: processes.register_process("code_server", "code-server"),
        }
    }

    #[cfg(test)]
    pub(super) fn with_hooks(
        root_dir: PathBuf,
        fetch_latest: FetchLatestFn,
        download_runtime: DownloadRuntimeFn,
        launch: LaunchFn,
    ) -> Self {
        let events = Arc::new(EventBus::new());
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|error| panic!("failed to build code-server client: {error}"));

        Self {
            inner: Arc::new(Mutex::new(ManagerState {
                latest: None,
                install_progress: None,
                runtime: ManagerRuntimeState::Idle,
            })),
            notify: Arc::new(Notify::new()),
            status_callback: Arc::new(Mutex::new(None)),
            client,
            fetch_latest,
            download_runtime,
            launch,
            root_dir,
            process_handle: ManagedProcessService::new(events)
                .register_process("code_server", "code-server"),
        }
    }

    pub async fn set_status_callback(&self, callback: StatusCallback) {
        *self.status_callback.lock().await = Some(callback);
    }

    pub fn http_client(&self) -> &reqwest::Client {
        &self.client
    }

    pub async fn register_process_callback(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
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

        let mut state = self.inner.lock().await;
        state.runtime.clear_ready();
    }

    pub async fn status(&self) -> CodeServerStatusSnapshot {
        let supported = detect_platform().is_ok();
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
                    Some("code-server exited".to_string()),
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
            if let Err(error) = detect_platform() {
                message = Some(error.to_string());
            } else if process
                .as_ref()
                .and_then(|status| status.last_exit.as_ref())
                .is_some()
                && process_status == CodeServerProcessStatusValue::Error
            {
                message = Some("code-server exited".to_string());
            }
        }

        CodeServerStatusSnapshot {
            supported,
            installed_version: installed.map(|runtime| runtime.version),
            process_status,
            latest: state.latest.clone(),
            install_progress: state.install_progress.clone(),
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

        self.publish_status_update().await;

        Ok(self.status().await)
    }

    pub async fn start(&self) -> Result<CodeServerStatusSnapshot, CodeServerError> {
        self.ensure_ready().await?;
        Ok(self.status().await)
    }

    pub async fn stop(&self) -> Result<CodeServerStatusSnapshot, CodeServerError> {
        self.stop_managed_process().await?;
        Ok(self.status().await)
    }

    pub async fn restart(&self) -> Result<CodeServerStatusSnapshot, CodeServerError> {
        self.stop().await?;
        self.start().await
    }

    pub async fn shutdown(&self) -> Result<(), CodeServerError> {
        self.stop_managed_process().await
    }

    pub async fn ensure_ready(&self) -> Result<CodeServerConnection, CodeServerError> {
        loop {
            let process = self
                .process_handle
                .status()
                .await
                .map_err(map_managed_process_error)?;
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

    async fn find_installed_runtime(&self) -> Result<Option<InstalledRuntime>, CodeServerError> {
        let root_dir = self.root_dir.clone();
        let platform = detect_platform()?;
        tokio::task::spawn_blocking(move || find_installed_runtime_sync(root_dir, platform))
            .await
            .map_err(|error| CodeServerError::Spawn(error.to_string()))?
    }

    fn task_install_progress_callback(
        &self,
        step: crate::task_manager::TaskStepContext,
    ) -> InstallProgressFn {
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
        let mut should_emit = false;
        {
            let mut state = self.inner.lock().await;
            if state.install_progress.as_ref() != Some(&progress) {
                state.install_progress = Some(progress);
                should_emit = true;
            }
        }

        if should_emit {
            self.notify.notify_waiters();
            self.publish_status_update().await;
        }
    }

    async fn publish_status_update(&self) {
        let callback = self.status_callback.lock().await.clone();
        if let Some(callback) = callback {
            callback().await;
        }
    }

    async fn prepare_install_plan(
        &self,
        requested_version: Option<String>,
        force: bool,
    ) -> Result<CodeServerInstallPlan, CodeServerError> {
        let platform = detect_platform()?;
        let version = match requested_version {
            Some(version) => normalize_version(&version)?,
            None if force => {
                if let Some(installed) = self.find_installed_runtime().await? {
                    installed.version
                } else {
                    (self.fetch_latest)().await?
                }
            }
            None => (self.fetch_latest)().await?,
        };

        Ok(CodeServerInstallPlan {
            version,
            platform,
            force,
        })
    }

    async fn start_managed_process(&self) -> Result<CodeServerConnection, CodeServerError> {
        let runtime = self.find_installed_runtime().await?;
        let runtime = runtime.ok_or(CodeServerError::NotInstalled)?;
        loop {
            if let Some(status) = self
                .process_handle
                .begin_start()
                .await
                .map_err(map_managed_process_error)?
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

        let result = (self.launch)(build_launch_request(&self.root_dir, &runtime)).await;
        match result {
            Ok(server) => {
                let connection = server.connection.clone();
                self.process_handle.finish_running(server.process).await;
                {
                    let mut state = self.inner.lock().await;
                    state.install_progress = None;
                    state.runtime = ManagerRuntimeState::Ready(connection.clone());
                }
                self.notify.notify_waiters();
                Ok(connection)
            }
            Err(error) => {
                self.process_handle.finish_error(error.to_string()).await;
                {
                    let mut state = self.inner.lock().await;
                    state.install_progress = None;
                    state.runtime = ManagerRuntimeState::Idle;
                }
                self.notify.notify_waiters();
                Err(error)
            }
        }
    }

    async fn stop_managed_process(&self) -> Result<(), CodeServerError> {
        self.stop_managed_process_impl(true).await.map(|_| ())
    }

    pub(super) async fn stop_managed_process_for_install(&self) -> Result<bool, CodeServerError> {
        self.stop_managed_process_impl(false).await
    }

    async fn stop_managed_process_impl(
        &self,
        wait_for_install: bool,
    ) -> Result<bool, CodeServerError> {
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
            .map_err(map_managed_process_error)?
        {
            ManagedProcessStopTarget::Running(mut runtime) => {
                if let Err(error) = runtime.shutdown().await.map_err(map_managed_process_error) {
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
                state.runtime = ManagerRuntimeState::Idle;
            }
        }
        self.notify.notify_waiters();
        self.process_handle.finish_stopped().await;
        Ok(had_running)
    }
}

impl ManagedProcessController for CodeServerManager {
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
