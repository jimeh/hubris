use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingEntry {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct Keybindings {
    #[serde(default)]
    pub keybindings: Vec<KeybindingEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, ToSchema)]
pub struct KeybindingsState {
    pub keybindings: Vec<KeybindingEntry>,
    pub generation: String,
    pub status: KeybindingsStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub enum KeybindingsStatusKind {
    #[default]
    Ok,
    InvalidFile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingsStatus {
    pub kind: KeybindingsStatusKind,
    pub writes_blocked: bool,
    #[serde(default)]
    pub message: Option<String>,
}

impl Default for KeybindingsStatus {
    fn default() -> Self {
        Self::ok()
    }
}

impl KeybindingsStatus {
    pub fn ok() -> Self {
        Self {
            kind: KeybindingsStatusKind::Ok,
            writes_blocked: false,
            message: None,
        }
    }

    pub fn invalid_file(message: impl Into<String>) -> Self {
        Self {
            kind: KeybindingsStatusKind::InvalidFile,
            writes_blocked: true,
            message: Some(message.into()),
        }
    }
}
