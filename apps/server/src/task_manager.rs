use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Weak};

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use serde_json::{Map as JsonMap, Value as JsonValue};
use tokio::sync::{Mutex, Semaphore, mpsc};
use uuid::Uuid;

use crate::events::{EventBus, EventKind};
use crate::process_manager::now_timestamp_string;

const FINISHED_TASK_RETENTION: usize = 100;
const TASK_QUEUE_CAPACITY: usize = 128;

pub type TaskInput = JsonMap<String, JsonValue>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStateValue {
    Pending,
    Running,
    Succeeded,
    Failed,
    RollingBack,
    RolledBack,
    RollbackFailed,
}

impl TaskStateValue {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Pending | Self::Running | Self::RollingBack)
    }

    pub fn is_terminal(self) -> bool {
        !self.is_active()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStepStateValue {
    Pending,
    Running,
    Skipped,
    Succeeded,
    Failed,
    RollingBack,
    RolledBack,
    RollbackFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskStepDefinitionSnapshot {
    pub id: String,
    pub title: String,
    pub weight: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskStepStatusSnapshot {
    pub id: String,
    pub name: String,
    pub state: TaskStepStateValue,
    pub progress_percent: u8,
    pub error: Option<String>,
    pub rollback_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskInvocationSnapshot {
    pub id: String,
    pub definition_name: String,
    pub title: String,
    pub status: TaskStateValue,
    pub status_text: Option<String>,
    pub progress_percent: u8,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub scope_key: Option<String>,
    pub failure_message: Option<String>,
    pub broadcast_updates: bool,
    pub steps: Vec<TaskStepStatusSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskDefinitionSnapshot {
    pub name: String,
    pub title: String,
    pub description: Option<String>,
    pub broadcast_updates: bool,
    pub input_fields: Vec<TaskDefinitionInputField>,
    pub steps: Vec<TaskStepDefinitionSnapshot>,
}

/// Stable metadata for a typed task definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskMetadata {
    pub name: String,
    pub title: String,
    pub description: Option<String>,
    pub broadcast_updates: bool,
    pub input_fields: Vec<TaskDefinitionInputField>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskDefinitionInputField {
    pub name: String,
    pub title: String,
    pub description: Option<String>,
    pub required: bool,
    pub kind: TaskInputFieldKind,
    pub enum_values: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskInputFieldKind {
    String,
    Boolean,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskUpdatedEvent {
    pub task: TaskInvocationSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRemovedEvent {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskActionError {
    kind: TaskActionErrorKind,
    message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskActionErrorKind {
    NotFound,
    InvalidRequest,
    Conflict,
    Internal,
}

impl TaskActionError {
    pub fn new(kind: TaskActionErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn kind(&self) -> TaskActionErrorKind {
        self.kind
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn not_found(name: &str) -> Self {
        Self::new(
            TaskActionErrorKind::NotFound,
            format!("unknown task definition: {name}"),
        )
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(TaskActionErrorKind::InvalidRequest, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(TaskActionErrorKind::Conflict, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(TaskActionErrorKind::Internal, message)
    }
}

impl fmt::Display for TaskActionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TaskActionError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskExecutionError {
    message: String,
}

impl TaskExecutionError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    fn panic(stage: impl Into<String>) -> Self {
        Self::new(format!("task execution panicked during {}", stage.into()))
    }
}

impl fmt::Display for TaskExecutionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TaskExecutionError {}

/// The result of running one declared task step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStepResult {
    Completed,
    Skipped,
}

/// Async state initialization for a typed task invocation.
pub type TaskStateInitFuture<'a, S> = BoxFuture<'a, Result<S, TaskExecutionError>>;
/// Async finalization hook for a typed task invocation.
pub type TaskFinalizeFuture<'a> = BoxFuture<'a, ()>;
/// Async forward action result for a typed task step.
pub type TaskTypeStepRunFuture<'a> = BoxFuture<'a, Result<TaskStepResult, TaskExecutionError>>;
/// Async rollback action result for a typed task step.
pub type TaskTypeStepRollbackFuture<'a> = BoxFuture<'a, Result<(), TaskExecutionError>>;
/// Forward action signature for a typed task step.
pub type TaskTypeStepRunFn<S> = for<'a> fn(&'a mut S, TaskStepContext) -> TaskTypeStepRunFuture<'a>;
/// Rollback action signature for a typed task step.
pub type TaskTypeStepRollbackFn<S> =
    for<'a> fn(&'a mut S, TaskStepContext) -> TaskTypeStepRollbackFuture<'a>;

/// A stable declared step for a typed task.
pub struct TaskTypeStep<S> {
    id: &'static str,
    title: &'static str,
    weight: u8,
    run: TaskTypeStepRunFn<S>,
    rollback: Option<TaskTypeStepRollbackFn<S>>,
}

impl<S> TaskTypeStep<S> {
    /// Create a stable typed step definition with its forward action.
    pub const fn new(
        id: &'static str,
        title: &'static str,
        weight: u8,
        run: TaskTypeStepRunFn<S>,
    ) -> Self {
        Self {
            id,
            title,
            weight,
            run,
            rollback: None,
        }
    }

    /// Attach rollback logic for this step.
    pub const fn with_rollback(mut self, rollback: TaskTypeStepRollbackFn<S>) -> Self {
        self.rollback = Some(rollback);
        self
    }

    fn definition_snapshot(&self) -> TaskStepDefinitionSnapshot {
        TaskStepDefinitionSnapshot {
            id: self.id.to_string(),
            title: self.title.to_string(),
            weight: self.weight.max(1),
        }
    }
}

/// A reusable typed task definition with input parsing, state init, and steps.
pub trait TaskType: Send + Sync + 'static {
    type Input: Send + 'static;
    type State: Send + 'static;

    fn metadata(&self) -> TaskMetadata;

    fn parse_input(&self, input: &TaskInput) -> Result<Self::Input, TaskActionError>;

    fn scope_key(&self, input: &Self::Input) -> Result<Option<String>, TaskActionError>;

    fn init<'a>(&'a self, input: Self::Input) -> TaskStateInitFuture<'a, Self::State>;

    fn steps(&self) -> &'static [TaskTypeStep<Self::State>];

    fn finalize<'a>(
        &'a self,
        _state: &'a mut Self::State,
        _final_status: TaskStateValue,
    ) -> TaskFinalizeFuture<'a> {
        Box::pin(async {})
    }
}

#[derive(Clone)]
pub struct TaskService {
    inner: Arc<TaskServiceInner>,
    backend: Arc<dyn TaskBackend>,
}

struct TaskServiceInner {
    events: Arc<EventBus>,
    registry: TaskRegistry,
    invocations: std::sync::RwLock<HashMap<String, Arc<TaskInvocationSlot>>>,
    order: std::sync::RwLock<VecDeque<String>>,
    active_scopes: std::sync::RwLock<HashMap<String, String>>,
}

struct TaskRegistry {
    definitions: std::sync::RwLock<HashMap<String, Arc<dyn RegisteredTask>>>,
}

struct TaskInvocationSlot {
    definition_name: String,
    title: String,
    broadcast_updates: bool,
    created_at: String,
    state: Mutex<TaskInvocationRuntimeState>,
}

struct TaskInvocationRuntimeState {
    status: TaskStateValue,
    status_text: Option<String>,
    progress_percent: u8,
    started_at: Option<String>,
    finished_at: Option<String>,
    scope_key: Option<String>,
    failure_message: Option<String>,
    steps: Vec<TaskStepRuntimeState>,
}

#[derive(Clone)]
struct TaskStepRuntimeState {
    id: String,
    name: String,
    weight: u8,
    state: TaskStepStateValue,
    progress_percent: u8,
    error: Option<String>,
    rollback_error: Option<String>,
}

#[derive(Clone)]
struct TaskInvocationHandle {
    task_id: String,
    slot: Arc<TaskInvocationSlot>,
    service: Weak<TaskServiceInner>,
}

#[derive(Clone)]
pub struct TaskStepContext {
    handle: TaskInvocationHandle,
    step_index: usize,
}

struct PreparedTaskInvocation {
    scope_key: Option<String>,
    instance: Box<dyn TaskExecutionInstance>,
}

trait RegisteredTask: Send + Sync {
    fn metadata(&self) -> &TaskDefinitionSnapshot;
    fn prepare(&self, input: TaskInput) -> Result<PreparedTaskInvocation, TaskActionError>;
}

trait TaskExecutionInstance: Send {
    fn step_definitions(&self) -> &[TaskStepDefinitionSnapshot];

    fn init<'a>(&'a mut self) -> BoxFuture<'a, Result<(), TaskExecutionError>>;

    fn run_step<'a>(
        &'a mut self,
        step_index: usize,
        context: TaskStepContext,
    ) -> BoxFuture<'a, Result<TaskStepResult, TaskExecutionError>>;

    fn has_rollback(&self, step_index: usize) -> bool;

    fn rollback_step<'a>(
        &'a mut self,
        step_index: usize,
        context: TaskStepContext,
    ) -> BoxFuture<'a, Result<(), TaskExecutionError>>;

    fn finalize<'a>(&'a mut self, final_status: TaskStateValue) -> BoxFuture<'a, ()>;
}

struct TypedTaskRegistration<T: TaskType> {
    task: Arc<T>,
    metadata: TaskDefinitionSnapshot,
    step_definitions: Arc<Vec<TaskStepDefinitionSnapshot>>,
}

struct TypedTaskExecution<T: TaskType> {
    task: Arc<T>,
    step_definitions: Arc<Vec<TaskStepDefinitionSnapshot>>,
    steps: &'static [TaskTypeStep<T::State>],
    input: Option<T::Input>,
    state: Option<T::State>,
}

struct QueuedInvocation {
    handle: TaskInvocationHandle,
    instance: Box<dyn TaskExecutionInstance>,
}

trait TaskBackend: Send + Sync {
    fn enqueue(
        &self,
        invocation: QueuedInvocation,
    ) -> BoxFuture<'static, Result<(), TaskActionError>>;
}

#[derive(Clone)]
struct InMemoryTaskBackend {
    sender: mpsc::Sender<QueuedInvocation>,
}

#[derive(Clone, Default)]
struct TaskExecutor;

#[derive(Clone, Copy)]
struct TaskServiceOptions {
    queue_capacity: usize,
    max_concurrency: usize,
}

impl Default for TaskServiceOptions {
    fn default() -> Self {
        let max_concurrency = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(4)
            .clamp(1, 8);
        Self {
            queue_capacity: TASK_QUEUE_CAPACITY,
            max_concurrency,
        }
    }
}

impl TaskRegistry {
    fn new() -> Self {
        Self {
            definitions: std::sync::RwLock::new(HashMap::new()),
        }
    }

    fn register_typed_task<T>(&self, task: T)
    where
        T: TaskType,
    {
        let task = Arc::new(task);
        let task_metadata = task.metadata();
        let steps = task.steps();
        assert_unique_step_ids(task_metadata.name.as_str(), steps);

        let step_definitions = Arc::new(
            steps
                .iter()
                .map(TaskTypeStep::definition_snapshot)
                .collect::<Vec<_>>(),
        );
        let metadata = build_definition_snapshot(task_metadata, step_definitions.as_slice());

        let mut definitions = self.definitions.write().expect("task definitions poisoned");
        assert!(
            !definitions.contains_key(&metadata.name),
            "typed task {} is registered more than once",
            metadata.name
        );

        definitions.insert(
            metadata.name.clone(),
            Arc::new(TypedTaskRegistration::<T> {
                task,
                metadata,
                step_definitions,
            }),
        );
    }

    fn get(&self, name: &str) -> Result<Arc<dyn RegisteredTask>, TaskActionError> {
        self.definitions
            .read()
            .expect("task definitions poisoned")
            .get(name)
            .cloned()
            .ok_or_else(|| TaskActionError::not_found(name))
    }

    fn list(&self) -> Vec<TaskDefinitionSnapshot> {
        let mut definitions = self
            .definitions
            .read()
            .expect("task definitions poisoned")
            .values()
            .map(|definition| definition.metadata().clone())
            .collect::<Vec<_>>();
        definitions.sort_by(|a, b| a.name.cmp(&b.name));
        definitions
    }
}

impl<T> RegisteredTask for TypedTaskRegistration<T>
where
    T: TaskType,
{
    fn metadata(&self) -> &TaskDefinitionSnapshot {
        &self.metadata
    }

    fn prepare(&self, input: TaskInput) -> Result<PreparedTaskInvocation, TaskActionError> {
        let parsed = self.task.parse_input(&input)?;
        let scope_key = self.task.scope_key(&parsed)?;
        Ok(PreparedTaskInvocation {
            scope_key,
            instance: Box::new(TypedTaskExecution::<T> {
                task: self.task.clone(),
                step_definitions: self.step_definitions.clone(),
                steps: self.task.steps(),
                input: Some(parsed),
                state: None,
            }),
        })
    }
}

impl<T> TaskExecutionInstance for TypedTaskExecution<T>
where
    T: TaskType,
{
    fn step_definitions(&self) -> &[TaskStepDefinitionSnapshot] {
        self.step_definitions.as_slice()
    }

    fn init<'a>(&'a mut self) -> BoxFuture<'a, Result<(), TaskExecutionError>> {
        Box::pin(async move {
            let input = self
                .input
                .take()
                .ok_or_else(|| TaskExecutionError::new("missing task input"))?;
            let state = self.task.init(input).await?;
            self.state = Some(state);
            Ok(())
        })
    }

    fn run_step<'a>(
        &'a mut self,
        step_index: usize,
        context: TaskStepContext,
    ) -> BoxFuture<'a, Result<TaskStepResult, TaskExecutionError>> {
        Box::pin(async move {
            let state = self
                .state
                .as_mut()
                .ok_or_else(|| TaskExecutionError::new("task state is not initialized"))?;
            (self.steps[step_index].run)(state, context).await
        })
    }

    fn has_rollback(&self, step_index: usize) -> bool {
        self.steps[step_index].rollback.is_some()
    }

    fn rollback_step<'a>(
        &'a mut self,
        step_index: usize,
        context: TaskStepContext,
    ) -> BoxFuture<'a, Result<(), TaskExecutionError>> {
        Box::pin(async move {
            let state = self
                .state
                .as_mut()
                .ok_or_else(|| TaskExecutionError::new("task state is not initialized"))?;
            let Some(rollback) = self.steps[step_index].rollback else {
                return Ok(());
            };
            rollback(state, context).await
        })
    }

    fn finalize<'a>(&'a mut self, final_status: TaskStateValue) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let Some(state) = self.state.as_mut() else {
                return;
            };
            self.task.finalize(state, final_status).await;
        })
    }
}

