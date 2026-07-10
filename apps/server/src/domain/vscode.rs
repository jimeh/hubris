use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utoipa::ToSchema;

use crate::domain::settings::VscodeRuntimeKind;
use crate::vscode::{
    CodeServerInstallPhaseValue, CodeServerProcessStatusValue, ManagerCodeServerInstallProgress,
    ManagerCodeServerLatestCheck, VscodeRuntimeStatusSnapshot, VscodeStatusSnapshot,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum VscodeInstallPhase {
    Preparing,
    Downloading,
    Extracting,
    Cleaning,
    Starting,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VscodeInstallProgress {
    pub phase: VscodeInstallPhase,
    pub percent: u8,
    #[serde(default)]
    pub downloaded_bytes: Option<u64>,
    #[serde(default)]
    pub total_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum VscodeProcessStatus {
    Running,
    Stopped,
    Starting,
    Stopping,
    Installing,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VscodeLatestCheck {
    #[serde(default)]
    pub latest_version: Option<String>,
    pub update_available: bool,
    #[serde(default)]
    pub checked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VscodeRuntimeStatus {
    pub supported: bool,
    #[serde(default)]
    pub installed_version: Option<String>,
    pub process_status: VscodeProcessStatus,
    #[serde(default)]
    pub latest: Option<VscodeLatestCheck>,
    #[serde(default)]
    pub install_progress: Option<VscodeInstallProgress>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub active_task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VscodeStatus {
    pub selected_runtime: VscodeRuntimeKind,
    pub code_server: VscodeRuntimeStatus,
    pub vscode_cli: VscodeRuntimeStatus,
}

impl From<CodeServerProcessStatusValue> for VscodeProcessStatus {
    fn from(value: CodeServerProcessStatusValue) -> Self {
        match value {
            CodeServerProcessStatusValue::Running => Self::Running,
            CodeServerProcessStatusValue::Stopped => Self::Stopped,
            CodeServerProcessStatusValue::Starting => Self::Starting,
            CodeServerProcessStatusValue::Stopping => Self::Stopping,
            CodeServerProcessStatusValue::Installing => Self::Installing,
            CodeServerProcessStatusValue::Error => Self::Error,
        }
    }
}

impl From<CodeServerInstallPhaseValue> for VscodeInstallPhase {
    fn from(value: CodeServerInstallPhaseValue) -> Self {
        match value {
            CodeServerInstallPhaseValue::Preparing => Self::Preparing,
            CodeServerInstallPhaseValue::Downloading => Self::Downloading,
            CodeServerInstallPhaseValue::Extracting => Self::Extracting,
            CodeServerInstallPhaseValue::Cleaning => Self::Cleaning,
            CodeServerInstallPhaseValue::Starting => Self::Starting,
        }
    }
}

impl From<ManagerCodeServerInstallProgress> for VscodeInstallProgress {
    fn from(value: ManagerCodeServerInstallProgress) -> Self {
        Self {
            phase: value.phase.into(),
            percent: value.percent,
            downloaded_bytes: value.downloaded_bytes,
            total_bytes: value.total_bytes,
        }
    }
}

impl From<ManagerCodeServerLatestCheck> for VscodeLatestCheck {
    fn from(value: ManagerCodeServerLatestCheck) -> Self {
        Self {
            latest_version: value.latest_version,
            update_available: value.update_available,
            checked_at: value.checked_at,
        }
    }
}

impl From<VscodeRuntimeStatusSnapshot> for VscodeRuntimeStatus {
    fn from(value: VscodeRuntimeStatusSnapshot) -> Self {
        Self {
            supported: value.supported,
            installed_version: value.installed_version,
            process_status: value.process_status.into(),
            latest: value.latest.map(Into::into),
            install_progress: value.install_progress.map(Into::into),
            message: value.message,
            active_task_id: value.active_task_id,
        }
    }
}

impl From<VscodeStatusSnapshot> for VscodeStatus {
    fn from(value: VscodeStatusSnapshot) -> Self {
        Self {
            selected_runtime: value.selected_runtime,
            code_server: value.code_server.into(),
            vscode_cli: value.vscode_cli.into(),
        }
    }
}
