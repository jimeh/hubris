use std::collections::HashMap;
use std::fmt;
use std::process::ExitStatus;
use std::sync::{Arc, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::future::BoxFuture;
use tokio::process::Child;
use tokio::sync::{Mutex, Notify};

use crate::events::{EventBus, EventKind};

const SHUTDOWN_GRACE_TIMEOUT: Duration = Duration::from_secs(10);
const SHUTDOWN_POLL_INTERVAL: Duration = Duration::from_millis(100);

type ManagedProcessChangeFn =
    Arc<dyn Fn(ManagedProcessStatusSnapshot) -> BoxFuture<'static, ()> + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedProcessLifecycleState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Exited,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedProcessExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub finished_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedProcessStatusSnapshot {
    pub id: String,
    pub kind: String,
    pub lifecycle_state: ManagedProcessLifecycleState,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    pub last_exit: Option<ManagedProcessExit>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedProcessActionErrorKind {
    NotFound,
    InvalidRequest,
    Conflict,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ManagedProcessActionError {
    kind: ManagedProcessActionErrorKind,
    message: String,
}

impl ManagedProcessActionError {
    pub fn new(kind: ManagedProcessActionErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn kind(&self) -> ManagedProcessActionErrorKind {
        self.kind
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn not_found(id: &str) -> Self {
        Self::new(
            ManagedProcessActionErrorKind::NotFound,
            format!("unknown managed process: {id}"),
        )
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(ManagedProcessActionErrorKind::InvalidRequest, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ManagedProcessActionErrorKind::Conflict, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ManagedProcessActionErrorKind::Internal, message)
    }
}

pub trait ManagedProcessController: Send + Sync {
    fn id(&self) -> &str;
    fn kind(&self) -> &str;
    fn start(
        &self,
    ) -> BoxFuture<'_, Result<ManagedProcessStatusSnapshot, ManagedProcessActionError>>;
    fn stop(
        &self,
    ) -> BoxFuture<'_, Result<ManagedProcessStatusSnapshot, ManagedProcessActionError>>;
    fn restart(
        &self,
    ) -> BoxFuture<'_, Result<ManagedProcessStatusSnapshot, ManagedProcessActionError>>;
}

#[derive(Clone)]
pub struct ManagedProcessService {
    inner: Arc<ManagedProcessServiceInner>,
}

impl fmt::Debug for ManagedProcessService {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let ids = self
            .inner
            .slots
            .read()
            .expect("managed process slots poisoned")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        f.debug_struct("ManagedProcessService")
            .field("process_ids", &ids)
            .finish()
    }
}

struct ManagedProcessServiceInner {
    events: Arc<EventBus>,
    slots: std::sync::RwLock<HashMap<String, Arc<ManagedProcessSlot>>>,
    controllers: std::sync::RwLock<HashMap<String, Arc<dyn ManagedProcessController>>>,
}

struct ManagedProcessSlot {
    id: String,
    kind: String,
    state: Mutex<ManagedProcessRuntimeState>,
    notify: Notify,
    on_change: Mutex<Option<ManagedProcessChangeFn>>,
}

#[derive(Debug)]
struct ManagedProcessRuntimeState {
    lifecycle: ManagedProcessRuntimeLifecycle,
    started_at: Option<String>,
    last_exit: Option<ManagedProcessExit>,
    last_error: Option<String>,
}

#[derive(Debug)]
enum ManagedProcessRuntimeLifecycle {
    Stopped,
    Starting,
    Running(ManagedProcessRuntime),
    Stopping,
    Exited,
    Error,
}

#[derive(Clone)]
pub struct ManagedProcessHandle {
    slot: Arc<ManagedProcessSlot>,
    service: Weak<ManagedProcessServiceInner>,
}

impl fmt::Debug for ManagedProcessHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ManagedProcessHandle")
            .field("id", &self.slot.id)
            .field("kind", &self.slot.kind)
            .finish()
    }
}

pub(crate) enum ManagedProcessStopTarget {
    Running(ManagedProcessRuntime),
    NotRunning,
}

#[derive(Debug)]
pub(crate) enum ManagedProcessRuntime {
    Child(ManagedChildProcess),
    #[cfg(test)]
    External,
    #[cfg(test)]
    TestProbe(TestProcessProbe),
}

#[derive(Debug)]
pub struct ManagedChildProcess {
    child: Child,
    #[cfg(unix)]
    process_group_id: Option<i32>,
}

#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct TestProcessProbe {
    pub alive: Arc<std::sync::atomic::AtomicBool>,
    pub shutdowns: Arc<std::sync::atomic::AtomicUsize>,
    pub drop_kills: Arc<std::sync::atomic::AtomicUsize>,
    pub fail_shutdown: Arc<std::sync::atomic::AtomicBool>,
}

