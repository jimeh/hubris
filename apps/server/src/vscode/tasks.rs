use std::sync::Arc;

use semver::Version;

use crate::api::settings::VscodeRuntimeKind;
use crate::task_manager::{
    TaskActionError, TaskDefinitionInputField, TaskExecutionError, TaskFinalizeFuture, TaskInput,
    TaskInputFieldKind, TaskMetadata, TaskService, TaskStateInitFuture, TaskStateValue,
    TaskStepContext, TaskStepResult, TaskType, TaskTypeStep, TaskTypeStepRollbackFuture,
    TaskTypeStepRunFuture,
};

use super::{
    CodeServerManager, VscodeCliManager, code_server::CodeServerInstallState,
    vscode_cli::VscodeCliInstallState,
};

pub const TASK_VSCODE_CHECK_UPDATE: &str = "vscode.check-update";
pub const TASK_VSCODE_INSTALL_RUNTIME: &str = "vscode.install-runtime";

pub(super) const STEP_CHECK_LATEST: &str = "check-latest";
pub(super) const STEP_STOP_RUNTIME: &str = "stop-runtime";
pub(super) const STEP_DOWNLOAD_RUNTIME: &str = "download-runtime";
pub(super) const STEP_START_RUNTIME: &str = "start-runtime";
pub(super) const STEP_CLEANUP_RUNTIMES: &str = "cleanup-runtimes";

#[derive(Clone, Copy)]
pub struct CheckRuntimeUpdateInput {
    pub runtime: VscodeRuntimeKind,
}

#[derive(Clone)]
pub struct InstallRuntimeInput {
    pub runtime: VscodeRuntimeKind,
    pub version: Option<String>,
    pub force: bool,
}

struct CheckRuntimeUpdateState {
    runtime: VscodeRuntimeKind,
    code_server: Arc<CodeServerManager>,
    vscode_cli: Arc<VscodeCliManager>,
}

enum InstallRuntimeState {
    CodeServer(CodeServerInstallState),
    VscodeCli(VscodeCliInstallState),
}

impl InstallRuntimeState {
    async fn finalize(&mut self, final_status: TaskStateValue) {
        match self {
            Self::CodeServer(state) => state.finalize(final_status).await,
            Self::VscodeCli(state) => state.finalize(final_status).await,
        }
    }
}

static CHECK_RUNTIME_UPDATE_STEPS: &[TaskTypeStep<CheckRuntimeUpdateState>] = &[TaskTypeStep::new(
    STEP_CHECK_LATEST,
    "Check Latest",
    100,
    run_check_latest_step,
)];

static INSTALL_RUNTIME_STEPS: &[TaskTypeStep<InstallRuntimeState>] = &[
    TaskTypeStep::new(
        STEP_STOP_RUNTIME,
        "Stop Runtime",
        5,
        run_install_stop_runtime_step,
    )
    .with_rollback(rollback_install_stop_runtime_step),
    TaskTypeStep::new(
        STEP_DOWNLOAD_RUNTIME,
        "Download Runtime",
        70,
        run_install_download_runtime_step,
    )
    .with_rollback(rollback_install_download_runtime_step),
    TaskTypeStep::new(
        STEP_START_RUNTIME,
        "Start Runtime",
        20,
        run_install_start_runtime_step,
    )
    .with_rollback(rollback_install_start_runtime_step),
    TaskTypeStep::new(
        STEP_CLEANUP_RUNTIMES,
        "Cleanup Runtimes",
        5,
        run_install_cleanup_runtimes_step,
    ),
];

/// Register the stable VS Code task types with the shared task service.
pub fn register_vscode_tasks(
    tasks: &TaskService,
    code_server: Arc<CodeServerManager>,
    vscode_cli: Arc<VscodeCliManager>,
) {
    tasks.register_typed_task(CheckRuntimeUpdateTask::new(
        code_server.clone(),
        vscode_cli.clone(),
    ));
    tasks.register_typed_task(InstallRuntimeTask::new(code_server, vscode_cli));
}