impl InMemoryTaskBackend {
    fn new(executor: TaskExecutor, options: TaskServiceOptions) -> Self {
        let (sender, mut receiver) = mpsc::channel::<QueuedInvocation>(options.queue_capacity);
        let semaphore = Arc::new(Semaphore::new(options.max_concurrency.max(1)));

        tokio::spawn(async move {
            while let Some(invocation) = receiver.recv().await {
                let permit = semaphore.clone().acquire_owned().await.unwrap();
                let handle = invocation.handle.clone();
                let executor = executor.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let result = AssertUnwindSafe(executor.run_invocation(invocation))
                        .catch_unwind()
                        .await;
                    if result.is_err() {
                        tracing::error!(
                            task_id = %handle.task_id,
                            "task executor panicked outside task supervision"
                        );
                        handle
                            .finish_terminal(
                                TaskStateValue::Failed,
                                Some("task execution panicked".to_string()),
                                Some("task execution panicked".to_string()),
                            )
                            .await;
                    }
                });
            }
        });

        Self { sender }
    }
}

impl TaskBackend for InMemoryTaskBackend {
    fn enqueue(
        &self,
        invocation: QueuedInvocation,
    ) -> BoxFuture<'static, Result<(), TaskActionError>> {
        let sender = self.sender.clone();
        Box::pin(async move {
            sender
                .send(invocation)
                .await
                .map_err(|_| TaskActionError::internal("task queue is not accepting jobs"))
        })
    }
}