#[cfg(test)]
impl TestProcessProbe {
    pub(crate) fn new(alive: bool) -> Self {
        Self {
            alive: Arc::new(std::sync::atomic::AtomicBool::new(alive)),
            shutdowns: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            drop_kills: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            fail_shutdown: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub(crate) fn runtime(&self) -> ManagedProcessRuntime {
        ManagedProcessRuntime::TestProbe(self.clone())
    }

    pub(crate) fn with_shutdown_error(self) -> Self {
        self.fail_shutdown
            .store(true, std::sync::atomic::Ordering::Relaxed);
        self
    }
}

impl ManagedProcessService {
    pub fn new(events: Arc<EventBus>) -> Self {
        Self {
            inner: Arc::new(ManagedProcessServiceInner {
                events,
                slots: std::sync::RwLock::new(HashMap::new()),
                controllers: std::sync::RwLock::new(HashMap::new()),
            }),
        }
    }

    pub fn register_process(
        &self,
        id: impl Into<String>,
        kind: impl Into<String>,
    ) -> ManagedProcessHandle {
        let id = id.into();
        let kind = kind.into();
        let mut slots = self
            .inner
            .slots
            .write()
            .expect("managed process slots poisoned");
        let slot = slots
            .entry(id.clone())
            .or_insert_with(|| {
                Arc::new(ManagedProcessSlot {
                    id: id.clone(),
                    kind: kind.clone(),
                    state: Mutex::new(ManagedProcessRuntimeState {
                        lifecycle: ManagedProcessRuntimeLifecycle::Stopped,
                        started_at: None,
                        last_exit: None,
                        last_error: None,
                    }),
                    notify: Notify::new(),
                    on_change: Mutex::new(None),
                })
            })
            .clone();

        assert_eq!(slot.kind, kind, "managed process kind mismatch for {id}");

        ManagedProcessHandle {
            slot,
            service: Arc::downgrade(&self.inner),
        }
    }

    pub fn register_controller(&self, controller: Arc<dyn ManagedProcessController>) {
        let id = controller.id().to_string();
        let slots = self
            .inner
            .slots
            .read()
            .expect("managed process slots poisoned");
        let Some(slot) = slots.get(&id) else {
            panic!("managed process controller registered before slot creation: {id}");
        };
        assert_eq!(
            slot.kind,
            controller.kind(),
            "managed process controller kind mismatch for {id}"
        );
        drop(slots);

        self.inner
            .controllers
            .write()
            .expect("managed process controllers poisoned")
            .insert(id, controller);
    }

    pub async fn list(
        &self,
    ) -> Result<Vec<ManagedProcessStatusSnapshot>, ManagedProcessActionError> {
        let slots = self
            .inner
            .slots
            .read()
            .expect("managed process slots poisoned")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut snapshots = Vec::with_capacity(slots.len());
        for slot in slots {
            let handle = ManagedProcessHandle {
                slot,
                service: Arc::downgrade(&self.inner),
            };
            snapshots.push(handle.status().await?);
        }
        snapshots.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(snapshots)
    }

    pub async fn get(
        &self,
        id: &str,
    ) -> Result<ManagedProcessStatusSnapshot, ManagedProcessActionError> {
        let slot = self
            .inner
            .slots
            .read()
            .expect("managed process slots poisoned")
            .get(id)
            .cloned()
            .ok_or_else(|| ManagedProcessActionError::not_found(id))?;
        ManagedProcessHandle {
            slot,
            service: Arc::downgrade(&self.inner),
        }
        .status()
        .await
    }

    pub async fn start(
        &self,
        id: &str,
    ) -> Result<ManagedProcessStatusSnapshot, ManagedProcessActionError> {
        let controller = self
            .inner
            .controllers
            .read()
            .expect("managed process controllers poisoned")
            .get(id)
            .cloned()
            .ok_or_else(|| ManagedProcessActionError::not_found(id))?;
        controller.start().await
    }

    pub async fn stop(
        &self,
        id: &str,
    ) -> Result<ManagedProcessStatusSnapshot, ManagedProcessActionError> {
        let controller = self
            .inner
            .controllers
            .read()
            .expect("managed process controllers poisoned")
            .get(id)
            .cloned()
            .ok_or_else(|| ManagedProcessActionError::not_found(id))?;
        controller.stop().await
    }

    pub async fn restart(
        &self,
        id: &str,
    ) -> Result<ManagedProcessStatusSnapshot, ManagedProcessActionError> {
        let controller = self
            .inner
            .controllers
            .read()
            .expect("managed process controllers poisoned")
            .get(id)
            .cloned()
            .ok_or_else(|| ManagedProcessActionError::not_found(id))?;
        controller.restart().await
    }

    pub async fn shutdown_all(&self) -> Result<(), ManagedProcessActionError> {
        let controllers = self
            .inner
            .controllers
            .read()
            .expect("managed process controllers poisoned")
            .values()
            .cloned()
            .collect::<Vec<_>>();

        let mut last_error = None;
        for controller in controllers {
            if let Err(error) = controller.stop().await {
                tracing::warn!(
                    process_id = controller.id(),
                    "failed to stop managed process during shutdown: {error}"
                );
                last_error = Some(error);
            }
        }

        match last_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

impl ManagedProcessHandle {
    pub fn id(&self) -> &str {
        &self.slot.id
    }

    pub fn kind(&self) -> &str {
        &self.slot.kind
    }

    pub async fn set_on_change(&self, callback: ManagedProcessChangeFn) {
        let mut on_change = self.slot.on_change.lock().await;
        *on_change = Some(callback);
    }

    pub async fn status(&self) -> Result<ManagedProcessStatusSnapshot, ManagedProcessActionError> {
        let (changed, snapshot) = {
            let mut state = self.slot.state.lock().await;
            let changed = normalize_dead_process(&mut state)?;
            let snapshot = self.slot.snapshot(&state);
            (changed, snapshot)
        };

        if changed {
            self.emit_change(snapshot.clone()).await;
        }

        Ok(snapshot)
    }

    pub(crate) async fn begin_start(
        &self,
    ) -> Result<Option<ManagedProcessStatusSnapshot>, ManagedProcessActionError> {
        loop {
            let wait = {
                let mut state = self.slot.state.lock().await;
                normalize_dead_process(&mut state)?;

                match state.lifecycle {
                    ManagedProcessRuntimeLifecycle::Starting
                    | ManagedProcessRuntimeLifecycle::Stopping => true,
                    ManagedProcessRuntimeLifecycle::Running(_) => {
                        return Ok(Some(self.slot.snapshot(&state)));
                    }
                    ManagedProcessRuntimeLifecycle::Stopped
                    | ManagedProcessRuntimeLifecycle::Exited
                    | ManagedProcessRuntimeLifecycle::Error => {
                        state.lifecycle = ManagedProcessRuntimeLifecycle::Starting;
                        state.started_at = None;
                        state.last_error = None;
                        let snapshot = self.slot.snapshot(&state);
                        drop(state);
                        self.emit_change(snapshot).await;
                        return Ok(None);
                    }
                }
            };

            if wait {
                self.slot.notify.notified().await;
            }
        }
    }

    pub(crate) async fn begin_stop(
        &self,
    ) -> Result<ManagedProcessStopTarget, ManagedProcessActionError> {
        loop {
            let wait = {
                let mut state = self.slot.state.lock().await;
                normalize_dead_process(&mut state)?;

                match &mut state.lifecycle {
                    ManagedProcessRuntimeLifecycle::Starting
                    | ManagedProcessRuntimeLifecycle::Stopping => true,
                    ManagedProcessRuntimeLifecycle::Running(_) => {
                        let runtime = match std::mem::replace(
                            &mut state.lifecycle,
                            ManagedProcessRuntimeLifecycle::Stopping,
                        ) {
                            ManagedProcessRuntimeLifecycle::Running(runtime) => runtime,
                            _ => unreachable!(),
                        };
                        state.started_at = None;
                        let snapshot = self.slot.snapshot(&state);
                        drop(state);
                        self.emit_change(snapshot).await;
                        return Ok(ManagedProcessStopTarget::Running(runtime));
                    }
                    ManagedProcessRuntimeLifecycle::Stopped
                    | ManagedProcessRuntimeLifecycle::Exited
                    | ManagedProcessRuntimeLifecycle::Error => {
                        state.lifecycle = ManagedProcessRuntimeLifecycle::Stopping;
                        state.started_at = None;
                        let snapshot = self.slot.snapshot(&state);
                        drop(state);
                        self.emit_change(snapshot).await;
                        return Ok(ManagedProcessStopTarget::NotRunning);
                    }
                }
            };

            if wait {
                self.slot.notify.notified().await;
            }
        }
    }

    pub(crate) async fn finish_running(&self, runtime: ManagedProcessRuntime) {
        let snapshot = {
            let mut state = self.slot.state.lock().await;
            state.started_at = Some(now_timestamp_string());
            state.last_exit = None;
            state.last_error = None;
            state.lifecycle = ManagedProcessRuntimeLifecycle::Running(runtime);
            self.slot.snapshot(&state)
        };
        self.emit_change(snapshot).await;
    }

    pub(crate) async fn finish_stopped(&self) {
        let snapshot = {
            let mut state = self.slot.state.lock().await;
            state.lifecycle = ManagedProcessRuntimeLifecycle::Stopped;
            state.started_at = None;
            state.last_exit = None;
            state.last_error = None;
            self.slot.snapshot(&state)
        };
        self.emit_change(snapshot).await;
    }

    pub(crate) async fn finish_error(&self, message: String) {
        let snapshot = {
            let mut state = self.slot.state.lock().await;
            state.lifecycle = ManagedProcessRuntimeLifecycle::Error;
            state.started_at = None;
            state.last_error = Some(message);
            self.slot.snapshot(&state)
        };
        self.emit_change(snapshot).await;
    }

    async fn emit_change(&self, snapshot: ManagedProcessStatusSnapshot) {
        self.slot.notify.notify_waiters();

        if let Some(service) = self.service.upgrade() {
            service
                .events
                .emit(EventKind::ManagedProcessUpdated(Box::new(
                    snapshot.clone().into(),
                )));
        }

        let callback = self.slot.on_change.lock().await.clone();
        if let Some(callback) = callback {
            callback(snapshot).await;
        }
    }
}

impl ManagedProcessSlot {
    fn snapshot(&self, state: &ManagedProcessRuntimeState) -> ManagedProcessStatusSnapshot {
        ManagedProcessStatusSnapshot {
            id: self.id.clone(),
            kind: self.kind.clone(),
            lifecycle_state: match state.lifecycle {
                ManagedProcessRuntimeLifecycle::Stopped => ManagedProcessLifecycleState::Stopped,
                ManagedProcessRuntimeLifecycle::Starting => ManagedProcessLifecycleState::Starting,
                ManagedProcessRuntimeLifecycle::Running(_) => ManagedProcessLifecycleState::Running,
                ManagedProcessRuntimeLifecycle::Stopping => ManagedProcessLifecycleState::Stopping,
                ManagedProcessRuntimeLifecycle::Exited => ManagedProcessLifecycleState::Exited,
                ManagedProcessRuntimeLifecycle::Error => ManagedProcessLifecycleState::Error,
            },
            pid: match &state.lifecycle {
                ManagedProcessRuntimeLifecycle::Running(runtime) => runtime.pid(),
                _ => None,
            },
            started_at: state.started_at.clone(),
            last_exit: state.last_exit.clone(),
            last_error: state.last_error.clone(),
        }
    }
}

impl ManagedChildProcess {
    pub fn new(child: Child) -> Self {
        Self {
            #[cfg(unix)]
            process_group_id: child.id().and_then(|pid| i32::try_from(pid).ok()),
            child,
        }
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    #[cfg(test)]
    pub(crate) fn is_alive(&mut self) -> Result<bool, ManagedProcessActionError> {
        self.poll_exit().map(|exit| exit.is_none())
    }

    fn poll_exit(&mut self) -> Result<Option<ManagedProcessExit>, ManagedProcessActionError> {
        self.child
            .try_wait()
            .map(|status| status.map(exit_details))
            .map_err(|error| ManagedProcessActionError::internal(error.to_string()))
    }

    pub async fn shutdown(&mut self) -> Result<(), ManagedProcessActionError> {
        self.shutdown_with_timeout(SHUTDOWN_GRACE_TIMEOUT).await
    }

    pub async fn shutdown_with_timeout(
        &mut self,
        timeout: Duration,
    ) -> Result<(), ManagedProcessActionError> {
        if self
            .child
            .try_wait()
            .map_err(|error| ManagedProcessActionError::internal(error.to_string()))?
            .is_some()
        {
            return Ok(());
        }

        self.send_graceful_shutdown()
            .map_err(|error| ManagedProcessActionError::internal(error.to_string()))?;
        if wait_for_child_exit(&mut self.child, timeout).await? {
            return Ok(());
        }

        tracing::warn!("managed process did not exit after SIGTERM; forcing shutdown");
        self.force_kill()
            .map_err(|error| ManagedProcessActionError::internal(error.to_string()))?;
        self.child
            .wait()
            .await
            .map_err(|error| ManagedProcessActionError::internal(error.to_string()))?;
        Ok(())
    }

    fn send_graceful_shutdown(&mut self) -> std::io::Result<()> {
        #[cfg(unix)]
        if let Some(process_group_id) = self.process_group_id {
            return send_signal_to_process_group(process_group_id, libc::SIGTERM);
        }

        self.child.start_kill()
    }

    fn force_kill(&mut self) -> std::io::Result<()> {
        #[cfg(unix)]
        if let Some(process_group_id) = self.process_group_id {
            return send_signal_to_process_group(process_group_id, libc::SIGKILL);
        }

        self.child.start_kill()
    }
}

impl ManagedProcessRuntime {
    pub(crate) fn pid(&self) -> Option<u32> {
        match self {
            Self::Child(child) => child.pid(),
            #[cfg(test)]
            Self::External => None,
            #[cfg(test)]
            Self::TestProbe(_) => None,
        }
    }

    pub(crate) async fn shutdown(&mut self) -> Result<(), ManagedProcessActionError> {
        match self {
            Self::Child(child) => child.shutdown().await,
            #[cfg(test)]
            Self::External => Ok(()),
            #[cfg(test)]
            Self::TestProbe(probe) => {
                probe
                    .shutdowns
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if probe
                    .fail_shutdown
                    .load(std::sync::atomic::Ordering::Relaxed)
                {
                    return Err(ManagedProcessActionError::internal("test shutdown failure"));
                }
                probe
                    .alive
                    .store(false, std::sync::atomic::Ordering::Relaxed);
                Ok(())
            }
        }
    }

    fn poll_exit(&mut self) -> Result<Option<ManagedProcessExit>, ManagedProcessActionError> {
        match self {
            Self::Child(child) => child.poll_exit(),
            #[cfg(test)]
            Self::External => Ok(None),
            #[cfg(test)]
            Self::TestProbe(probe) => {
                if probe.alive.load(std::sync::atomic::Ordering::Relaxed) {
                    Ok(None)
                } else {
                    Ok(Some(ManagedProcessExit {
                        code: None,
                        signal: None,
                        finished_at: now_timestamp_string(),
                    }))
                }
            }
        }
    }
}

impl Drop for ManagedProcessRuntime {
    fn drop(&mut self) {
        match self {
            Self::Child(child) => {
                let _ = child.force_kill();
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

pub fn now_timestamp_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

#[cfg(target_os = "linux")]
pub fn configure_parent_death_signal(command: &mut tokio::process::Command) {
    let parent_pid = unsafe { libc::getpid() };
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                return Err(std::io::Error::last_os_error());
            }

            if libc::getppid() != parent_pid {
                return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
            }

            Ok(())
        });
    }
}

#[cfg(not(target_os = "linux"))]
pub fn configure_parent_death_signal(_command: &mut tokio::process::Command) {}

fn normalize_dead_process(
    state: &mut ManagedProcessRuntimeState,
) -> Result<bool, ManagedProcessActionError> {
    let Some(exit) = (match &mut state.lifecycle {
        ManagedProcessRuntimeLifecycle::Running(runtime) => runtime.poll_exit()?,
        _ => None,
    }) else {
        return Ok(false);
    };

    state.lifecycle = ManagedProcessRuntimeLifecycle::Exited;
    state.started_at = None;
    state.last_exit = Some(exit);
    state.last_error = None;
    Ok(true)
}

#[cfg(unix)]
fn send_signal_to_process_group(process_group_id: i32, signal: libc::c_int) -> std::io::Result<()> {
    let result = unsafe { libc::kill(-process_group_id, signal) };
    if result == 0 {
        return Ok(());
    }

    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }

    Err(error)
}

async fn wait_for_child_exit(
    child: &mut Child,
    timeout: Duration,
) -> Result<bool, ManagedProcessActionError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if child
            .try_wait()
            .map_err(|error| ManagedProcessActionError::internal(error.to_string()))?
            .is_some()
        {
            return Ok(true);
        }

        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }

        tokio::time::sleep(SHUTDOWN_POLL_INTERVAL).await;
    }
}

fn exit_details(status: ExitStatus) -> ManagedProcessExit {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;

        ManagedProcessExit {
            code: status.code(),
            signal: status.signal(),
            finished_at: now_timestamp_string(),
        }
    }

