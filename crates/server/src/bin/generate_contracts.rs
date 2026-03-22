use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use hubris_server::api::projects::Project;
use hubris_server::api::settings::{
    AppearanceSettings, ColorScheme, Settings, SettingsState, SettingsStatus, SettingsStatusKind,
    TerminalFontSource, TerminalSettings, WorktreeLocationMode, WorktreeSettings,
};
use hubris_server::api::terminal::{ClientControlMessage, ServerControlMessage};
use hubris_server::api::worktrees::Worktree;
use hubris_server::events::EventKind;
use hubris_server::openapi_spec;
use hubris_server::tab::{GitDiffScope, TabInfo};
use ts_rs::{Config, TS};

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("failed to resolve workspace root")
}

fn contracts_dir(root: &Path) -> PathBuf {
    root.join("frontend")
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
    push_ts_export::<GitDiffScope>(&mut sse, &cfg)?;
    push_ts_export::<TabInfo>(&mut sse, &cfg)?;
    push_ts_export::<Project>(&mut sse, &cfg)?;
    push_ts_export::<Worktree>(&mut sse, &cfg)?;
    push_ts_export::<ColorScheme>(&mut sse, &cfg)?;
    push_ts_export::<TerminalFontSource>(&mut sse, &cfg)?;
    push_ts_export::<WorktreeLocationMode>(&mut sse, &cfg)?;
    push_ts_export::<AppearanceSettings>(&mut sse, &cfg)?;
    push_ts_export::<TerminalSettings>(&mut sse, &cfg)?;
    push_ts_export::<WorktreeSettings>(&mut sse, &cfg)?;
    push_ts_export::<Settings>(&mut sse, &cfg)?;
    push_ts_export::<SettingsStatusKind>(&mut sse, &cfg)?;
    push_ts_export::<SettingsStatus>(&mut sse, &cfg)?;
    push_ts_export::<SettingsState>(&mut sse, &cfg)?;
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