impl TaskExecutor {
    async fn run_invocation(&self, invocation: QueuedInvocation) {
        let QueuedInvocation {
            handle,
            mut instance,
        } = invocation;

        handle.mark_started().await;

        let init_result = catch_task_stage("init", instance.init()).await;
        if let Err(error) = init_result {
            handle
                .finish_terminal(
                    TaskStateValue::Failed,
                    Some(error.message().to_string()),
                    Some(error.message().to_string()),
                )
                .await;
            finalize_instance_best_effort(&mut *instance, TaskStateValue::Failed).await;
            return;
        }

        let final_status = match self.execute_steps(&handle, &mut *instance).await {
            Ok(()) => {
                handle
                    .finish_terminal(
                        TaskStateValue::Succeeded,
                        None,
                        Some("Completed".to_string()),
                    )
                    .await;
                TaskStateValue::Succeeded
            }
            Err((error, status)) => {
                handle
                    .finish_terminal(
                        status,
                        Some(error.message().to_string()),
                        Some(error.message().to_string()),
                    )
                    .await;
                status
            }
        };

        finalize_instance_best_effort(&mut *instance, final_status).await;
    }

    async fn execute_steps(
        &self,
        handle: &TaskInvocationHandle,
        instance: &mut dyn TaskExecutionInstance,
    ) -> Result<(), (TaskExecutionError, TaskStateValue)> {
        let mut completed_steps = Vec::new();
        let step_definitions = instance.step_definitions().to_vec();

        for (step_index, step) in step_definitions.iter().enumerate() {
            handle.mark_step_running(step_index).await;
            let context = TaskStepContext {
                handle: handle.clone(),
                step_index,
            };

            let result = catch_task_stage(
                format!("step {}", step.id),
                instance.run_step(step_index, context),
            )
            .await;

            match result {
                Ok(TaskStepResult::Completed) => {
                    completed_steps.push(step_index);
                    handle.mark_step_succeeded(step_index).await;
                }
                Ok(TaskStepResult::Skipped) => {
                    handle.mark_step_skipped(step_index).await;
                }
                Err(error) => {
                    handle
                        .mark_step_failed(step_index, error.message().to_string())
                        .await;
                    let rollback_status = self
                        .rollback_after_failure(
                            handle,
                            instance,
                            &step_definitions,
                            completed_steps,
                            &error,
                        )
                        .await;
                    return Err((error, rollback_status));
                }
            }
        }

        Ok(())
    }

    async fn rollback_after_failure(
        &self,
        handle: &TaskInvocationHandle,
        instance: &mut dyn TaskExecutionInstance,
        step_definitions: &[TaskStepDefinitionSnapshot],
        completed_steps: Vec<usize>,
        error: &TaskExecutionError,
    ) -> TaskStateValue {
        let rollback_steps = completed_steps
            .into_iter()
            .rev()
            .filter(|step_index| instance.has_rollback(*step_index))
            .collect::<Vec<_>>();

        if rollback_steps.is_empty() {
            return TaskStateValue::Failed;
        }

        handle.mark_rolling_back(error.message()).await;

        let mut rollback_failed = false;
        for step_index in rollback_steps {
            let step_id = step_definitions[step_index].id.clone();
            handle.mark_step_rolling_back(step_index).await;
            let context = TaskStepContext {
                handle: handle.clone(),
                step_index,
            };
            match catch_task_stage(
                format!("rollback step {}", step_id),
                instance.rollback_step(step_index, context),
            )
            .await
            {
                Ok(()) => handle.mark_step_rolled_back(step_index).await,
                Err(rollback_error) => {
                    rollback_failed = true;
                    handle
                        .mark_step_rollback_failed(step_index, rollback_error.message().to_string())
                        .await;
                }
            }
        }

        if rollback_failed {
            TaskStateValue::RollbackFailed
        } else {
            TaskStateValue::RolledBack
        }
    }
}

impl TaskService {
    pub fn new(events: Arc<EventBus>) -> Self {
        Self::new_with_options(events, TaskServiceOptions::default())
    }

    fn new_with_options(events: Arc<EventBus>, options: TaskServiceOptions) -> Self {
        let inner = Arc::new(TaskServiceInner {
            events,
            registry: TaskRegistry::new(),
            invocations: std::sync::RwLock::new(HashMap::new()),
            order: std::sync::RwLock::new(VecDeque::new()),
            active_scopes: std::sync::RwLock::new(HashMap::new()),
        });
        let backend: Arc<dyn TaskBackend> =
            Arc::new(InMemoryTaskBackend::new(TaskExecutor, options));
        Self::new_with_backend(inner, backend)
    }

    fn new_with_backend(inner: Arc<TaskServiceInner>, backend: Arc<dyn TaskBackend>) -> Self {
        Self { inner, backend }
    }

    pub fn register_typed_task<T>(&self, task: T)
    where
        T: TaskType,
    {
        self.inner.registry.register_typed_task(task);
    }

    pub fn list_definitions(&self) -> Vec<TaskDefinitionSnapshot> {
        self.inner.registry.list()
    }

    pub async fn list(&self) -> Vec<TaskInvocationSnapshot> {
        let order = self
            .inner
            .order
            .read()
            .expect("task order poisoned")
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        let slots = self
            .inner
            .invocations
            .read()
            .expect("task invocations poisoned")
            .clone();
        let mut snapshots = Vec::with_capacity(order.len());
        for id in order {
            let Some(slot) = slots.get(&id) else {
                continue;
            };
            snapshots.push(snapshot_for_slot(&id, slot).await);
        }
        snapshots
    }

    pub async fn list_broadcastable(&self) -> Vec<TaskInvocationSnapshot> {
        self.list()
            .await
            .into_iter()
            .filter(|task| task.broadcast_updates)
            .collect()
    }

    pub async fn get(&self, id: &str) -> Result<TaskInvocationSnapshot, TaskActionError> {
        let slot = self
            .inner
            .invocations
            .read()
            .expect("task invocations poisoned")
            .get(id)
            .cloned()
            .ok_or_else(|| {
                TaskActionError::new(
                    TaskActionErrorKind::NotFound,
                    format!("unknown task invocation: {id}"),
                )
            })?;
        Ok(snapshot_for_slot(id, &slot).await)
    }

    pub async fn start(
        &self,
        definition_name: &str,
        input: TaskInput,
    ) -> Result<TaskInvocationSnapshot, TaskActionError> {
        let definition = self.inner.registry.get(definition_name)?;
        let prepared = definition.prepare(input)?;
        let metadata = definition.metadata().clone();
        let task_id = Uuid::new_v4().to_string();

        if let Some(scope_key) = prepared.scope_key.as_deref() {
            let maybe_existing = {
                let mut scopes = self
                    .inner
                    .active_scopes
                    .write()
                    .expect("task scopes poisoned");
                match scopes.get(scope_key).cloned() {
                    Some(existing_id) => Some(existing_id),
                    None => {
                        scopes.insert(scope_key.to_string(), task_id.clone());
                        None
                    }
                }
            };
            if let Some(existing_id) = maybe_existing {
                let snapshot = self.get(&existing_id).await?;
                if snapshot.definition_name == definition_name {
                    return Ok(snapshot);
                }
                return Err(TaskActionError::conflict(format!(
                    "task scope {scope_key} is already busy with {} ({existing_id})",
                    snapshot.definition_name
                )));
            }
        }

        let slot = Arc::new(TaskInvocationSlot {
            definition_name: metadata.name.clone(),
            title: metadata.title.clone(),
            broadcast_updates: metadata.broadcast_updates,
            created_at: now_timestamp_string(),
            state: Mutex::new(TaskInvocationRuntimeState {
                status: TaskStateValue::Pending,
                status_text: None,
                progress_percent: 0,
                started_at: None,
                finished_at: None,
                scope_key: prepared.scope_key.clone(),
                failure_message: None,
                steps: build_runtime_steps(metadata.steps.as_slice()),
            }),
        });

        let handle = TaskInvocationHandle {
            task_id: task_id.clone(),
            slot: slot.clone(),
            service: Arc::downgrade(&self.inner),
        };

        self.inner
            .invocations
            .write()
            .expect("task invocations poisoned")
            .insert(task_id.clone(), slot.clone());
        self.inner
            .order
            .write()
            .expect("task order poisoned")
            .push_front(task_id.clone());

        let enqueue_result = self
            .backend
            .enqueue(QueuedInvocation {
                handle: handle.clone(),
                instance: prepared.instance,
            })
            .await;

        if let Err(error) = enqueue_result {
            self.cleanup_failed_start(&task_id, prepared.scope_key.as_deref())
                .await;
            return Err(error);
        }
        handle.emit_update().await;

        self.get(&task_id).await
    }

