use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use hubris_server::api::projects::Project;
use hubris_server::api::terminal::{ClientControlMessage, ServerControlMessage};
use hubris_server::api::worktrees::Worktree;
use hubris_server::events::EventKind;
use hubris_server::openapi_spec;
use hubris_server::pty::live_tab::TabInfo;
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
    sse.push_str(&TabInfo::export_to_string(&cfg)?);
    sse.push('\n');
    sse.push_str(&Project::export_to_string(&cfg)?);
    sse.push('\n');
    sse.push_str(&Worktree::export_to_string(&cfg)?);
    sse.push('\n');
    sse.push_str(&strip_imports(&EventKind::export_to_string(&cfg)?));
    sse.push('\n');
    fs::write(&sse_path, sse)?;

    let mut ws = String::from("// Generated file. Do not edit.\n\n");
    ws.push_str(&ClientControlMessage::export_to_string(&cfg)?);
    ws.push('\n');
    ws.push_str(&ServerControlMessage::export_to_string(&cfg)?);
    ws.push('\n');
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
