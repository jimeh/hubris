use std::path::PathBuf;

use listenfd::ListenFd;
use tracing_subscriber::EnvFilter;

use hubris_server::{AppState, build_router, select_listener};

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

    let data_dir = std::env::var("HUBRIS_DATA_DIR").map_or_else(
        |_| {
            let home = dirs::home_dir().expect("no home directory");
            if is_dev {
                home.join(".hubris-dev")
            } else {
                home.join(".hubris")
            }
        },
        PathBuf::from,
    );
    tokio::fs::create_dir_all(&data_dir)
        .await
        .expect("failed to create data dir");

    let state = AppState::new(data_dir);
    let app = build_router(state);

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
    axum::serve(listener, app).await.unwrap();
}