/// Build a task input payload for VS Code runtime tasks.
pub fn vscode_task_input(
    runtime: VscodeRuntimeKind,
    version: Option<String>,
    force: bool,
) -> TaskInput {
    let mut input = TaskInput::new();
    input.insert(
        "runtime".to_string(),
        serde_json::Value::String(match runtime {
            VscodeRuntimeKind::CodeServer => "codeServer".to_string(),
            VscodeRuntimeKind::VscodeCli => "vscodeCli".to_string(),
        }),
    );
    if let Some(version) = version {
        input.insert("version".to_string(), serde_json::Value::String(version));
    }
    if force {
        input.insert("force".to_string(), serde_json::Value::Bool(true));
    }
    input
}

/// Return the shared scope key used to dedupe VS Code runtime tasks.
pub fn vscode_runtime_scope(runtime: VscodeRuntimeKind) -> String {
    format!(
        "vscode-runtime:{}",
        match runtime {
            VscodeRuntimeKind::CodeServer => "codeServer",
            VscodeRuntimeKind::VscodeCli => "vscodeCli",
        }
    )
}

/// Validate and normalize an install version for a runtime task request.
pub fn normalize_install_version_input(
    runtime: VscodeRuntimeKind,
    version: Option<String>,
) -> Result<Option<String>, TaskActionError> {
    let Some(version) = version else {
        return Ok(None);
    };

    let normalized = version.trim().trim_start_matches('v');
    Version::parse(normalized).map_err(|_| {
        TaskActionError::invalid_request(match runtime {
            VscodeRuntimeKind::CodeServer => {
                format!("invalid code-server version: {version}")
            }
            VscodeRuntimeKind::VscodeCli => format!("invalid VS Code version: {version}"),
        })
    })?;

    Ok(Some(normalized.to_string()))
}

#[derive(Clone)]
struct CheckRuntimeUpdateTask {
    code_server: Arc<CodeServerManager>,
    vscode_cli: Arc<VscodeCliManager>,
}

impl CheckRuntimeUpdateTask {
    fn new(code_server: Arc<CodeServerManager>, vscode_cli: Arc<VscodeCliManager>) -> Self {
        Self {
            code_server,
            vscode_cli,
        }
    }
}

impl TaskType for CheckRuntimeUpdateTask {
    type Input = CheckRuntimeUpdateInput;
    type State = CheckRuntimeUpdateState;

    fn metadata(&self) -> TaskMetadata {
        TaskMetadata {
            name: TASK_VSCODE_CHECK_UPDATE.to_string(),
            title: "Check VS Code Runtime Update".to_string(),
            description: Some("Check the latest release for a VS Code runtime.".to_string()),
            broadcast_updates: true,
            input_fields: vec![runtime_input_field()],
        }
    }

    fn parse_input(&self, input: &TaskInput) -> Result<Self::Input, TaskActionError> {
        Ok(CheckRuntimeUpdateInput {
            runtime: parse_runtime_input(input)?,
        })
    }

    fn scope_key(&self, input: &Self::Input) -> Result<Option<String>, TaskActionError> {
        Ok(Some(vscode_runtime_scope(input.runtime)))
    }

    fn init<'a>(&'a self, input: Self::Input) -> TaskStateInitFuture<'a, Self::State> {
        Box::pin(async move {
            Ok(CheckRuntimeUpdateState {
                runtime: input.runtime,
                code_server: self.code_server.clone(),
                vscode_cli: self.vscode_cli.clone(),
            })
        })
    }

    fn steps(&self) -> &'static [TaskTypeStep<Self::State>] {
        CHECK_RUNTIME_UPDATE_STEPS
    }
}

#[derive(Clone)]
struct InstallRuntimeTask {
    code_server: Arc<CodeServerManager>,
    vscode_cli: Arc<VscodeCliManager>,
}

impl InstallRuntimeTask {
    fn new(code_server: Arc<CodeServerManager>, vscode_cli: Arc<VscodeCliManager>) -> Self {
        Self {
            code_server,
            vscode_cli,
        }
    }
}

impl TaskType for InstallRuntimeTask {
    type Input = InstallRuntimeInput;
    type State = InstallRuntimeState;

