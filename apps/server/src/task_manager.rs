use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Weak};

use futures_util::future::BoxFuture;
use serde_json::{Map as JsonMap, Value as JsonValue};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::events::{EventBus, EventKind};
use crate::process_manager::now_timestamp_string;

const FINISHED_TASK_RETENTION: usize = 100;

pub type TaskInput = JsonMap<String, JsonValue>;
pub(crate) type TaskScopeFn =
    Arc<dyn Fn(&TaskInput) -> Result<Option<String>, TaskActionError> + Send + Sync>;
pub(crate) type TaskRunFn = Arc<
    dyn Fn(TaskInvocationHandle, TaskInput) -> BoxFuture<'static, Result<(), TaskExecutionError>>
        + Send
        + Sync,
>;
pub(crate) type TaskStepRunFn = Arc<
    dyn Fn(TaskStepContext) -> BoxFuture<'static, Result<(), TaskExecutionError>> + Send + Sync,
>;

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
    fn is_active(self) -> bool {
        matches!(self, Self::Pending | Self::Running | Self::RollingBack)
    }

    fn is_terminal(self) -> bool {
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
}

impl fmt::Display for TaskExecutionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TaskExecutionError {}

#[derive(Clone)]
pub struct TaskDefinition {
    metadata: TaskDefinitionSnapshot,
    scope_key: TaskScopeFn,
    run: TaskRunFn,
}

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
    definition: TaskStepDefinitionSnapshot,
    run: TaskTypeStepRunFn<S>,
    rollback: Option<TaskTypeStepRollbackFn<S>>,
}

impl<S> TaskTypeStep<S> {
    /// Create a stable typed step definition with its forward action.
    pub fn new(
        id: impl Into<String>,
        title: impl Into<String>,
        weight: u8,
        run: TaskTypeStepRunFn<S>,
    ) -> Self {
        Self {
            definition: TaskStepDefinitionSnapshot {
                id: id.into(),
                title: title.into(),
                weight: weight.max(1),
            },
            run,
            rollback: None,
        }
    }

    /// Attach rollback logic for this step.
    pub fn with_rollback(mut self, rollback: TaskTypeStepRollbackFn<S>) -> Self {
        self.rollback = Some(rollback);
        self
    }

    fn definition(&self) -> TaskStepDefinitionSnapshot {
        self.definition.clone()
    }
}

/// A reusable typed task definition with input parsing, state init, and steps.
pub trait TaskType: Send + Sync + 'static {
    type Input: Send + 'static;
    type State: Send + 'static;

    fn definition(&self) -> TaskDefinitionSnapshot;

    fn parse_input(&self, input: &TaskInput) -> Result<Self::Input, TaskActionError>;

    fn scope_key(&self, input: &Self::Input) -> Result<Option<String>, TaskActionError>;

    fn init<'a>(&'a self, input: Self::Input) -> TaskStateInitFuture<'a, Self::State>;

    fn steps(&self) -> Vec<TaskTypeStep<Self::State>>;

    fn finalize<'a>(
        &'a self,
        _state: &'a mut Self::State,
        _final_status: TaskStateValue,
    ) -> TaskFinalizeFuture<'a> {
        Box::pin(async {})
    }
}

impl TaskDefinition {
    pub fn new(metadata: TaskDefinitionSnapshot, scope_key: TaskScopeFn, run: TaskRunFn) -> Self {
        Self {
            metadata,
            scope_key,
            run,
        }
    }

    pub fn metadata(&self) -> &TaskDefinitionSnapshot {
        &self.metadata
    }
}

fn assert_typed_task_steps(
    metadata: &TaskDefinitionSnapshot,
    step_definitions: &[TaskStepDefinitionSnapshot],
) {
    assert_eq!(
        metadata.steps, step_definitions,
        "typed task {} declared mismatched public/runtime steps",
        metadata.name
    );
}

#[derive(Clone)]
pub struct TaskService {
    inner: Arc<TaskServiceInner>,
}

