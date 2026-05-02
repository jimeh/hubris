use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use hubris_server::api::keybindings::{
    KeybindingEntry, KeybindingsState, KeybindingsStatus, KeybindingsStatusKind,
};
use hubris_server::api::processes::{
    ManagedProcessExitInfo, ManagedProcessLifecycleStateValue, ManagedProcessStatus,
};
use hubris_server::api::projects::Project;
use hubris_server::api::settings::{
    AppearanceSettings, ColorScheme, EditorSettings, EditorSettingsPatch, Settings, SettingsState,
    SettingsStatus, SettingsStatusKind, TerminalFontSource, TerminalSettings, VscodeRuntimeKind,
    VscodeSettings, WorktreeLocationMode, WorktreeSettings,
};
use hubris_server::api::tasks::{
    TaskDefinition, TaskDefinitionInputField, TaskInputFieldKind, TaskInvocationStatus,
    TaskRemoved, TaskState, TaskStepDefinition, TaskStepState, TaskStepStatus, TaskUpdated,
};
use hubris_server::api::terminal::{ClientControlMessage, ServerControlMessage};
use hubris_server::api::vscode::{
    VscodeInstallPhase, VscodeInstallProgress, VscodeLatestCheck, VscodeProcessStatus,
    VscodeRuntimeStatus, VscodeStatus,
};
use hubris_server::api::worktrees::{Worktree, WorktreeUiMode};
use hubris_server::chat::{
    ChatAppServerLifecycle, ChatAppServerStatus, ChatConversationDetail,
    ChatConversationSettingsPatch, ChatConversationSummary, ChatItem, ChatItemKind, ChatItemStatus,
    ChatMessage, ChatMessageRole, ChatMessageStatus, ChatModelOption,
    ChatModelReasoningEffortOption, ChatPermissionMode, ChatProvider, ChatReasoningEffort, ChatRun,
    ChatRunStatus, ChatRuntimeLifecycle, ChatRuntimeStatus, ChatSettings,
    ChatThreadStreamResumeState, ChatThreadStreamStatus, ChatTurn, ChatTurnStatus,
};
use hubris_server::events::EventKind;
use hubris_server::openapi_spec;
use hubris_server::tab::{
    GitDiffScope, TabInfo, TabPaneSplitAxis, WorktreePaneNode, WorktreeTabLayout,
    WorktreeTabLayoutState,
};
use hubris_server::worktree_state::WorktreeRestoreState;
use ts_rs::{Config, TS};

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("failed to resolve workspace root")
}

fn contracts_dir(root: &Path) -> PathBuf {
    root.join("apps")
        .join("web")
        .join("src")
        .join("lib")
        .join("contracts")
}