    fn metadata(&self) -> TaskMetadata {
        TaskMetadata {
            name: TASK_VSCODE_INSTALL_RUNTIME.to_string(),
            title: "Install VS Code Runtime".to_string(),
            description: Some(
                "Install, upgrade, or reinstall a managed VS Code runtime.".to_string(),
            ),
            broadcast_updates: true,
            input_fields: vec![
                runtime_input_field(),
                TaskDefinitionInputField {
                    name: "version".to_string(),
                    title: "Version".to_string(),
                    description: Some(
                        "Optional version to install; omit to install the latest release."
                            .to_string(),
                    ),
                    required: false,
                    kind: TaskInputFieldKind::String,
                    enum_values: vec![],
                },
                TaskDefinitionInputField {
                    name: "force".to_string(),
                    title: "Force".to_string(),
                    description: Some(
                        "Reinstall the requested version even if it is already installed."
                            .to_string(),
                    ),
                    required: false,
                    kind: TaskInputFieldKind::Boolean,
                    enum_values: vec![],
                },
            ],
        }
    }

    fn parse_input(&self, input: &TaskInput) -> Result<Self::Input, TaskActionError> {
        let runtime = parse_runtime_input(input)?;
        let version =
            normalize_install_version_input(runtime, parse_optional_string(input, "version")?)?;
        let force = parse_bool_input(input, "force", false)?;
        Ok(InstallRuntimeInput {
            runtime,
            version,
            force,
        })
    }

    fn scope_key(&self, input: &Self::Input) -> Result<Option<String>, TaskActionError> {
        Ok(Some(vscode_runtime_scope(input.runtime)))
    }

    fn init<'a>(&'a self, input: Self::Input) -> TaskStateInitFuture<'a, Self::State> {
        Box::pin(async move {
            Ok(match input.runtime {
                VscodeRuntimeKind::CodeServer => InstallRuntimeState::CodeServer(
                    CodeServerInstallState::initialize(
                        self.code_server.clone(),
                        input.version,
                        input.force,
                    )
                    .await?,
                ),
                VscodeRuntimeKind::VscodeCli => InstallRuntimeState::VscodeCli(
                    VscodeCliInstallState::initialize(
                        self.vscode_cli.clone(),
                        input.version,
                        input.force,
                    )
                    .await?,
                ),
            })
        })
    }

    fn steps(&self) -> &'static [TaskTypeStep<Self::State>] {
        INSTALL_RUNTIME_STEPS
    }

    fn finalize<'a>(
        &'a self,
        state: &'a mut Self::State,
        final_status: TaskStateValue,
    ) -> TaskFinalizeFuture<'a> {
        Box::pin(async move {
            state.finalize(final_status).await;
        })
    }
}

fn run_check_latest_step<'a>(
    state: &'a mut CheckRuntimeUpdateState,
    context: TaskStepContext,
) -> TaskTypeStepRunFuture<'a> {
    Box::pin(async move {
        context.set_status_text("Checking latest release").await;
        match state.runtime {
            VscodeRuntimeKind::CodeServer => {
                let _ = state
                    .code_server
                    .check_for_update()
                    .await
                    .map_err(|error| TaskExecutionError::new(error.to_string()))?;
            }
            VscodeRuntimeKind::VscodeCli => {
                let _ = state
                    .vscode_cli
                    .check_for_update()
                    .await
                    .map_err(|error| TaskExecutionError::new(error.to_string()))?;
            }
        }
        context.set_step_progress(100).await;
        Ok(TaskStepResult::Completed)
    })
}

fn run_install_stop_runtime_step<'a>(
    state: &'a mut InstallRuntimeState,
    context: TaskStepContext,
) -> TaskTypeStepRunFuture<'a> {
    Box::pin(async move {
        match state {
            InstallRuntimeState::CodeServer(state) => state.stop_runtime(context).await,
            InstallRuntimeState::VscodeCli(state) => state.stop_runtime(context).await,
        }
    })
}

fn run_install_download_runtime_step<'a>(
    state: &'a mut InstallRuntimeState,
    context: TaskStepContext,
) -> TaskTypeStepRunFuture<'a> {
    Box::pin(async move {
        match state {
            InstallRuntimeState::CodeServer(state) => state.download_runtime(context).await,
            InstallRuntimeState::VscodeCli(state) => state.download_runtime(context).await,
        }
    })
}