struct TaskServiceInner {
    events: Arc<EventBus>,
    definitions: std::sync::RwLock<HashMap<String, Arc<TaskDefinition>>>,
    invocations: std::sync::RwLock<HashMap<String, Arc<TaskInvocationSlot>>>,
    order: std::sync::RwLock<VecDeque<String>>,
    active_scopes: std::sync::RwLock<HashMap<String, String>>,
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
pub struct TaskInvocationHandle {
    task_id: String,
    slot: Arc<TaskInvocationSlot>,
    service: Weak<TaskServiceInner>,
}

pub struct TaskStep {
    name: String,
    weight: u8,
    run: TaskStepRunFn,
    rollback: Option<TaskStepRunFn>,
}

#[derive(Clone)]
pub struct TaskStepContext {
    handle: TaskInvocationHandle,
    step_index: usize,
}

#[derive(Clone)]
pub struct TaskExecutionContext {
    handle: TaskInvocationHandle,
    step_definitions: Arc<Vec<TaskStepDefinitionSnapshot>>,
    step_indexes: Arc<HashMap<String, usize>>,
    rollbacks: Arc<Mutex<Vec<RegisteredRollback>>>,
}

#[derive(Clone)]
struct RegisteredRollback {
    step_index: usize,
    rollback: TaskStepRunFn,
}

impl TaskStep {
    pub fn new(name: impl Into<String>, weight: u8, run: TaskStepRunFn) -> Self {
        Self {
            name: name.into(),
            weight,
            run,
            rollback: None,
        }
    }

    pub fn with_rollback(mut self, rollback: TaskStepRunFn) -> Self {
        self.rollback = Some(rollback);
        self
    }
}

impl TaskService {
    pub fn new(events: Arc<EventBus>) -> Self {
        Self {
            inner: Arc::new(TaskServiceInner {
                events,
                definitions: std::sync::RwLock::new(HashMap::new()),
                invocations: std::sync::RwLock::new(HashMap::new()),
                order: std::sync::RwLock::new(VecDeque::new()),
                active_scopes: std::sync::RwLock::new(HashMap::new()),
            }),
        }
    }

    pub fn register_definition(&self, definition: TaskDefinition) {
        self.inner
            .definitions
            .write()
            .expect("task definitions poisoned")
            .insert(definition.metadata.name.clone(), Arc::new(definition));
    }

    pub fn register_typed_task<T>(&self, task: T)
    where
        T: TaskType,
    {
        let task = Arc::new(task);
        let metadata = task.definition();
        let step_definitions = task
            .steps()
            .into_iter()
            .map(|step| step.definition())
            .collect::<Vec<_>>();
        assert_typed_task_steps(&metadata, &step_definitions);
        self.register_definition(TaskDefinition::new(
            metadata,
            Arc::new({
                let task = task.clone();
                move |input| {
                    let parsed = task.parse_input(input)?;
                    task.scope_key(&parsed)
                }
            }),
            Arc::new(move |handle, input| {
                let task = task.clone();
                let step_definitions = step_definitions.clone();
                Box::pin(async move {
                    let parsed = task
                        .parse_input(&input)
                        .map_err(|error| TaskExecutionError::new(error.message().to_string()))?;
                    let mut state = task.init(parsed).await?;
                    let steps = task.steps();
                    let context = TaskExecutionContext::new(handle, step_definitions);
                    context.initialize().await;
                    let result = context
                        .execute_typed_steps(&mut state, steps.as_slice())
                        .await;
                    let final_status = if result.is_ok() {
                        TaskStateValue::Succeeded
                    } else {
                        context.status().await
                    };
                    task.finalize(&mut state, final_status).await;
                    result
                })
            }),
        ));
    }