    pub async fn active_invocation_for_scope(
        &self,
        scope_key: &str,
    ) -> Option<TaskInvocationSnapshot> {
        let id = self
            .inner
            .active_scopes
            .read()
            .expect("task scopes poisoned")
            .get(scope_key)
            .cloned()?;
        self.get(&id).await.ok()
    }

    async fn cleanup_failed_start(&self, task_id: &str, scope_key: Option<&str>) {
        self.inner
            .invocations
            .write()
            .expect("task invocations poisoned")
            .remove(task_id);

        if let Some(index) = self
            .inner
            .order
            .write()
            .expect("task order poisoned")
            .iter()
            .position(|candidate| candidate == task_id)
        {
            self.inner
                .order
                .write()
                .expect("task order poisoned")
                .remove(index);
        }

        if let Some(scope_key) = scope_key {
            let mut scopes = self
                .inner
                .active_scopes
                .write()
                .expect("task scopes poisoned");
            if scopes
                .get(scope_key)
                .is_some_and(|active_task_id| active_task_id == task_id)
            {
                scopes.remove(scope_key);
            }
        }
    }
}

impl TaskInvocationHandle {
    async fn mark_started(&self) {
        {
            let mut state = self.slot.state.lock().await;
            state.status = TaskStateValue::Running;
            state.started_at = Some(now_timestamp_string());
            if state.status_text.is_none() {
                state.status_text = Some("Starting".to_string());
            }
        }
        self.emit_update().await;
    }

    async fn finish_terminal(
        &self,
        status: TaskStateValue,
        failure_message: Option<String>,
        status_text: Option<String>,
    ) {
        let should_finalize = {
            let mut state = self.slot.state.lock().await;
            if state.status.is_terminal() {
                false
            } else {
                state.status = status;
                state.failure_message = failure_message;
                if matches!(status, TaskStateValue::Succeeded) {
                    state.progress_percent = 100;
                }
                if let Some(status_text) = status_text {
                    state.status_text = Some(status_text);
                } else if matches!(status, TaskStateValue::Succeeded) && state.status_text.is_none()
                {
                    state.status_text = Some("Completed".to_string());
                }
                state.finished_at = Some(now_timestamp_string());
                true
            }
        };

        if should_finalize {
            self.release_scope().await;
            self.emit_update().await;
            self.evict_finished_tasks().await;
        }
    }

    async fn mark_rolling_back(&self, error: &str) {
        {
            let mut state = self.slot.state.lock().await;
            state.status = TaskStateValue::RollingBack;
            state.failure_message = Some(error.to_string());
            state.status_text = Some(error.to_string());
        }
        self.emit_update().await;
    }

    async fn mark_step_running(&self, step_index: usize) {
        {
            let mut state = self.slot.state.lock().await;
            state.steps[step_index].state = TaskStepStateValue::Running;
            state.steps[step_index].progress_percent = 0;
            state.status = TaskStateValue::Running;
            state.progress_percent = weighted_progress(&state.steps);
            state.status_text = Some(state.steps[step_index].name.clone());
        }
        self.emit_update().await;
    }

    async fn mark_step_skipped(&self, step_index: usize) {
        {
            let mut state = self.slot.state.lock().await;
            state.steps[step_index].state = TaskStepStateValue::Skipped;
            state.steps[step_index].progress_percent = 100;
            state.progress_percent = weighted_progress(&state.steps);
        }
        self.emit_update().await;
    }

    async fn mark_step_succeeded(&self, step_index: usize) {
        {
            let mut state = self.slot.state.lock().await;
            state.steps[step_index].state = TaskStepStateValue::Succeeded;
            state.steps[step_index].progress_percent = 100;
            state.progress_percent = weighted_progress(&state.steps);
        }
        self.emit_update().await;
    }

    async fn mark_step_failed(&self, step_index: usize, error: String) {
        {
            let mut state = self.slot.state.lock().await;
            state.steps[step_index].state = TaskStepStateValue::Failed;
            state.steps[step_index].error = Some(error);
            state.progress_percent = weighted_progress(&state.steps);
        }
        self.emit_update().await;
    }

    async fn mark_step_rolling_back(&self, step_index: usize) {
        {
            let mut state = self.slot.state.lock().await;
            state.steps[step_index].state = TaskStepStateValue::RollingBack;
        }
        self.emit_update().await;
    }

    async fn mark_step_rolled_back(&self, step_index: usize) {
        {
            let mut state = self.slot.state.lock().await;
            state.steps[step_index].state = TaskStepStateValue::RolledBack;
        }
        self.emit_update().await;
    }

    async fn mark_step_rollback_failed(&self, step_index: usize, error: String) {
        {
            let mut state = self.slot.state.lock().await;
            state.steps[step_index].state = TaskStepStateValue::RollbackFailed;
            state.steps[step_index].rollback_error = Some(error);
        }
        self.emit_update().await;
    }

    async fn set_status_text(&self, status_text: impl Into<String>) {
        {
            let mut state = self.slot.state.lock().await;
            state.status_text = Some(status_text.into());
        }
        self.emit_update().await;
    }

    async fn clear_status_text(&self) {
        {
            let mut state = self.slot.state.lock().await;
            state.status_text = None;
        }
        self.emit_update().await;
    }

    async fn set_progress_absolute(&self, progress_percent: u8) {
        {
            let mut state = self.slot.state.lock().await;
            state.progress_percent = progress_percent.min(100);
        }
        self.emit_update().await;
    }

    async fn update_step_progress(&self, step_index: usize, progress_percent: u8) {
        {
            let mut state = self.slot.state.lock().await;
            state.steps[step_index].progress_percent = progress_percent.min(100);
            state.progress_percent = weighted_progress(&state.steps);
        }
        self.emit_update().await;
    }

    async fn emit_update(&self) {
        let Some(service) = self.service.upgrade() else {
            return;
        };
        let snapshot = snapshot_for_slot(&self.task_id, &self.slot).await;
        if snapshot.broadcast_updates {
            service.events.emit(EventKind::TaskUpdated(Box::new(
                TaskUpdatedEvent { task: snapshot }.into(),
            )));
        }
    }

    async fn release_scope(&self) {
        let scope_key = {
            let state = self.slot.state.lock().await;
            state.scope_key.clone()
        };
        let Some(scope_key) = scope_key else {
            return;
        };
        let Some(service) = self.service.upgrade() else {
            return;
        };
        let mut scopes = service.active_scopes.write().expect("task scopes poisoned");
        if scopes
            .get(&scope_key)
            .is_some_and(|task_id| task_id == &self.task_id)
        {
            scopes.remove(&scope_key);
        }
    }

