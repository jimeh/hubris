use std::path::PathBuf;

use listenfd::ListenFd;
use tracing_subscriber::EnvFilter;

use hubris_server::{
    DesktopAccess, InstanceKind, InstanceLock, InstanceLockError, InstanceLockOptions,
    ServerAccess, ServerOptions, resolve_server_data_dir, run_server_with_shutdown_and_lock,
    select_listener,
};

const DEFAULT_PORT: u16 = 3001;
const DEV_BACKEND_PORT_OFFSET: u16 = 100;
const MAX_PORT_ATTEMPTS: u16 = 100;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("fatal: {error}");
        std::process::exit(1);
    }
}

async fn run() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("hubris_server=debug".parse().unwrap()),
        )
        .init();

    let is_dev = cfg!(debug_assertions);
    let data_dir = resolve_server_data_dir(is_dev)?;

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
        .map_err(std::io::Error::other)?;
    let listener = select_listener(
        inherited_listener,
        &host,
        base_port,
        is_dev,
        DEV_BACKEND_PORT_OFFSET,
        MAX_PORT_ATTEMPTS,
    )
    .await?;

    let addr = listener.local_addr()?;

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
            .map_err(|error| {
                std::io::Error::other(format!(
                    "failed to write dev state file {}: {error}",
                    state_file.display()
                ))
            })?;
    }

    let listen_url = format!("http://{addr}");
    let instance_lock = match InstanceLock::acquire(
        &data_dir,
        InstanceLockOptions {
            instance_kind: InstanceKind::Server,
            display_name: "Hubris Server".to_string(),
            listen_url: Some(listen_url.clone()),
        },
    ) {
        Ok(lock) => lock,
        Err(InstanceLockError::Conflict(conflict)) => {
            eprintln!("{}", conflict.message());
            std::process::exit(1);
        }
        Err(InstanceLockError::Io(error)) => {
            eprintln!("failed to acquire Hubris instance lock: {error}");
            std::process::exit(1);
        }
    };
    tracing::info!("listening on {listen_url}");
    let access = std::env::var("HUBRIS_DESKTOP_SESSION_TOKEN")
        .ok()
        .map(DesktopAccess::api_only)
        .map(ServerAccess::DesktopLocked)
        .unwrap_or(ServerAccess::Open);

    run_server_with_shutdown_and_lock(
        listener,
        data_dir,
        ServerOptions {
            access,
            ..ServerOptions::default()
        },
        shutdown_signal(),
        Some(instance_lock),
    )
    .await?;

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }

    tracing::info!("shutdown signal received");
}