fn strip_imports(ts: &str) -> String {
    let mut out = String::new();
    for line in ts.lines() {
        if !line.starts_with("import type ") {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn push_ts_export<T: TS + 'static>(out: &mut String, cfg: &Config) -> Result<(), Box<dyn Error>> {
    out.push_str(&strip_imports(&T::export_to_string(cfg)?));
    out.push('\n');
    Ok(())
}

fn write_openapi(dir: &Path) -> Result<(), Box<dyn Error>> {
    let spec = openapi_spec();
    let body = serde_json::to_string_pretty(&spec)?;
    fs::write(dir.join("openapi.generated.json"), body)?;
    Ok(())
}

fn write_ts_contracts(dir: &Path) -> Result<(), Box<dyn Error>> {
    let sse_path = dir.join("sse.generated.ts");
    let ws_path = dir.join("ws.generated.ts");
    let cfg = Config::from_env();

    let mut sse = String::from("// Generated file. Do not edit.\n\n");
    sse.push_str(
        "export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };\n\n",
    );
    push_ts_export::<GitDiffScope>(&mut sse, &cfg)?;
    push_ts_export::<TabPaneSplitAxis>(&mut sse, &cfg)?;
    push_ts_export::<WorktreePaneNode>(&mut sse, &cfg)?;
    push_ts_export::<WorktreeTabLayout>(&mut sse, &cfg)?;
    push_ts_export::<WorktreeTabLayoutState>(&mut sse, &cfg)?;
    push_ts_export::<WorktreeRestoreState>(&mut sse, &cfg)?;
    push_ts_export::<TabInfo>(&mut sse, &cfg)?;
    push_ts_export::<Project>(&mut sse, &cfg)?;
    push_ts_export::<WorktreeUiMode>(&mut sse, &cfg)?;
    push_ts_export::<Worktree>(&mut sse, &cfg)?;
    push_ts_export::<ColorScheme>(&mut sse, &cfg)?;
    push_ts_export::<TerminalFontSource>(&mut sse, &cfg)?;
    push_ts_export::<WorktreeLocationMode>(&mut sse, &cfg)?;
    push_ts_export::<AppearanceSettings>(&mut sse, &cfg)?;
    push_ts_export::<TerminalSettings>(&mut sse, &cfg)?;
    push_ts_export::<EditorSettings>(&mut sse, &cfg)?;
    push_ts_export::<EditorSettingsPatch>(&mut sse, &cfg)?;
    push_ts_export::<WorktreeSettings>(&mut sse, &cfg)?;
    push_ts_export::<VscodeRuntimeKind>(&mut sse, &cfg)?;
    push_ts_export::<VscodeSettings>(&mut sse, &cfg)?;
    push_ts_export::<ChatProvider>(&mut sse, &cfg)?;
    push_ts_export::<ChatPermissionMode>(&mut sse, &cfg)?;
    push_ts_export::<ChatReasoningEffort>(&mut sse, &cfg)?;
    push_ts_export::<ChatMessageRole>(&mut sse, &cfg)?;
    push_ts_export::<ChatMessageStatus>(&mut sse, &cfg)?;
    push_ts_export::<ChatRunStatus>(&mut sse, &cfg)?;
    push_ts_export::<ChatTurnStatus>(&mut sse, &cfg)?;
    push_ts_export::<ChatItemKind>(&mut sse, &cfg)?;
    push_ts_export::<ChatItemStatus>(&mut sse, &cfg)?;
    push_ts_export::<ChatRuntimeLifecycle>(&mut sse, &cfg)?;
    push_ts_export::<ChatAppServerLifecycle>(&mut sse, &cfg)?;
    push_ts_export::<ChatAppServerStatus>(&mut sse, &cfg)?;
    push_ts_export::<ChatThreadStreamResumeState>(&mut sse, &cfg)?;
    push_ts_export::<ChatThreadStreamStatus>(&mut sse, &cfg)?;
    push_ts_export::<ChatModelReasoningEffortOption>(&mut sse, &cfg)?;
    push_ts_export::<ChatModelOption>(&mut sse, &cfg)?;
    push_ts_export::<ChatConversationSettingsPatch>(&mut sse, &cfg)?;
    push_ts_export::<ChatConversationSummary>(&mut sse, &cfg)?;
    push_ts_export::<ChatMessage>(&mut sse, &cfg)?;
    push_ts_export::<ChatRun>(&mut sse, &cfg)?;
    push_ts_export::<ChatTurn>(&mut sse, &cfg)?;
    push_ts_export::<ChatItem>(&mut sse, &cfg)?;
    push_ts_export::<ChatConversationDetail>(&mut sse, &cfg)?;
    push_ts_export::<ChatRuntimeStatus>(&mut sse, &cfg)?;
    push_ts_export::<ChatSettings>(&mut sse, &cfg)?;
    push_ts_export::<Settings>(&mut sse, &cfg)?;
    push_ts_export::<SettingsStatusKind>(&mut sse, &cfg)?;
    push_ts_export::<SettingsStatus>(&mut sse, &cfg)?;
    push_ts_export::<SettingsState>(&mut sse, &cfg)?;
    push_ts_export::<KeybindingEntry>(&mut sse, &cfg)?;
    push_ts_export::<KeybindingsStatusKind>(&mut sse, &cfg)?;
    push_ts_export::<KeybindingsStatus>(&mut sse, &cfg)?;
    push_ts_export::<KeybindingsState>(&mut sse, &cfg)?;
    push_ts_export::<VscodeInstallPhase>(&mut sse, &cfg)?;
    push_ts_export::<VscodeInstallProgress>(&mut sse, &cfg)?;
    push_ts_export::<VscodeLatestCheck>(&mut sse, &cfg)?;
    push_ts_export::<VscodeProcessStatus>(&mut sse, &cfg)?;
    push_ts_export::<VscodeRuntimeStatus>(&mut sse, &cfg)?;
    push_ts_export::<VscodeStatus>(&mut sse, &cfg)?;
    push_ts_export::<ManagedProcessLifecycleStateValue>(&mut sse, &cfg)?;
    push_ts_export::<ManagedProcessExitInfo>(&mut sse, &cfg)?;
    push_ts_export::<ManagedProcessStatus>(&mut sse, &cfg)?;
    push_ts_export::<TaskState>(&mut sse, &cfg)?;
    push_ts_export::<TaskStepState>(&mut sse, &cfg)?;
    push_ts_export::<TaskInputFieldKind>(&mut sse, &cfg)?;
    push_ts_export::<TaskDefinitionInputField>(&mut sse, &cfg)?;
    push_ts_export::<TaskDefinition>(&mut sse, &cfg)?;
    push_ts_export::<TaskStepDefinition>(&mut sse, &cfg)?;
    push_ts_export::<TaskStepStatus>(&mut sse, &cfg)?;
    push_ts_export::<TaskInvocationStatus>(&mut sse, &cfg)?;
    push_ts_export::<TaskUpdated>(&mut sse, &cfg)?;
    push_ts_export::<TaskRemoved>(&mut sse, &cfg)?;
    push_ts_export::<EventKind>(&mut sse, &cfg)?;
    fs::write(&sse_path, sse)?;

    let mut ws = String::from("// Generated file. Do not edit.\n\n");
    push_ts_export::<ClientControlMessage>(&mut ws, &cfg)?;
    push_ts_export::<ServerControlMessage>(&mut ws, &cfg)?;
    fs::write(&ws_path, ws)?;
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let root = workspace_root();
    let contracts = contracts_dir(&root);
    fs::create_dir_all(&contracts)?;

    write_openapi(&contracts)?;
    write_ts_contracts(&contracts)?;

    println!("Wrote contracts to {}", contracts.display());
    Ok(())
}