fn run_install_start_runtime_step<'a>(
    state: &'a mut InstallRuntimeState,
    context: TaskStepContext,
) -> TaskTypeStepRunFuture<'a> {
    Box::pin(async move {
        match state {
            InstallRuntimeState::CodeServer(state) => state.start_runtime(context).await,
            InstallRuntimeState::VscodeCli(state) => state.start_runtime(context).await,
        }
    })
}

fn run_install_cleanup_runtimes_step<'a>(
    state: &'a mut InstallRuntimeState,
    context: TaskStepContext,
) -> TaskTypeStepRunFuture<'a> {
    Box::pin(async move {
        match state {
            InstallRuntimeState::CodeServer(state) => state.cleanup_runtimes(context).await,
            InstallRuntimeState::VscodeCli(state) => state.cleanup_runtimes(context).await,
        }
    })
}

fn rollback_install_stop_runtime_step<'a>(
    state: &'a mut InstallRuntimeState,
    context: TaskStepContext,
) -> TaskTypeStepRollbackFuture<'a> {
    Box::pin(async move {
        match state {
            InstallRuntimeState::CodeServer(state) => state.rollback_stop_runtime(context).await,
            InstallRuntimeState::VscodeCli(state) => state.rollback_stop_runtime(context).await,
        }
    })
}

fn rollback_install_download_runtime_step<'a>(
    state: &'a mut InstallRuntimeState,
    context: TaskStepContext,
) -> TaskTypeStepRollbackFuture<'a> {
    Box::pin(async move {
        match state {
            InstallRuntimeState::CodeServer(state) => {
                state.rollback_download_runtime(context).await
            }
            InstallRuntimeState::VscodeCli(state) => state.rollback_download_runtime(context).await,
        }
    })
}

fn rollback_install_start_runtime_step<'a>(
    state: &'a mut InstallRuntimeState,
    context: TaskStepContext,
) -> TaskTypeStepRollbackFuture<'a> {
    Box::pin(async move {
        match state {
            InstallRuntimeState::CodeServer(state) => state.rollback_start_runtime(context).await,
            InstallRuntimeState::VscodeCli(state) => state.rollback_start_runtime(context).await,
        }
    })
}

fn runtime_input_field() -> TaskDefinitionInputField {
    TaskDefinitionInputField {
        name: "runtime".to_string(),
        title: "Runtime".to_string(),
        description: Some("Managed VS Code runtime kind.".to_string()),
        required: true,
        kind: TaskInputFieldKind::String,
        enum_values: vec!["codeServer".to_string(), "vscodeCli".to_string()],
    }
}

fn parse_runtime_input(input: &TaskInput) -> Result<VscodeRuntimeKind, TaskActionError> {
    match parse_required_string(input, "runtime")?.as_str() {
        "codeServer" => Ok(VscodeRuntimeKind::CodeServer),
        "vscodeCli" => Ok(VscodeRuntimeKind::VscodeCli),
        other => Err(TaskActionError::invalid_request(format!(
            "invalid runtime value: {other}"
        ))),
    }
}

fn parse_required_string<'a>(
    input: &'a TaskInput,
    key: &str,
) -> Result<&'a String, TaskActionError> {
    let Some(value) = input.get(key) else {
        return Err(TaskActionError::invalid_request(format!(
            "missing required task input: {key}"
        )));
    };
    match value {
        serde_json::Value::String(value) => Ok(value),
        _ => Err(TaskActionError::invalid_request(format!(
            "task input {key} must be a string"
        ))),
    }
}

fn parse_optional_string(input: &TaskInput, key: &str) -> Result<Option<String>, TaskActionError> {
    let Some(value) = input.get(key) else {
        return Ok(None);
    };
    match value {
        serde_json::Value::String(value) => Ok(Some(value.clone())),
        serde_json::Value::Null => Ok(None),
        _ => Err(TaskActionError::invalid_request(format!(
            "task input {key} must be a string"
        ))),
    }
}

fn parse_bool_input(input: &TaskInput, key: &str, default: bool) -> Result<bool, TaskActionError> {
    let Some(value) = input.get(key) else {
        return Ok(default);
    };
    match value {
        serde_json::Value::Bool(value) => Ok(*value),
        _ => Err(TaskActionError::invalid_request(format!(
            "task input {key} must be a boolean"
        ))),
    }
}