    async fn evict_finished_tasks(&self) {
        let Some(service) = self.service.upgrade() else {
            return;
        };

        let removable_ids = {
            let order = service.order.read().expect("task order poisoned");
            let invocations = service
                .invocations
                .read()
                .expect("task invocations poisoned");
            let mut finished_ids = order
                .iter()
                .rev()
                .filter_map(|id| {
                    let slot = invocations.get(id)?;
                    let state = slot.state.try_lock().ok()?;
                    if state.status.is_terminal() {
                        Some(id.clone())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();
            if finished_ids.len() <= FINISHED_TASK_RETENTION {
                return;
            }
            finished_ids.truncate(finished_ids.len() - FINISHED_TASK_RETENTION);
            finished_ids
        };

        if removable_ids.is_empty() {
            return;
        }

        let mut invocations = service
            .invocations
            .write()
            .expect("task invocations poisoned");
        let mut order = service.order.write().expect("task order poisoned");
        for task_id in removable_ids {
            let broadcast_updates = invocations
                .remove(&task_id)
                .is_some_and(|slot| slot.broadcast_updates);
            if let Some(index) = order.iter().position(|candidate| candidate == &task_id) {
                order.remove(index);
            }
            if broadcast_updates {
                service.events.emit(EventKind::TaskRemoved(Box::new(
                    TaskRemovedEvent { id: task_id }.into(),
                )));
            }
        }
    }
}

impl TaskStepContext {
    pub async fn set_status_text(&self, status_text: impl Into<String>) {
        self.handle.set_status_text(status_text).await;
    }

    pub async fn clear_status_text(&self) {
        self.handle.clear_status_text().await;
    }

    pub async fn set_progress_absolute(&self, progress_percent: u8) {
        self.handle.set_progress_absolute(progress_percent).await;
    }

    pub async fn set_step_progress(&self, progress_percent: u8) {
        self.handle
            .update_step_progress(self.step_index, progress_percent)
            .await;
    }
}

fn build_definition_snapshot(
    metadata: TaskMetadata,
    steps: &[TaskStepDefinitionSnapshot],
) -> TaskDefinitionSnapshot {
    TaskDefinitionSnapshot {
        name: metadata.name,
        title: metadata.title,
        description: metadata.description,
        broadcast_updates: metadata.broadcast_updates,
        input_fields: metadata.input_fields,
        steps: steps.to_vec(),
    }
}

fn build_runtime_steps(steps: &[TaskStepDefinitionSnapshot]) -> Vec<TaskStepRuntimeState> {
    steps
        .iter()
        .map(|step| TaskStepRuntimeState {
            id: step.id.clone(),
            name: step.title.clone(),
            weight: step.weight.max(1),
            state: TaskStepStateValue::Pending,
            progress_percent: 0,
            error: None,
            rollback_error: None,
        })
        .collect()
}

fn assert_unique_step_ids<S>(task_name: &str, steps: &[TaskTypeStep<S>]) {
    let mut ids = HashSet::new();
    for step in steps {
        assert!(
            ids.insert(step.id),
            "typed task {task_name} declared duplicate step id {}",
            step.id
        );
    }
}

async fn catch_task_stage<T, F>(
    stage: impl Into<String>,
    future: F,
) -> Result<T, TaskExecutionError>
where
    F: Future<Output = Result<T, TaskExecutionError>> + Send,
{
    let stage = stage.into();
    match AssertUnwindSafe(future).catch_unwind().await {
        Ok(result) => result,
        Err(payload) => {
            tracing::error!(
                stage = %stage,
                panic = %panic_payload_to_string(payload),
                "task stage panicked"
            );
            Err(TaskExecutionError::panic(stage))
        }
    }
}

async fn finalize_instance_best_effort(
    instance: &mut dyn TaskExecutionInstance,
    final_status: TaskStateValue,
) {
    match AssertUnwindSafe(instance.finalize(final_status))
        .catch_unwind()
        .await
    {
        Ok(()) => {}
        Err(payload) => {
            tracing::error!(
                panic = %panic_payload_to_string(payload),
                "task finalizer panicked"
            );
        }
    }
}

fn panic_payload_to_string(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&'static str>() {
        return (*message).to_string();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "unknown panic payload".to_string()
}

async fn snapshot_for_slot(task_id: &str, slot: &TaskInvocationSlot) -> TaskInvocationSnapshot {
    let state = slot.state.lock().await;
    TaskInvocationSnapshot {
        id: task_id.to_string(),
        definition_name: slot.definition_name.clone(),
        title: slot.title.clone(),
        status: state.status,
        status_text: state.status_text.clone(),
        progress_percent: state.progress_percent,
        created_at: slot.created_at.clone(),
        started_at: state.started_at.clone(),
        finished_at: state.finished_at.clone(),
        scope_key: state.scope_key.clone(),
        failure_message: state.failure_message.clone(),
        broadcast_updates: slot.broadcast_updates,
        steps: state
            .steps
            .iter()
            .map(|step| TaskStepStatusSnapshot {
                id: step.id.clone(),
                name: step.name.clone(),
                state: step.state,
                progress_percent: step.progress_percent,
                error: step.error.clone(),
                rollback_error: step.rollback_error.clone(),
            })
            .collect(),
    }
}

fn weighted_progress(steps: &[TaskStepRuntimeState]) -> u8 {
    let total_weight = steps
        .iter()
        .map(|step| u32::from(step.weight.max(1)))
        .sum::<u32>()
        .max(1);
    let weighted = steps
        .iter()
        .map(|step| u32::from(step.weight.max(1)) * u32::from(step.progress_percent.min(100)))
        .sum::<u32>();
    ((weighted / total_weight).min(100)) as u8
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use super::*;
    use crate::{AppState, build_router};
    use futures_util::StreamExt;
    use tokio::sync::Notify;

    #[derive(Clone)]
    struct DemoTask {
        name: &'static str,
        behavior: DemoBehavior,
        scope_key: Option<&'static str>,
        broadcast_updates: bool,
    }

    #[derive(Clone)]
    enum DemoBehavior {
        WeightedProgress,
        Rollback {
            order: Arc<Mutex<Vec<&'static str>>>,
        },
        WaitForNotify {
            notify: Arc<Notify>,
        },
        PanicInit,
        PanicRun,
        PanicRollback,
        PanicFinalize {
            finalized: Arc<AtomicBool>,
        },
    }

    #[derive(Clone, Copy)]
    struct DemoInput {
        skip_prepare: bool,
    }

    struct DemoState {
        behavior: DemoBehavior,
        skip_prepare: bool,
    }

    #[derive(Clone)]
    struct RejectingBackend;

    impl TaskBackend for RejectingBackend {
        fn enqueue(
            &self,
            _invocation: QueuedInvocation,
        ) -> BoxFuture<'static, Result<(), TaskActionError>> {
            Box::pin(async move {
                Err(TaskActionError::internal(
                    "task queue is not accepting jobs",
                ))
            })
        }
    }

    static WEIGHTED_STEPS: &[TaskTypeStep<DemoState>] = &[
        TaskTypeStep::new("prepare", "Prepare", 25, weighted_prepare_step),
        TaskTypeStep::new("download", "Download", 75, weighted_download_step),
    ];

    static ROLLBACK_STEPS: &[TaskTypeStep<DemoState>] = &[
        TaskTypeStep::new("one", "One", 50, rollback_first_step)
            .with_rollback(rollback_first_step_undo),
        TaskTypeStep::new("two", "Two", 50, rollback_second_step)
            .with_rollback(rollback_second_step_undo),
        TaskTypeStep::new("three", "Three", 1, rollback_fail_step),
    ];

    static WAIT_STEPS: &[TaskTypeStep<DemoState>] =
        &[TaskTypeStep::new("wait", "Wait", 100, wait_step)];

    static SINGLE_STEP: &[TaskTypeStep<DemoState>] =
        &[TaskTypeStep::new("run", "Run", 100, single_step)];

    static PANIC_ROLLBACK_STEPS: &[TaskTypeStep<DemoState>] = &[
        TaskTypeStep::new("run", "Run", 50, panic_rollback_run_step)
            .with_rollback(panic_rollback_undo_step),
        TaskTypeStep::new("fail", "Fail", 50, panic_rollback_fail_step),
    ];

    impl TaskType for DemoTask {
        type Input = DemoInput;
        type State = DemoState;

        fn metadata(&self) -> TaskMetadata {
            TaskMetadata {
                name: self.name.to_string(),
                title: self.name.to_string(),
                description: None,
                broadcast_updates: self.broadcast_updates,
                input_fields: vec![TaskDefinitionInputField {
                    name: "skipPrepare".to_string(),
                    title: "Skip Prepare".to_string(),
                    description: None,
                    required: false,
                    kind: TaskInputFieldKind::Boolean,
                    enum_values: vec![],
                }],
            }
        }

        fn parse_input(&self, input: &TaskInput) -> Result<Self::Input, TaskActionError> {
            let skip_prepare = match input.get("skipPrepare") {
                Some(serde_json::Value::Bool(value)) => *value,
                Some(_) => {
                    return Err(TaskActionError::invalid_request(
                        "task input skipPrepare must be a boolean",
                    ));
                }
                None => false,
            };
            Ok(DemoInput { skip_prepare })
        }

        fn scope_key(&self, _input: &Self::Input) -> Result<Option<String>, TaskActionError> {
            Ok(self.scope_key.map(str::to_string))
        }

        fn init<'a>(&'a self, input: Self::Input) -> TaskStateInitFuture<'a, Self::State> {
            let behavior = self.behavior.clone();
            Box::pin(async move {
                if matches!(behavior, DemoBehavior::PanicInit) {
                    panic!("init panic");
                }
                Ok(DemoState {
                    behavior,
                    skip_prepare: input.skip_prepare,
                })
            })
        }

        fn steps(&self) -> &'static [TaskTypeStep<Self::State>] {
            match self.behavior {
                DemoBehavior::WeightedProgress => WEIGHTED_STEPS,
                DemoBehavior::Rollback { .. } => ROLLBACK_STEPS,
                DemoBehavior::WaitForNotify { .. } => WAIT_STEPS,
                DemoBehavior::PanicInit => SINGLE_STEP,
                DemoBehavior::PanicRun => SINGLE_STEP,
                DemoBehavior::PanicRollback => PANIC_ROLLBACK_STEPS,
                DemoBehavior::PanicFinalize { .. } => SINGLE_STEP,
            }
        }

