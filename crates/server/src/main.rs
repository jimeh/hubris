use std::path::PathBuf;

use listenfd::ListenFd;
use tracing_subscriber::EnvFilter;

use hubris_server::{
    DesktopAccess, FrontendAssets, ServerAccess, ServerOptions, resolve_data_dir, run_server,
    select_listener,
};

const DEFAULT_PORT: u16 = 3001;
const DEV_BACKEND_PORT_OFFSET: u16 = 100;
const MAX_PORT_ATTEMPTS: u16 = 100;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("hubris_server=debug".parse().unwrap()),
        )
        .init();

    let is_dev = cfg!(debug_assertions);
    let data_dir = resolve_data_dir(if is_dev { ".hubris-dev" } else { ".hubris" })
        .expect("failed to resolve data dir");

    let host = std::env::var("HUBRIS_HOST").unwrap_or_else(|_| {
        if is_dev {
            "127.0.0.1".to_string()
        } else {
            "0.0.0.0".to_string()
        }
    });
    let base_port: u16 = std::env::var("HUBRIS_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let inherited_listener = ListenFd::from_env()
        .take_tcp_listener(0)
        .expect("failed to take socket activation listener");
    let listener = select_listener(
        inherited_listener,
        &host,
        base_port,
        is_dev,
        DEV_BACKEND_PORT_OFFSET,
        MAX_PORT_ATTEMPTS,
    )
    .await
    .expect("failed to bind server listener");

    let addr = listener.local_addr().unwrap();

    // In dev mode, write state file for frontend
    // coordination (port discovery + debugging).
    if is_dev
        && let (Ok(dev_id), Ok(dev_tmp)) = (
            std::env::var("HUBRIS_DEV_ID"),
            std::env::var("HUBRIS_DEV_TMP"),
        )
    {
        let state_file = PathBuf::from(&dev_tmp).join(format!("dev-{dev_id}.backend.json"));
        let state = serde_json::json!({
            "pid": std::process::id(),
            "port": addr.port(),
        });
        tokio::fs::write(&state_file, state.to_string())
            .await
            .expect("failed to write dev state file");
    }

    tracing::info!("listening on http://{}", addr);
    let access = std::env::var("HUBRIS_DESKTOP_SESSION_TOKEN")
        .ok()
        .map(DesktopAccess::api_only)
        .map(ServerAccess::DesktopLocked)
        .unwrap_or(ServerAccess::Open);

    run_server(
        listener,
        data_dir,
        ServerOptions {
            frontend: FrontendAssets::default(),
            access,
        },
    )
    .await
    .unwrap();
}
