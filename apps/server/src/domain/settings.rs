use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utoipa::ToSchema;

use crate::chat::{ChatSettings, ChatUiStyle, CopilotKitThemeMode};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "lowercase")]
pub enum ColorScheme {
    #[default]
    Auto,
    Light,
    Dark,
}

impl ColorScheme {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "lowercase")]
pub enum TerminalFontSource {
    #[default]
    Default,
    System,
    Bundled,
}

impl TerminalFontSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::System => "system",
            Self::Bundled => "bundled",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
pub enum WorktreeLocationMode {
    #[default]
    #[serde(rename = "dataDir")]
    DataDir,
    #[serde(rename = "repoLocalDotHubris")]
    RepoLocalDotHubris,
}

impl WorktreeLocationMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DataDir => "dataDir",
            Self::RepoLocalDotHubris => "repoLocalDotHubris",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
pub enum VscodeRuntimeKind {
    #[default]
    #[serde(rename = "vscodeCli")]
    VscodeCli,
    #[serde(rename = "codeServer")]
    CodeServer,
}

impl VscodeRuntimeKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::VscodeCli => "vscodeCli",
            Self::CodeServer => "codeServer",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    #[serde(default)]
    pub color_scheme: ColorScheme,
    #[serde(default = "default_light_theme")]
    pub light_theme: String,
    #[serde(default = "default_dark_theme")]
    pub dark_theme: String,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            color_scheme: ColorScheme::Auto,
            light_theme: default_light_theme(),
            dark_theme: default_dark_theme(),
        }
    }
}

fn default_light_theme() -> String {
    "hubris-light".to_string()
}

fn default_dark_theme() -> String {
    "hubris-dark".to_string()
}

fn default_light_editor_theme() -> String {
    "hubris-light".to_string()
}

fn default_dark_editor_theme() -> String {
    "hubris-dark".to_string()
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    #[schema(required = true)]
    pub font_source: TerminalFontSource,
    #[schema(required = true)]
    pub system_font_family: String,
    #[schema(required = true)]
    pub bundled_font: String,
    #[schema(required = true)]
    pub font_size: u32,
    #[schema(required = true)]
    pub smart_tab_naming: bool,
    #[schema(required = true)]
    pub escape_sequence_titles: bool,
    #[schema(required = true)]
    pub send_keybindings_to_shell: bool,
    #[schema(required = true)]
    pub client_scrollback_rows: u32,
    #[schema(required = true)]
    pub server_scrollback_bytes: u32,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            font_source: TerminalFontSource::Default,
            system_font_family: String::new(),
            bundled_font: default_bundled_font(),
            font_size: default_font_size(),
            smart_tab_naming: default_true(),
            escape_sequence_titles: default_true(),
            send_keybindings_to_shell: false,
            client_scrollback_rows: default_client_scrollback_rows(),
            server_scrollback_bytes: default_server_scrollback_bytes(),
        }
    }
}

fn default_bundled_font() -> String {
    "jetbrainsmono-nf".to_string()
}

fn default_font_size() -> u32 {
    14
}

pub const MIN_CLIENT_SCROLLBACK_ROWS: u32 = 500;
pub const MIN_SERVER_SCROLLBACK_BYTES: u32 = 10 * 1024;

fn default_client_scrollback_rows() -> u32 {
    10_000
}

fn default_server_scrollback_bytes() -> u32 {
    256 * 1024
}

pub const fn clamp_client_scrollback_rows(rows: u32) -> u32 {
    if rows < MIN_CLIENT_SCROLLBACK_ROWS {
        MIN_CLIENT_SCROLLBACK_ROWS
    } else {
        rows
    }
}

pub const fn clamp_server_scrollback_bytes(bytes: u32) -> u32 {
    if bytes < MIN_SERVER_SCROLLBACK_BYTES {
        MIN_SERVER_SCROLLBACK_BYTES
    } else {
        bytes
    }
}

const fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum LegacyTerminalTabLabelMode {
    Numbered,
    Process,
    Title,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSettingsCompat {
    #[serde(default)]
    font_source: TerminalFontSource,
    #[serde(default)]
    system_font_family: String,
    #[serde(default = "default_bundled_font")]
    bundled_font: String,
    #[serde(default = "default_font_size")]
    font_size: u32,
    #[serde(default)]
    smart_tab_naming: Option<bool>,
    #[serde(default)]
    escape_sequence_titles: Option<bool>,
    #[serde(default)]
    send_keybindings_to_shell: bool,
    #[serde(default = "default_client_scrollback_rows")]
    client_scrollback_rows: u32,
    #[serde(default = "default_server_scrollback_bytes")]
    server_scrollback_bytes: u32,
    #[serde(default)]
    tab_label_mode: Option<LegacyTerminalTabLabelMode>,
}

impl<'de> Deserialize<'de> for TerminalSettings {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let compat = TerminalSettingsCompat::deserialize(deserializer)?;
        let migrated_legacy_value = compat.tab_label_mode.is_some();

        Ok(Self {
            font_source: compat.font_source,
            system_font_family: compat.system_font_family,
            bundled_font: compat.bundled_font,
            font_size: compat.font_size,
            smart_tab_naming: compat.smart_tab_naming.unwrap_or_else(|| {
                if migrated_legacy_value {
                    true
                } else {
                    default_true()
                }
            }),
            escape_sequence_titles: compat.escape_sequence_titles.unwrap_or_else(|| {
                if migrated_legacy_value {
                    true
                } else {
                    default_true()
                }
            }),
            send_keybindings_to_shell: compat.send_keybindings_to_shell,
            client_scrollback_rows: clamp_client_scrollback_rows(compat.client_scrollback_rows),
            server_scrollback_bytes: clamp_server_scrollback_bytes(compat.server_scrollback_bytes),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EditorSettings {
    #[serde(default = "default_light_editor_theme")]
    pub light_editor_theme: String,
    #[serde(default = "default_dark_editor_theme")]
    pub dark_editor_theme: String,
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            light_editor_theme: default_light_editor_theme(),
            dark_editor_theme: default_dark_editor_theme(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSettings {
    #[serde(default)]
    pub location_mode: WorktreeLocationMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentalSettings {
    #[serde(default)]
    pub chat_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VscodeSettings {
    #[serde(default)]
    pub runtime: VscodeRuntimeKind,
}

impl Default for VscodeSettings {
    fn default() -> Self {
        Self {
            runtime: VscodeRuntimeKind::VscodeCli,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_scheme: Option<ColorScheme>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light_theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dark_theme: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_source: Option<TerminalFontSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_font_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundled_font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smart_tab_naming: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub escape_sequence_titles: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_keybindings_to_shell: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_scrollback_rows: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_scrollback_bytes: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditorSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light_editor_theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dark_editor_theme: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location_mode: Option<WorktreeLocationMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentalSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct VscodeSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<VscodeRuntimeKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_timeout_minutes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_style: Option<ChatUiStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copilotkit_theme_mode: Option<CopilotKitThemeMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
pub struct SettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<AppearanceSettingsPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<TerminalSettingsPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editor: Option<EditorSettingsPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeSettingsPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub experimental: Option<ExperimentalSettingsPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vscode: Option<VscodeSettingsPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat: Option<ChatSettingsPatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
pub struct Settings {
    #[serde(default)]
    pub appearance: AppearanceSettings,
    #[serde(default)]
    pub terminal: TerminalSettings,
    #[serde(default)]
    pub editor: EditorSettings,
    #[serde(default)]
    pub worktree: WorktreeSettings,
    #[serde(default)]
    pub experimental: ExperimentalSettings,
    #[serde(default)]
    pub vscode: VscodeSettings,
    #[serde(default)]
    pub chat: ChatSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
pub struct SettingsState {
    pub settings: Settings,
    pub generation: String,
    pub status: SettingsStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub enum SettingsStatusKind {
    #[default]
    Ok,
    InvalidFile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettingsStatus {
    pub kind: SettingsStatusKind,
    pub writes_blocked: bool,
    #[serde(default)]
    pub message: Option<String>,
}

impl Default for SettingsStatus {
    fn default() -> Self {
        Self::ok()
    }
}

impl SettingsStatus {
    pub fn ok() -> Self {
        Self {
            kind: SettingsStatusKind::Ok,
            writes_blocked: false,
            message: None,
        }
    }

    pub fn invalid_file(message: impl Into<String>) -> Self {
        Self {
            kind: SettingsStatusKind::InvalidFile,
            writes_blocked: true,
            message: Some(message.into()),
        }
    }
}