        fn finalize<'a>(
            &'a self,
            state: &'a mut Self::State,
            _final_status: TaskStateValue,
        ) -> TaskFinalizeFuture<'a> {
            Box::pin(async move {
                if let DemoBehavior::PanicFinalize { finalized } = &state.behavior {
                    finalized.store(true, Ordering::Relaxed);
                    panic!("finalize panic");
                }
            })
        }
    }

    fn weighted_prepare_step<'a>(
        state: &'a mut DemoState,
        context: TaskStepContext,
    ) -> TaskTypeStepRunFuture<'a> {
        Box::pin(async move {
            if state.skip_prepare {
                return Ok(TaskStepResult::Skipped);
            }
            context.set_step_progress(100).await;
            Ok(TaskStepResult::Completed)
        })
    }

    fn weighted_download_step<'a>(
        _state: &'a mut DemoState,
        context: TaskStepContext,
    ) -> TaskTypeStepRunFuture<'a> {
        Box::pin(async move {
            context.set_step_progress(50).await;
            context.set_step_progress(100).await;
            Ok(TaskStepResult::Completed)
        })
    }

    fn rollback_first_step<'a>(
        _state: &'a mut DemoState,
        _context: TaskStepContext,
    ) -> TaskTypeStepRunFuture<'a> {
        Box::pin(async move { Ok(TaskStepResult::Completed) })
    }

    fn rollback_second_step<'a>(
        _state: &'a mut DemoState,
        _context: TaskStepContext,
    ) -> TaskTypeStepRunFuture<'a> {
        Box::pin(async move { Ok(TaskStepResult::Completed) })
    }

    fn rollback_fail_step<'a>(
        _state: &'a mut DemoState,
        _context: TaskStepContext,
    ) -> TaskTypeStepRunFuture<'a> {
        Box::pin(async move { Err(TaskExecutionError::new("boom")) })
    }

    fn rollback_first_step_undo<'a>(
        state: &'a mut DemoState,
        _context: TaskStepContext,
    ) -> TaskTypeStepRollbackFuture<'a> {
        Box::pin(async move {
            if let DemoBehavior::Rollback { order } = &state.behavior {
                order.lock().await.push("one");
            }
            Ok(())
        })
    }

    fn rollback_second_step_undo<'a>(
        state: &'a mut DemoState,
        _context: TaskStepContext,
    ) -> TaskTypeStepRollbackFuture<'a> {
        Box::pin(async move {
            if let DemoBehavior::Rollback { order } = &state.behavior {
                order.lock().await.push("two");
            }
            Ok(())
        })
    }

    fn wait_step<'a>(
        state: &'a mut DemoState,
        context: TaskStepContext,
    ) -> TaskTypeStepRunFuture<'a> {
        Box::pin(async move {
            let DemoBehavior::WaitForNotify { notify } = &state.behavior else {
                return Err(TaskExecutionError::new("missing notify"));
            };
            context.set_status_text("Waiting").await;
            notify.notified().await;
            context.set_step_progress(100).await;
            Ok(TaskStepResult::Completed)
        })
    }

    fn single_step<'a>(
        state: &'a mut DemoState,
        context: TaskStepContext,
    ) -> TaskTypeStepRunFuture<'a> {
        Box::pin(async move {
            if matches!(state.behavior, DemoBehavior::PanicRun) {
                panic!("run panic");
            }
            context.set_step_progress(100).await;
            Ok(TaskStepResult::Completed)
        })
    }

    fn panic_rollback_run_step<'a>(
        _state: &'a mut DemoState,
        _context: TaskStepContext,
    ) -> TaskTypeStepRunFuture<'a> {
        Box::pin(async move { Ok(TaskStepResult::Completed) })
    }

    fn panic_rollback_fail_step<'a>(
        _state: &'a mut DemoState,
        _context: TaskStepContext,
    ) -> TaskTypeStepRunFuture<'a> {
        Box::pin(async move { Err(TaskExecutionError::new("boom")) })
    }

    fn panic_rollback_undo_step<'a>(
        _state: &'a mut DemoState,
        _context: TaskStepContext,
    ) -> TaskTypeStepRollbackFuture<'a> {
        Box::pin(async move {
            panic!("rollback panic");
        })
    }

    #[tokio::test]
    async fn runs_steps_and_tracks_weighted_progress() {
        let service = TaskService::new(Arc::new(EventBus::new()));
        service.register_typed_task(DemoTask {
            name: "demo.weighted",
            behavior: DemoBehavior::WeightedProgress,
            scope_key: None,
            broadcast_updates: true,
        });

        let started = service
            .start("demo.weighted", TaskInput::new())
            .await
            .unwrap();
        let snapshot = wait_for_terminal(&service, &started.id).await;
        assert_eq!(snapshot.status, TaskStateValue::Succeeded);
        assert_eq!(snapshot.progress_percent, 100);
        assert_eq!(snapshot.steps[0].state, TaskStepStateValue::Succeeded);
        assert_eq!(snapshot.steps[1].state, TaskStepStateValue::Succeeded);
    }

    #[tokio::test]
    async fn rolls_back_completed_steps_in_reverse_order() {
        let service = TaskService::new(Arc::new(EventBus::new()));
        let order = Arc::new(Mutex::new(Vec::new()));
        service.register_typed_task(DemoTask {
            name: "demo.rollback",
            behavior: DemoBehavior::Rollback {
                order: order.clone(),
            },
            scope_key: None,
            broadcast_updates: true,
        });

        let started = service
            .start("demo.rollback", TaskInput::new())
            .await
            .unwrap();
        let snapshot = wait_for_terminal(&service, &started.id).await;
        assert_eq!(snapshot.status, TaskStateValue::RolledBack);
        assert_eq!(snapshot.steps[0].state, TaskStepStateValue::RolledBack);
        assert_eq!(snapshot.steps[1].state, TaskStepStateValue::RolledBack);
        assert_eq!(snapshot.steps[2].state, TaskStepStateValue::Failed);
        assert_eq!(order.lock().await.as_slice(), ["two", "one"]);
    }

    #[tokio::test]
    async fn dedupes_same_scope_and_conflicts_other_definition() {
        let service = TaskService::new(Arc::new(EventBus::new()));
        let notify = Arc::new(Notify::new());
        service.register_typed_task(DemoTask {
            name: "demo.wait",
            behavior: DemoBehavior::WaitForNotify {
                notify: notify.clone(),
            },
            scope_key: Some("scope:a"),
            broadcast_updates: true,
        });
        service.register_typed_task(DemoTask {
            name: "demo.weighted",
            behavior: DemoBehavior::WeightedProgress,
            scope_key: Some("scope:a"),
            broadcast_updates: true,
        });

        let first = service.start("demo.wait", TaskInput::new()).await.unwrap();
        let deduped = service.start("demo.wait", TaskInput::new()).await.unwrap();
        assert_eq!(first.id, deduped.id);

        let error = service
            .start("demo.weighted", TaskInput::new())
            .await
            .unwrap_err();
        assert_eq!(error.kind(), TaskActionErrorKind::Conflict);

        wait_for_status(&service, &first.id, TaskStateValue::Running).await;
        notify.notify_waiters();
        let _ = wait_for_terminal(&service, &first.id).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_same_definition_starts_dedupe_to_one_invocation() {
        let service = Arc::new(TaskService::new(Arc::new(EventBus::new())));
        let notify = Arc::new(Notify::new());
        service.register_typed_task(DemoTask {
            name: "demo.wait",
            behavior: DemoBehavior::WaitForNotify {
                notify: notify.clone(),
            },
            scope_key: Some("scope:concurrent"),
            broadcast_updates: true,
        });

        let service_a = service.clone();
        let service_b = service.clone();
        let (first, second) = tokio::join!(
            service_a.start("demo.wait", TaskInput::new()),
            service_b.start("demo.wait", TaskInput::new())
        );

        let first = first.unwrap();
        let second = second.unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(service.list().await.len(), 1);

        wait_for_status(&service, &first.id, TaskStateValue::Running).await;
        notify.notify_waiters();
        let _ = wait_for_terminal(&service, &first.id).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_different_definition_starts_conflict_on_same_scope() {
        let service = Arc::new(TaskService::new(Arc::new(EventBus::new())));
        let notify = Arc::new(Notify::new());
        service.register_typed_task(DemoTask {
            name: "demo.wait",
            behavior: DemoBehavior::WaitForNotify {
                notify: notify.clone(),
            },
            scope_key: Some("scope:concurrent"),
            broadcast_updates: true,
        });
        service.register_typed_task(DemoTask {
            name: "demo.weighted",
            behavior: DemoBehavior::WeightedProgress,
            scope_key: Some("scope:concurrent"),
            broadcast_updates: true,
        });

        let service_a = service.clone();
        let service_b = service.clone();
        let (wait_result, weighted_result) = tokio::join!(
            service_a.start("demo.wait", TaskInput::new()),
            service_b.start("demo.weighted", TaskInput::new())
        );

        let started = wait_result.unwrap();
        let error = weighted_result.unwrap_err();
        assert_eq!(error.kind(), TaskActionErrorKind::Conflict);
        assert_eq!(service.list().await.len(), 1);

        wait_for_status(&service, &started.id, TaskStateValue::Running).await;
        notify.notify_waiters();
        let _ = wait_for_terminal(&service, &started.id).await;
    }

    #[tokio::test]
    async fn registers_typed_tasks_and_rejects_invalid_input() {
        let service = TaskService::new(Arc::new(EventBus::new()));
        service.register_typed_task(DemoTask {
            name: "demo.weighted",
            behavior: DemoBehavior::WeightedProgress,
            scope_key: Some("scope:typed"),
            broadcast_updates: true,
        });

        let definition = service
            .list_definitions()
            .into_iter()
            .find(|definition| definition.name == "demo.weighted")
            .unwrap();
        assert_eq!(definition.steps.len(), 2);
        assert_eq!(definition.steps[0].id, "prepare");
        assert_eq!(definition.steps[1].id, "download");

        let mut invalid_input = TaskInput::new();
        invalid_input.insert("skipPrepare".to_string(), serde_json::json!("yes"));
        let error = service
            .start("demo.weighted", invalid_input)
            .await
            .unwrap_err();
        assert_eq!(error.kind(), TaskActionErrorKind::InvalidRequest);
    }

    #[tokio::test]
    async fn typed_tasks_can_skip_declared_steps() {
        let service = TaskService::new(Arc::new(EventBus::new()));
        service.register_typed_task(DemoTask {
            name: "demo.weighted",
            behavior: DemoBehavior::WeightedProgress,
            scope_key: None,
            broadcast_updates: true,
        });

        let mut input = TaskInput::new();
        input.insert("skipPrepare".to_string(), serde_json::json!(true));
        let started = service.start("demo.weighted", input).await.unwrap();
        let snapshot = wait_for_terminal(&service, &started.id).await;

        assert_eq!(snapshot.status, TaskStateValue::Succeeded);
        assert_eq!(snapshot.progress_percent, 100);
        assert_eq!(snapshot.steps[0].id, "prepare");
        assert_eq!(snapshot.steps[0].state, TaskStepStateValue::Skipped);
        assert_eq!(snapshot.steps[1].id, "download");
        assert_eq!(snapshot.steps[1].state, TaskStepStateValue::Succeeded);
    }

    #[tokio::test]
    async fn queued_invocations_stay_pending_until_a_worker_is_available() {
        let service = TaskService::new_with_options(
            Arc::new(EventBus::new()),
            TaskServiceOptions {
                queue_capacity: 8,
                max_concurrency: 1,
            },
        );
        let notify_one = Arc::new(Notify::new());
        let notify_two = Arc::new(Notify::new());
        service.register_typed_task(DemoTask {
            name: "demo.wait-one",
            behavior: DemoBehavior::WaitForNotify {
                notify: notify_one.clone(),
            },
            scope_key: Some("scope:one"),
            broadcast_updates: true,
        });
        service.register_typed_task(DemoTask {
            name: "demo.wait-two",
            behavior: DemoBehavior::WaitForNotify {
                notify: notify_two.clone(),
            },
            scope_key: Some("scope:two"),
            broadcast_updates: true,
        });

        let first = service
            .start("demo.wait-one", TaskInput::new())
            .await
            .unwrap();
        let mut second_input = TaskInput::new();
        second_input.insert("skipPrepare".to_string(), serde_json::json!(false));
        let second = service.start("demo.wait-two", second_input).await.unwrap();

        wait_for_status(&service, &first.id, TaskStateValue::Running).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        let snapshot = service.get(&second.id).await.unwrap();
        assert_eq!(snapshot.status, TaskStateValue::Pending);

        notify_one.notify_waiters();
        let _ = wait_for_terminal(&service, &first.id).await;
        notify_two.notify_waiters();
        let _ = wait_for_terminal(&service, &second.id).await;
    }

    #[tokio::test]
    async fn duplicate_step_ids_fail_registration() {
        #[derive(Clone, Copy)]
        struct DuplicateStepTask;

        struct DuplicateState;

        static DUPLICATE_STEPS: &[TaskTypeStep<DuplicateState>] = &[
            TaskTypeStep::new("dup", "First", 50, duplicate_step),
            TaskTypeStep::new("dup", "Second", 50, duplicate_step),
        ];

        impl TaskType for DuplicateStepTask {
            type Input = DemoInput;
            type State = DuplicateState;

            fn metadata(&self) -> TaskMetadata {
                TaskMetadata {
                    name: "duplicate.steps".to_string(),
                    title: "duplicate.steps".to_string(),
                    description: None,
                    broadcast_updates: true,
                    input_fields: vec![],
                }
            }

            fn parse_input(&self, _input: &TaskInput) -> Result<Self::Input, TaskActionError> {
                Ok(DemoInput {
                    skip_prepare: false,
                })
            }

            fn scope_key(&self, _input: &Self::Input) -> Result<Option<String>, TaskActionError> {
                Ok(None)
            }

            fn init<'a>(&'a self, _input: Self::Input) -> TaskStateInitFuture<'a, Self::State> {
                Box::pin(async move { Ok(DuplicateState) })
            }

            fn steps(&self) -> &'static [TaskTypeStep<Self::State>] {
                DUPLICATE_STEPS
            }
        }

        fn duplicate_step<'a>(
            _state: &'a mut DuplicateState,
            _context: TaskStepContext,
        ) -> TaskTypeStepRunFuture<'a> {
            Box::pin(async move { Ok(TaskStepResult::Completed) })
        }

        let service = TaskService::new(Arc::new(EventBus::new()));
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            service.register_typed_task(DuplicateStepTask);
        }));
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn duplicate_task_names_fail_registration() {
        let service = TaskService::new(Arc::new(EventBus::new()));
        service.register_typed_task(DemoTask {
            name: "demo.duplicate",
            behavior: DemoBehavior::WeightedProgress,
            scope_key: None,
            broadcast_updates: true,
        });

        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            service.register_typed_task(DemoTask {
                name: "demo.duplicate",
                behavior: DemoBehavior::Rollback {
                    order: Arc::new(Mutex::new(Vec::new())),
                },
                scope_key: None,
                broadcast_updates: true,
            });
        }));

        let panic_message = panic_payload_to_string(result.unwrap_err());
        assert!(panic_message.contains("typed task demo.duplicate is registered more than once"));
    }

    #[tokio::test]
    async fn enqueue_failure_does_not_leave_a_visible_task_or_events() {
        let events = Arc::new(EventBus::new());
        let inner = Arc::new(TaskServiceInner {
            events: events.clone(),
            registry: TaskRegistry::new(),
            invocations: std::sync::RwLock::new(HashMap::new()),
            order: std::sync::RwLock::new(VecDeque::new()),
            active_scopes: std::sync::RwLock::new(HashMap::new()),
        });
        let service = TaskService::new_with_backend(inner, Arc::new(RejectingBackend));
        service.register_typed_task(DemoTask {
            name: "demo.reject",
            behavior: DemoBehavior::WeightedProgress,
            scope_key: Some("scope:reject"),
            broadcast_updates: true,
        });
        let mut rx = events.subscribe();

        let error = service
            .start("demo.reject", TaskInput::new())
            .await
            .unwrap_err();
        assert_eq!(error.kind(), TaskActionErrorKind::Internal);
        assert!(service.list().await.is_empty());
        assert!(
            service
                .active_invocation_for_scope("scope:reject")
                .await
                .is_none()
        );
        assert!(service.get("missing-task-id").await.is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(50), rx.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn panic_in_init_marks_task_failed_and_releases_scope() {
        let service = TaskService::new(Arc::new(EventBus::new()));
        service.register_typed_task(DemoTask {
            name: "demo.panic-init",
            behavior: DemoBehavior::PanicInit,
            scope_key: Some("scope:panic-init"),
            broadcast_updates: true,
        });

        let started = service
            .start("demo.panic-init", TaskInput::new())
            .await
            .unwrap();
        let snapshot = wait_for_terminal(&service, &started.id).await;
        assert_eq!(snapshot.status, TaskStateValue::Failed);

        let restarted = service
            .start("demo.panic-init", TaskInput::new())
            .await
            .unwrap();
        assert_ne!(started.id, restarted.id);
        let _ = wait_for_terminal(&service, &restarted.id).await;
    }

    #[tokio::test]
    async fn panic_in_run_marks_task_failed_and_releases_scope() {
        let service = TaskService::new(Arc::new(EventBus::new()));
        service.register_typed_task(DemoTask {
            name: "demo.panic-run",
            behavior: DemoBehavior::PanicRun,
            scope_key: Some("scope:panic-run"),
            broadcast_updates: true,
        });

        let started = service
            .start("demo.panic-run", TaskInput::new())
            .await
            .unwrap();
        let snapshot = wait_for_terminal(&service, &started.id).await;
        assert_eq!(snapshot.status, TaskStateValue::Failed);

        let restarted = service
            .start("demo.panic-run", TaskInput::new())
            .await
            .unwrap();
        assert_ne!(started.id, restarted.id);
        let _ = wait_for_terminal(&service, &restarted.id).await;
    }

    #[tokio::test]
    async fn panic_in_rollback_marks_task_rollback_failed_and_releases_scope() {
        let service = TaskService::new(Arc::new(EventBus::new()));
        service.register_typed_task(DemoTask {
            name: "demo.panic-rollback",
            behavior: DemoBehavior::PanicRollback,
            scope_key: Some("scope:panic-rollback"),
            broadcast_updates: true,
        });

        let started = service
            .start("demo.panic-rollback", TaskInput::new())
            .await
            .unwrap();
        let snapshot = wait_for_terminal(&service, &started.id).await;
        assert_eq!(snapshot.status, TaskStateValue::RollbackFailed);

        let restarted = service
            .start("demo.panic-rollback", TaskInput::new())
            .await
            .unwrap();
        assert_ne!(started.id, restarted.id);
        let _ = wait_for_terminal(&service, &restarted.id).await;
    }

    #[tokio::test]
    async fn panic_in_finalize_preserves_terminal_status() {
        let service = TaskService::new(Arc::new(EventBus::new()));
        let finalized = Arc::new(AtomicBool::new(false));
        service.register_typed_task(DemoTask {
            name: "demo.panic-finalize",
            behavior: DemoBehavior::PanicFinalize {
                finalized: finalized.clone(),
            },
            scope_key: Some("scope:panic-finalize"),
            broadcast_updates: true,
        });

        let started = service
            .start("demo.panic-finalize", TaskInput::new())
            .await
            .unwrap();
        let snapshot = wait_for_terminal(&service, &started.id).await;
        assert_eq!(snapshot.status, TaskStateValue::Succeeded);
        assert!(finalized.load(Ordering::Relaxed));
    }

    async fn wait_for_status(service: &TaskService, task_id: &str, expected: TaskStateValue) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            let snapshot = service.get(task_id).await.unwrap();
            if snapshot.status == expected {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "task {task_id} did not reach {expected:?} in time"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn wait_for_terminal(service: &TaskService, task_id: &str) -> TaskInvocationSnapshot {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            let snapshot = service.get(task_id).await.unwrap();
            if snapshot.status.is_terminal() {
                return snapshot;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "task {task_id} did not finish in time"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn task_api_lists_and_starts_registered_tasks() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = AppState::new(tmp.path().to_path_buf()).await;
        state.tasks.register_typed_task(DemoTask {
            name: "demo.weighted",
            behavior: DemoBehavior::WeightedProgress,
            scope_key: Some("scope:test"),
            broadcast_updates: true,
        });
        let app = build_router(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = reqwest::Client::new();
        let definitions = client
            .get(format!("http://{addr}/api/tasks/definitions"))
            .send()
            .await
            .unwrap();
        assert_eq!(definitions.status(), reqwest::StatusCode::OK);
        let definitions: serde_json::Value = definitions.json().await.unwrap();
        assert!(
            definitions
                .as_array()
                .unwrap()
                .iter()
                .any(|definition| definition["name"] == "demo.weighted")
        );

        let started = client
            .post(format!("http://{addr}/api/tasks"))
            .json(&serde_json::json!({
                "definitionName": "demo.weighted",
                "input": {}
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(started.status(), reqwest::StatusCode::ACCEPTED);
        let started: serde_json::Value = started.json().await.unwrap();
        assert_eq!(started["definitionName"], "demo.weighted");

        let listed = client
            .get(format!("http://{addr}/api/tasks"))
            .send()
            .await
            .unwrap();
        assert_eq!(listed.status(), reqwest::StatusCode::OK);
        let listed: serde_json::Value = listed.json().await.unwrap();
        assert!(
            listed
                .as_array()
                .unwrap()
                .iter()
                .any(|task| task["definitionName"] == "demo.weighted")
        );
    }

    #[tokio::test]
    async fn task_snapshot_and_events_include_broadcast_tasks() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = AppState::new(tmp.path().to_path_buf()).await;
        let notify = Arc::new(Notify::new());
        state.tasks.register_typed_task(DemoTask {
            name: "demo.wait",
            behavior: DemoBehavior::WaitForNotify {
                notify: notify.clone(),
            },
            scope_key: Some("scope:long"),
            broadcast_updates: true,
        });
        let mut rx = state.events.subscribe();
        let started = state
            .tasks
            .start("demo.wait", TaskInput::new())
            .await
            .unwrap();
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
        assert!(body.contains("\"tasks\""));
        assert!(body.contains(&started.id));

        let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(event.kind, EventKind::TaskUpdated(_)));

        notify.notify_waiters();
        let _ = wait_for_terminal(&state.tasks, &started.id).await;
    }
}