    #[cfg(not(unix))]
    {
        ManagedProcessExit {
            code: status.code(),
            signal: None,
            finished_at: now_timestamp_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::Stdio;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::http::StatusCode;
    use futures_util::StreamExt;
    use tokio::process::Command;

    use super::*;
    use crate::AppState;
    use crate::build_router;

    #[cfg(unix)]
    use std::fs::Permissions;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    struct TestController {
        handle: ManagedProcessHandle,
        launches: Arc<AtomicUsize>,
        stops: Arc<AtomicUsize>,
        active_starts: Arc<AtomicUsize>,
        max_active_starts: Arc<AtomicUsize>,
        delay: Duration,
        fail_start: bool,
        fail_stop: bool,
    }

    impl ManagedProcessController for TestController {
        fn id(&self) -> &str {
            self.handle.id()
        }

        fn kind(&self) -> &str {
            self.handle.kind()
        }

        fn start(
            &self,
        ) -> BoxFuture<'_, Result<ManagedProcessStatusSnapshot, ManagedProcessActionError>>
        {
            Box::pin(async move {
                if let Some(status) = self.handle.begin_start().await? {
                    return Ok(status);
                }

                self.launches.fetch_add(1, Ordering::Relaxed);
                let active = self.active_starts.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = self.max_active_starts.fetch_max(active, Ordering::Relaxed);
                tokio::time::sleep(self.delay).await;
                self.active_starts.fetch_sub(1, Ordering::Relaxed);

                if self.fail_start {
                    let message = "test start failure".to_string();
                    self.handle.finish_error(message.clone()).await;
                    return Err(ManagedProcessActionError::internal(message));
                }

                self.handle
                    .finish_running(ManagedProcessRuntime::External)
                    .await;
                self.handle.status().await
            })
        }

        fn stop(
            &self,
        ) -> BoxFuture<'_, Result<ManagedProcessStatusSnapshot, ManagedProcessActionError>>
        {
            Box::pin(async move {
                self.stops.fetch_add(1, Ordering::Relaxed);
                if self.fail_stop {
                    return Err(ManagedProcessActionError::internal("test stop failure"));
                }

                match self.handle.begin_stop().await? {
                    ManagedProcessStopTarget::Running(mut runtime) => runtime.shutdown().await?,
                    ManagedProcessStopTarget::NotRunning => {}
                }
                self.handle.finish_stopped().await;
                self.handle.status().await
            })
        }

        fn restart(
            &self,
        ) -> BoxFuture<'_, Result<ManagedProcessStatusSnapshot, ManagedProcessActionError>>
        {
            Box::pin(async move {
                self.stop().await?;
                self.start().await
            })
        }
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

    fn test_controller(
        handle: ManagedProcessHandle,
        delay: Duration,
        fail_start: bool,
        fail_stop: bool,
    ) -> Arc<TestController> {
        Arc::new(TestController {
            handle,
            launches: Arc::new(AtomicUsize::new(0)),
            stops: Arc::new(AtomicUsize::new(0)),
            active_starts: Arc::new(AtomicUsize::new(0)),
            max_active_starts: Arc::new(AtomicUsize::new(0)),
            delay,
            fail_start,
            fail_stop,
        })
    }

    #[tokio::test]
    async fn registers_multiple_processes_and_lists_them_sorted() {
        let service = ManagedProcessService::new(Arc::new(EventBus::new()));
        service.register_process("b", "beta");
        service.register_process("a", "alpha");

        let statuses = service.list().await.unwrap();
        assert_eq!(statuses.len(), 2);
        assert_eq!(statuses[0].id, "a");
        assert_eq!(statuses[1].id, "b");
    }

    #[tokio::test]
    async fn concurrent_start_calls_serialize_for_one_process() {
        let service = ManagedProcessService::new(Arc::new(EventBus::new()));
        let handle = service.register_process("code_server", "code-server");
        let controller = test_controller(handle.clone(), Duration::from_millis(40), false, false);
        let launches = controller.launches.clone();
        service.register_controller(controller);

        let (first, second) =
            tokio::join!(service.start("code_server"), service.start("code_server"));

        assert!(first.is_ok());
        assert!(second.is_ok());
        assert_eq!(launches.load(Ordering::Relaxed), 1);
        assert_eq!(
            handle.status().await.unwrap().lifecycle_state,
            ManagedProcessLifecycleState::Running
        );
    }

    #[tokio::test]
    async fn different_processes_start_independently() {
        let service = ManagedProcessService::new(Arc::new(EventBus::new()));
        let handle_a = service.register_process("a", "kind-a");
        let handle_b = service.register_process("b", "kind-b");
        let controller_a = test_controller(handle_a, Duration::from_millis(40), false, false);
        let controller_b = test_controller(handle_b, Duration::from_millis(40), false, false);
        let max_a = controller_a.max_active_starts.clone();
        let max_b = controller_b.max_active_starts.clone();
        service.register_controller(controller_a);
        service.register_controller(controller_b);

        let (first, second) = tokio::join!(service.start("a"), service.start("b"));

        assert!(first.is_ok());
        assert!(second.is_ok());
        assert_eq!(max_a.load(Ordering::Relaxed), 1);
        assert_eq!(max_b.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn dead_running_process_normalizes_to_exited() {
        let service = ManagedProcessService::new(Arc::new(EventBus::new()));
        let handle = service.register_process("code_server", "code-server");
        let probe = TestProcessProbe::new(true);

        handle.finish_running(probe.runtime()).await;
        probe.alive.store(false, Ordering::Relaxed);

        let status = handle.status().await.unwrap();
        assert_eq!(status.lifecycle_state, ManagedProcessLifecycleState::Exited);
        assert!(status.last_exit.is_some());
    }

    #[tokio::test]
    async fn launch_failure_becomes_visible_error_state() {
        let service = ManagedProcessService::new(Arc::new(EventBus::new()));
        let handle = service.register_process("code_server", "code-server");
        let controller = test_controller(handle.clone(), Duration::from_millis(10), true, false);
        service.register_controller(controller);

        let error = service.start("code_server").await.unwrap_err();
        assert_eq!(error.kind(), ManagedProcessActionErrorKind::Internal);

        let status = handle.status().await.unwrap();
        assert_eq!(status.lifecycle_state, ManagedProcessLifecycleState::Error);
        assert_eq!(status.last_error.as_deref(), Some("test start failure"));
    }

    #[tokio::test]
    async fn shutdown_all_attempts_every_registered_controller() {
        let service = ManagedProcessService::new(Arc::new(EventBus::new()));
        let handle_a = service.register_process("a", "kind-a");
        let handle_b = service.register_process("b", "kind-b");
        let controller_a = test_controller(handle_a, Duration::from_millis(0), false, true);
        let controller_b =
            test_controller(handle_b.clone(), Duration::from_millis(0), false, false);
        let stop_calls_a = controller_a.stops.clone();
        let stop_calls_b = controller_b.stops.clone();
        service.register_controller(controller_a);
        service.register_controller(controller_b);

        handle_b
            .finish_running(ManagedProcessRuntime::External)
            .await;

        let error = service.shutdown_all().await.unwrap_err();
        assert_eq!(error.kind(), ManagedProcessActionErrorKind::Internal);
        assert_eq!(stop_calls_a.load(Ordering::Relaxed), 1);
        assert_eq!(stop_calls_b.load(Ordering::Relaxed), 1);
        assert_eq!(
            handle_b.status().await.unwrap().lifecycle_state,
            ManagedProcessLifecycleState::Stopped
        );
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
        assert!(process.poll_exit().unwrap().is_some());
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
        process
            .shutdown_with_timeout(Duration::from_millis(250))
            .await
            .unwrap();

        let exit = process
            .poll_exit()
            .unwrap()
            .expect("process should be exited");
        assert_eq!(exit.signal, Some(libc::SIGKILL));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn linux_parent_death_signal_terminates_child_after_parent_exit() {
        let tmp = tempfile::TempDir::new().unwrap();
        let child_pid_path = tmp.path().join("child.pid");

        let status = Command::new(std::env::current_exe().unwrap())
            .arg("--ignored")
            .arg("--exact")
            .arg("process_manager::tests::linux_parent_death_signal_helper")
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
        std::fs::write(
            std::path::PathBuf::from(child_pid_path),
            format!("{child_pid}"),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn process_api_lists_registered_code_server_process() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = AppState::new(tmp.path().to_path_buf()).await;
        let app = build_router(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let response = reqwest::get(format!("http://{addr}/api/processes"))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = response.json().await.unwrap();
        let ids = body
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec!["code_server".to_string(), "vscode_cli".to_string()]
        );
    }

    #[tokio::test]
    async fn process_api_get_returns_running_pid_and_started_at() {
        struct ChildController {
            handle: ManagedProcessHandle,
            script_path: std::path::PathBuf,
        }

        impl ManagedProcessController for ChildController {
            fn id(&self) -> &str {
                self.handle.id()
            }

            fn kind(&self) -> &str {
                self.handle.kind()
            }

            fn start(
                &self,
            ) -> BoxFuture<'_, Result<ManagedProcessStatusSnapshot, ManagedProcessActionError>>
            {
                Box::pin(async move {
                    if let Some(status) = self.handle.begin_start().await? {
                        return Ok(status);
                    }

                    let mut command = Command::new(&self.script_path);
                    command
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null());
                    #[cfg(unix)]
                    command.process_group(0);

                    let child = command.spawn().map_err(|error: std::io::Error| {
                        ManagedProcessActionError::internal(error.to_string())
                    })?;
                    self.handle
                        .finish_running(ManagedProcessRuntime::Child(ManagedChildProcess::new(
                            child,
                        )))
                        .await;
                    self.handle.status().await
                })
            }

            fn stop(
                &self,
            ) -> BoxFuture<'_, Result<ManagedProcessStatusSnapshot, ManagedProcessActionError>>
            {
                Box::pin(async move {
                    match self.handle.begin_stop().await? {
                        ManagedProcessStopTarget::Running(mut runtime) => {
                            runtime.shutdown().await?
                        }
                        ManagedProcessStopTarget::NotRunning => {}
                    }
                    self.handle.finish_stopped().await;
                    self.handle.status().await
                })
            }

            fn restart(
                &self,
            ) -> BoxFuture<'_, Result<ManagedProcessStatusSnapshot, ManagedProcessActionError>>
            {
                Box::pin(async move {
                    self.stop().await?;
                    self.start().await
                })
            }
        }

        let tmp = tempfile::TempDir::new().unwrap();
        let script_path = tmp.path().join("sleep.sh");
        tokio::fs::write(&script_path, "#!/bin/sh\nsleep 1000\n")
            .await
            .unwrap();
        #[cfg(unix)]
        tokio::fs::set_permissions(&script_path, Permissions::from_mode(0o755))
            .await
            .unwrap();

        let state = AppState::new(tmp.path().to_path_buf()).await;
        let handle = state.processes.register_process("worker", "test-worker");
        state
            .processes
            .register_controller(Arc::new(ChildController {
                handle,
                script_path,
            }));
        let app = build_router(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = reqwest::Client::new();
        let start = client
            .post(format!("http://{addr}/api/processes/worker/start"))
            .send()
            .await
            .unwrap();
        assert_eq!(start.status(), StatusCode::OK);

        let response = client
            .get(format!("http://{addr}/api/processes/worker"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["lifecycleState"], "running");
        assert!(body["pid"].as_u64().is_some());
        assert!(body["startedAt"].as_str().is_some());
    }

    #[tokio::test]
    async fn process_api_returns_not_found_for_unknown_id() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = AppState::new(tmp.path().to_path_buf()).await;
        let app = build_router(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let response = reqwest::Client::new()
            .post(format!("http://{addr}/api/processes/missing/start"))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn process_snapshot_and_events_include_managed_processes() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = AppState::new(tmp.path().to_path_buf()).await;
        let mut rx = state.events.subscribe();
        let app = build_router(state.clone());

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let response = reqwest::get(format!("http://{addr}/api/events"))
            .await
            .unwrap();
        let mut stream = response.bytes_stream();
        let first_chunk = stream.next().await.unwrap().unwrap();
        let body = String::from_utf8_lossy(&first_chunk);
        assert!(body.contains("\"managed_processes\""));

        let handle = state.processes.register_process("other", "kind");
        handle.finish_running(ManagedProcessRuntime::External).await;

        let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(event.kind, EventKind::ManagedProcessUpdated(_)));
    }
}