    pub fn list_definitions(&self) -> Vec<TaskDefinitionSnapshot> {
        let mut definitions = self
            .inner
            .definitions
            .read()
            .expect("task definitions poisoned")
            .values()
            .map(|definition| definition.metadata().clone())
            .collect::<Vec<_>>();
        definitions.sort_by(|a, b| a.name.cmp(&b.name));
        definitions
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
        let definition = self
            .inner
            .definitions
            .read()
            .expect("task definitions poisoned")
            .get(definition_name)
            .cloned()
            .ok_or_else(|| TaskActionError::not_found(definition_name))?;
        let scope_key = (definition.scope_key)(&input)?;

        if let Some(scope_key) = scope_key.as_deref() {
            let maybe_existing = self
                .inner
                .active_scopes
                .read()
                .expect("task scopes poisoned")
                .get(scope_key)
                .cloned();
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

        let task_id = Uuid::new_v4().to_string();
        let slot = Arc::new(TaskInvocationSlot {
            definition_name: definition.metadata.name.clone(),
            title: definition.metadata.title.clone(),
            broadcast_updates: definition.metadata.broadcast_updates,
            created_at: now_timestamp_string(),
            state: Mutex::new(TaskInvocationRuntimeState {
                status: TaskStateValue::Pending,
                status_text: None,
                progress_percent: 0,
                started_at: None,
                finished_at: None,
                scope_key: scope_key.clone(),
                failure_message: None,
                steps: vec![],
            }),
        });

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
        if let Some(scope_key) = scope_key {
            self.inner
                .active_scopes
                .write()
                .expect("task scopes poisoned")
                .insert(scope_key, task_id.clone());
        }

        let handle = TaskInvocationHandle {
            task_id: task_id.clone(),
            slot: slot.clone(),
            service: Arc::downgrade(&self.inner),
        };
        handle.emit_update().await;

        let run = definition.run.clone();
        tokio::spawn(async move {
            handle.mark_started().await;
            let result = run(handle.clone(), input).await;
            handle.finish_definition_run(result).await;
        });

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
}

impl TaskInvocationHandle {
    pub async fn set_status_text(&self, status_text: impl Into<String>) {
        {
            let mut state = self.slot.state.lock().await;
            state.status_text = Some(status_text.into());
        }
        self.emit_update().await;
    }

    pub async fn clear_status_text(&self) {
        {
            let mut state = self.slot.state.lock().await;
            state.status_text = None;
        }
        self.emit_update().await;
    }

    pub async fn set_progress_absolute(&self, progress_percent: u8) {
        {
            let mut state = self.slot.state.lock().await;
            state.progress_percent = progress_percent.min(100);
        }
        self.emit_update().await;
    }

    pub async fn run_steps(&self, steps: Vec<TaskStep>) -> Result<(), TaskExecutionError> {
        let step_definitions = steps
            .iter()
            .map(|step| TaskStepDefinitionSnapshot {
                id: step.name.clone(),
                title: step.name.clone(),
                weight: step.weight.max(1),
            })
            .collect::<Vec<_>>();
        let context = TaskExecutionContext::new(self.clone(), step_definitions);
        context.initialize().await;

        for step in steps {
            context
                .run_boxed_step(&step.name, step.run.clone(), step.rollback.clone())
                .await?;
        }

        Ok(())
    }

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

    async fn finish_definition_run(&self, result: Result<(), TaskExecutionError>) {
        let should_finalize = {
            let mut state = self.slot.state.lock().await;
            if !state.status.is_active() {
                false
            } else {
                match result {
                    Ok(()) => {
                        state.status = TaskStateValue::Succeeded;
                        state.progress_percent = 100;
                        state.finished_at = Some(now_timestamp_string());
                        if state.status_text.is_none() {
                            state.status_text = Some("Completed".to_string());
                        }
                    }
                    Err(error) => {
                        state.status = TaskStateValue::Failed;
                        state.failure_message = Some(error.message().to_string());
                        state.status_text = Some(error.message().to_string());
                        state.finished_at = Some(now_timestamp_string());
                    }
                }
                true
            }
        };

        if should_finalize {
            self.release_scope().await;
            self.emit_update().await;
            self.evict_finished_tasks().await;
        }
    }

    async fn initialize_steps(&self, steps: &[TaskStepDefinitionSnapshot]) {
        {
            let mut state = self.slot.state.lock().await;
            state.steps = steps
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
                .collect();
            state.progress_percent = 0;
            state.status = TaskStateValue::Running;
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

impl TaskExecutionContext {
    fn new(handle: TaskInvocationHandle, steps: Vec<TaskStepDefinitionSnapshot>) -> Self {
        let step_indexes = steps
            .iter()
            .enumerate()
            .map(|(index, step)| (step.id.clone(), index))
            .collect();
        Self {
            handle,
            step_definitions: Arc::new(steps),
            step_indexes: Arc::new(step_indexes),
            rollbacks: Arc::new(Mutex::new(Vec::new())),
        }
    }

    async fn initialize(&self) {
        self.handle
            .initialize_steps(self.step_definitions.as_slice())
            .await;
    }

    pub async fn set_status_text(&self, status_text: impl Into<String>) {
        self.handle.set_status_text(status_text).await;
    }

    pub async fn clear_status_text(&self) {
        self.handle.clear_status_text().await;
    }

    pub async fn set_progress_absolute(&self, progress_percent: u8) {
        self.handle.set_progress_absolute(progress_percent).await;
    }

    pub async fn status(&self) -> TaskStateValue {
        self.handle.slot.state.lock().await.status
    }

    pub async fn execute_typed_steps<S>(
        &self,
        state: &mut S,
        steps: &[TaskTypeStep<S>],
    ) -> Result<(), TaskExecutionError>
    where
        S: Send,
    {
        let mut completed_indexes = Vec::new();

        for (step_index, step) in steps.iter().enumerate() {
            self.handle.mark_step_running(step_index).await;
            let context = TaskStepContext {
                handle: self.handle.clone(),
                step_index,
            };

            match (step.run)(state, context).await {
                Ok(TaskStepResult::Completed) => {
                    completed_indexes.push(step_index);
                    self.handle.mark_step_succeeded(step_index).await;
                }
                Ok(TaskStepResult::Skipped) => {
                    self.handle.mark_step_skipped(step_index).await;
                }
                Err(error) => {
                    self.handle
                        .mark_step_failed(step_index, error.message().to_string())
                        .await;
                    return self
                        .rollback_typed_steps(state, steps, completed_indexes, error)
                        .await;
                }
            }
        }

        Ok(())
    }

    pub async fn run_step<F, Fut>(
        &self,
        step_id: &str,
        rollback: Option<TaskStepRunFn>,
        run: F,
    ) -> Result<(), TaskExecutionError>
    where
        F: FnOnce(TaskStepContext) -> Fut,
        Fut: Future<Output = Result<(), TaskExecutionError>> + Send,
    {
        let step_index = self.step_index(step_id)?;
        self.handle.mark_step_running(step_index).await;
        let context = TaskStepContext {
            handle: self.handle.clone(),
            step_index,
        };
        match run(context.clone()).await {
            Ok(()) => {
                if let Some(rollback) = rollback {
                    self.rollbacks.lock().await.push(RegisteredRollback {
                        step_index,
                        rollback,
                    });
                }
                self.handle.mark_step_succeeded(step_index).await;
                Ok(())
            }
            Err(error) => {
                self.handle
                    .mark_step_failed(step_index, error.message().to_string())
                    .await;
                self.rollback_steps(error).await
            }
        }
    }

    async fn run_boxed_step(
        &self,
        step_id: &str,
        run: TaskStepRunFn,
        rollback: Option<TaskStepRunFn>,
    ) -> Result<(), TaskExecutionError> {
        self.run_step(step_id, rollback, move |context| async move {
            run(context).await
        })
        .await
    }

    pub async fn skip_step(&self, step_id: &str) -> Result<(), TaskExecutionError> {
        let step_index = self.step_index(step_id)?;
        self.handle.mark_step_skipped(step_index).await;
        Ok(())
    }

    async fn rollback_typed_steps<S>(
        &self,
        state: &mut S,
        steps: &[TaskTypeStep<S>],
        completed_steps: Vec<usize>,
        error: TaskExecutionError,
    ) -> Result<(), TaskExecutionError> {
        let has_rollbacks = completed_steps
            .iter()
            .any(|step_index| steps[*step_index].rollback.is_some());

        {
            let mut state = self.handle.slot.state.lock().await;
            state.status = if has_rollbacks {
                TaskStateValue::RollingBack
            } else {
                TaskStateValue::Failed
            };
            state.failure_message = Some(error.message().to_string());
            state.status_text = Some(error.message().to_string());
        }
        self.handle.emit_update().await;

        let mut rollback_failed = false;
        for step_index in completed_steps.into_iter().rev() {
            let Some(rollback) = steps[step_index].rollback else {
                continue;
            };

            self.handle.mark_step_rolling_back(step_index).await;
            let context = TaskStepContext {
                handle: self.handle.clone(),
                step_index,
            };
            match rollback(state, context).await {
                Ok(()) => {
                    self.handle.mark_step_rolled_back(step_index).await;
                }
                Err(rollback_error) => {
                    rollback_failed = true;
                    self.handle
                        .mark_step_rollback_failed(step_index, rollback_error.message().to_string())
                        .await;
                }
            }
        }

        {
            let mut state = self.handle.slot.state.lock().await;
            let had_rollbacks = state.steps.iter().any(|step| {
                matches!(
                    step.state,
                    TaskStepStateValue::RolledBack | TaskStepStateValue::RollbackFailed
                )
            });
            state.status = if rollback_failed {
                TaskStateValue::RollbackFailed
            } else if had_rollbacks {
                TaskStateValue::RolledBack
            } else {
                TaskStateValue::Failed
            };
            state.finished_at = Some(now_timestamp_string());
        }
        self.handle.release_scope().await;
        self.handle.emit_update().await;
        self.handle.evict_finished_tasks().await;
        Err(error)
    }

    async fn rollback_steps(&self, error: TaskExecutionError) -> Result<(), TaskExecutionError> {
        let rollbacks = {
            let mut rollbacks = self.rollbacks.lock().await;
            std::mem::take(&mut *rollbacks)
        };

        {
            let mut state = self.handle.slot.state.lock().await;
            state.status = if rollbacks.is_empty() {
                TaskStateValue::Failed
            } else {
                TaskStateValue::RollingBack
            };
            state.failure_message = Some(error.message().to_string());
            state.status_text = Some(error.message().to_string());
        }
        self.handle.emit_update().await;

        let mut rollback_failed = false;
        for registered in rollbacks.into_iter().rev() {
            self.handle
                .mark_step_rolling_back(registered.step_index)
                .await;
            let context = TaskStepContext {
                handle: self.handle.clone(),
                step_index: registered.step_index,
            };
            match (registered.rollback)(context).await {
                Ok(()) => {
                    self.handle
                        .mark_step_rolled_back(registered.step_index)
                        .await
                }
                Err(rollback_error) => {
                    rollback_failed = true;
                    self.handle
                        .mark_step_rollback_failed(
                            registered.step_index,
                            rollback_error.message().to_string(),
                        )
                        .await;
                }
            }
        }

        {
            let mut state = self.handle.slot.state.lock().await;
            let had_rollbacks = state.steps.iter().any(|step| {
                matches!(
                    step.state,
                    TaskStepStateValue::RolledBack | TaskStepStateValue::RollbackFailed
                )
            });
            state.status = if rollback_failed {
                TaskStateValue::RollbackFailed
            } else if had_rollbacks {
                TaskStateValue::RolledBack
            } else {
                TaskStateValue::Failed
            };
            state.finished_at = Some(now_timestamp_string());
        }
        self.handle.release_scope().await;
        self.handle.emit_update().await;
        self.handle.evict_finished_tasks().await;
        Err(error)
    }

    fn step_index(&self, step_id: &str) -> Result<usize, TaskExecutionError> {
        self.step_indexes
            .get(step_id)
            .copied()
            .ok_or_else(|| TaskExecutionError::new(format!("unknown task step id: {step_id}")))
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use super::*;
    use crate::{AppState, build_router};
    use futures_util::StreamExt;

    fn definition(
        name: &str,
        run: TaskRunFn,
        scope_key: Option<&str>,
        broadcast_updates: bool,
    ) -> TaskDefinition {
        let scope_key = scope_key.map(str::to_string);
        TaskDefinition::new(
            TaskDefinitionSnapshot {
                name: name.to_string(),
                title: name.to_string(),
                description: None,
                broadcast_updates,
                input_fields: vec![],
                steps: vec![],
            },
            Arc::new(move |_input| Ok(scope_key.clone())),
            run,
        )
    }

    #[tokio::test]
    async fn runs_steps_and_tracks_weighted_progress() {
        let service = TaskService::new(Arc::new(EventBus::new()));
        service.register_definition(definition(
            "demo",
            Arc::new(move |task, _input| {
                Box::pin(async move {
                    task.run_steps(vec![
                        TaskStep::new(
                            "prepare",
                            25,
                            Arc::new(|step| {
                                Box::pin(async move {
                                    step.set_step_progress(100).await;
                                    Ok(())
                                })
                            }),
                        ),
                        TaskStep::new(
                            "download",
                            75,
                            Arc::new(|step| {
                                Box::pin(async move {
                                    step.set_step_progress(50).await;
                                    step.set_step_progress(100).await;
                                    Ok(())
                                })
                            }),
                        ),
                    ])
                    .await
                })
            }),
            None,
            true,
        ));

        let started = service.start("demo", TaskInput::new()).await.unwrap();
        let snapshot = wait_for_terminal(&service, &started.id).await;
        assert_eq!(snapshot.status, TaskStateValue::Succeeded);
        assert_eq!(snapshot.progress_percent, 100);
        assert_eq!(snapshot.steps[0].state, TaskStepStateValue::Succeeded);
        assert_eq!(snapshot.steps[1].state, TaskStepStateValue::Succeeded);
    }

    #[tokio::test]
    async fn rolls_back_completed_steps_in_reverse_order() {
        let service = TaskService::new(Arc::new(EventBus::new()));
        let counter = Arc::new(AtomicUsize::new(0));
        let order = Arc::new(Mutex::new(Vec::new()));
        service.register_definition(definition(
            "rollback",
            Arc::new({
                let counter = counter.clone();
                let order = order.clone();
                move |task, _input| {
                    let counter = counter.clone();
                    let order = order.clone();
                    Box::pin(async move {
                        task.run_steps(vec![
                            TaskStep::new("one", 50, Arc::new(|_step| Box::pin(async { Ok(()) })))
                                .with_rollback(Arc::new({
                                    let order = order.clone();
                                    move |_step| {
                                        let order = order.clone();
                                        Box::pin(async move {
                                            order.lock().await.push("one");
                                            Ok(())
                                        })
                                    }
                                })),
                            TaskStep::new(
                                "two",
                                50,
                                Arc::new({
                                    let counter = counter.clone();
                                    move |_step| {
                                        let counter = counter.clone();
                                        Box::pin(async move {
                                            if counter.fetch_add(1, Ordering::Relaxed) == 0 {
                                                Ok(())
                                            } else {
                                                Err(TaskExecutionError::new("boom"))
                                            }
                                        })
                                    }
                                }),
                            )
                            .with_rollback(Arc::new({
                                let order = order.clone();
                                move |_step| {
                                    let order = order.clone();
                                    Box::pin(async move {
                                        order.lock().await.push("two");
                                        Ok(())
                                    })
                                }
                            })),
                            TaskStep::new(
                                "three",
                                1,
                                Arc::new(|_step| {
                                    Box::pin(async { Err(TaskExecutionError::new("boom")) })
                                }),
                            ),
                        ])
                        .await
                    })
                }
            }),
            None,
            true,
        ));

        let started = service.start("rollback", TaskInput::new()).await.unwrap();
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
        service.register_definition(definition(
            "first",
            Arc::new(|task, _input| {
                Box::pin(async move {
                    task.run_steps(vec![TaskStep::new(
                        "wait",
                        1,
                        Arc::new(|_step| {
                            Box::pin(async {
                                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                                Ok(())
                            })
                        }),
                    )])
                    .await
                })
            }),
            Some("scope:a"),
            true,
        ));
        service.register_definition(definition(
            "second",
            Arc::new(|_task, _input| Box::pin(async { Ok(()) })),
            Some("scope:a"),
            true,
        ));

        let first = service.start("first", TaskInput::new()).await.unwrap();
        let deduped = service.start("first", TaskInput::new()).await.unwrap();
        assert_eq!(first.id, deduped.id);

        let error = service.start("second", TaskInput::new()).await.unwrap_err();
        assert_eq!(error.kind(), TaskActionErrorKind::Conflict);
    }

    #[derive(Clone, Copy)]
    struct DemoTypedInput {
        skip_prepare: bool,
    }

    #[derive(Clone, Copy)]
    struct DemoTypedTask;

    struct DemoTypedState {
        skip_prepare: bool,
    }

    impl TaskType for DemoTypedTask {
        type Input = DemoTypedInput;
        type State = DemoTypedState;

        fn definition(&self) -> TaskDefinitionSnapshot {
            TaskDefinitionSnapshot {
                name: "typed.demo".to_string(),
                title: "Typed Demo".to_string(),
                description: Some("A typed task used in tests.".to_string()),
                broadcast_updates: true,
                input_fields: vec![TaskDefinitionInputField {
                    name: "skipPrepare".to_string(),
                    title: "Skip Prepare".to_string(),
                    description: None,
                    required: false,
                    kind: TaskInputFieldKind::Boolean,
                    enum_values: vec![],
                }],
                steps: vec![
                    TaskStepDefinitionSnapshot {
                        id: "prepare".to_string(),
                        title: "Prepare".to_string(),
                        weight: 40,
                    },
                    TaskStepDefinitionSnapshot {
                        id: "finish".to_string(),
                        title: "Finish".to_string(),
                        weight: 60,
                    },
                ],
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
            Ok(DemoTypedInput { skip_prepare })
        }

        fn scope_key(&self, _input: &Self::Input) -> Result<Option<String>, TaskActionError> {
            Ok(Some("scope:typed".to_string()))
        }

        fn init<'a>(&'a self, input: Self::Input) -> TaskStateInitFuture<'a, Self::State> {
            Box::pin(async move {
                Ok(DemoTypedState {
                    skip_prepare: input.skip_prepare,
                })
            })
        }

        fn steps(&self) -> Vec<TaskTypeStep<Self::State>> {
            vec![
                TaskTypeStep::new("prepare", "Prepare", 40, demo_prepare_step),
                TaskTypeStep::new("finish", "Finish", 60, demo_finish_step),
            ]
        }
    }

    fn demo_prepare_step<'a>(
        state: &'a mut DemoTypedState,
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

    fn demo_finish_step<'a>(
        _state: &'a mut DemoTypedState,
        context: TaskStepContext,
    ) -> TaskTypeStepRunFuture<'a> {
        Box::pin(async move {
            context.set_status_text("Finishing").await;
            context.set_step_progress(100).await;
            Ok(TaskStepResult::Completed)
        })
    }

    #[tokio::test]
    async fn registers_typed_tasks_and_rejects_invalid_input() {
        let service = TaskService::new(Arc::new(EventBus::new()));
        service.register_typed_task(DemoTypedTask);

        let definition = service
            .list_definitions()
            .into_iter()
            .find(|definition| definition.name == "typed.demo")
            .unwrap();
        assert_eq!(definition.steps.len(), 2);
        assert_eq!(definition.steps[0].id, "prepare");
        assert_eq!(definition.steps[1].id, "finish");

        let mut invalid_input = TaskInput::new();
        invalid_input.insert("skipPrepare".to_string(), serde_json::json!("yes"));
        let error = service
            .start("typed.demo", invalid_input)
            .await
            .unwrap_err();
        assert_eq!(error.kind(), TaskActionErrorKind::InvalidRequest);
    }

    #[tokio::test]
    async fn typed_tasks_can_skip_declared_steps() {
        let service = TaskService::new(Arc::new(EventBus::new()));
        service.register_typed_task(DemoTypedTask);

        let mut input = TaskInput::new();
        input.insert("skipPrepare".to_string(), serde_json::json!(true));
        let started = service.start("typed.demo", input).await.unwrap();
        let snapshot = wait_for_terminal(&service, &started.id).await;

        assert_eq!(snapshot.status, TaskStateValue::Succeeded);
        assert_eq!(snapshot.progress_percent, 100);
        assert_eq!(snapshot.steps[0].id, "prepare");
        assert_eq!(snapshot.steps[0].state, TaskStepStateValue::Skipped);
        assert_eq!(snapshot.steps[1].id, "finish");
        assert_eq!(snapshot.steps[1].state, TaskStepStateValue::Succeeded);
    }

    async fn wait_for_terminal(service: &TaskService, task_id: &str) -> TaskInvocationSnapshot {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let snapshot = service.get(task_id).await.unwrap();
            if snapshot.status.is_terminal() {
                return snapshot;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "task {task_id} did not finish in time"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn task_api_lists_and_starts_registered_tasks() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = AppState::new(tmp.path().to_path_buf()).await;
        state.tasks.register_definition(definition(
            "test.demo",
            Arc::new(|task, _input| {
                Box::pin(async move {
                    task.run_steps(vec![TaskStep::new(
                        "run",
                        100,
                        Arc::new(|step| {
                            Box::pin(async move {
                                step.set_step_progress(100).await;
                                Ok(())
                            })
                        }),
                    )])
                    .await
                })
            }),
            Some("scope:test"),
            true,
        ));
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
                .any(|definition| definition["name"] == "test.demo")
        );

        let started = client
            .post(format!("http://{addr}/api/tasks"))
            .json(&serde_json::json!({
                "definitionName": "test.demo",
                "input": {}
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(started.status(), reqwest::StatusCode::ACCEPTED);
        let started: serde_json::Value = started.json().await.unwrap();
        assert_eq!(started["definitionName"], "test.demo");

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
                .any(|task| task["definitionName"] == "test.demo")
        );
    }

    #[tokio::test]
    async fn task_snapshot_and_events_include_broadcast_tasks() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = AppState::new(tmp.path().to_path_buf()).await;
        state.tasks.register_definition(definition(
            "test.long",
            Arc::new(|task, _input| {
                Box::pin(async move {
                    task.run_steps(vec![TaskStep::new(
                        "wait",
                        100,
                        Arc::new(|step| {
                            Box::pin(async move {
                                step.set_status_text("Waiting").await;
                                tokio::time::sleep(Duration::from_millis(200)).await;
                                step.set_step_progress(100).await;
                                Ok(())
                            })
                        }),
                    )])
                    .await
                })
            }),
            Some("scope:long"),
            true,
        ));
        let mut rx = state.events.subscribe();
        let started = state
            .tasks
            .start("test.long", TaskInput::new())
            .await
            .unwrap();
        let app = build_router(state);

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
    }
}
