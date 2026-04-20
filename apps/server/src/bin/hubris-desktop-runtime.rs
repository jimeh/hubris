use std::io::{self, Write};
use std::path::PathBuf;

use hubris_server::{
    DesktopAccess, FrontendAssets, InstanceConflictInfo, InstanceKind, InstanceLock,
    InstanceLockError, InstanceLockOptions, ServerAccess, ServerOptions,
    run_server_with_shutdown_and_lock,
};
use serde::Serialize;
use tracing_subscriber::EnvFilter;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 0;

#[derive(Debug, Serialize)]
struct StartupMessage {
    ready: bool,
    pid: u32,
    port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    conflict: Option<StartupConflict>,
}

#[derive(Debug, Serialize)]
struct StartupConflict {
    holder_pid: u32,
    holder_kind: InstanceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    listen_url: Option<String>,
}

#[tokio::main]
async fn main() {
    init_tracing();

    if let Err(error) = run().await {
        emit_startup_message(StartupMessage {
            ready: false,
            pid: std::process::id(),
            port: 0,
            error: Some(error.to_string()),
            conflict: error.conflict(),
        });
        std::process::exit(1);
    }
}

async fn run() -> RuntimeResult<()> {
    let data_dir = required_path("HUBRIS_DATA_DIR")?;
    let session_token = required_var("HUBRIS_DESKTOP_SESSION_TOKEN")?;
    let bootstrap_token = required_var("HUBRIS_DESKTOP_BOOTSTRAP_TOKEN")?;
    let host = std::env::var("HUBRIS_HOST").unwrap_or_else(|_| DEFAULT_HOST.to_string());
    let port = std::env::var("HUBRIS_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    std::fs::create_dir_all(&data_dir)?;

    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
    let local_addr = listener.local_addr()?;
    let instance_lock = InstanceLock::acquire(
        &data_dir,
        InstanceLockOptions {
            instance_kind: InstanceKind::DesktopRuntime,
            display_name: "Hubris Desktop Runtime".to_string(),
            listen_url: None,
        },
    )?;

    emit_startup_message(StartupMessage {
        ready: true,
        pid: std::process::id(),
        port: local_addr.port(),
        error: None,
        conflict: None,
    });

    run_server_with_shutdown_and_lock(
        listener,
        data_dir,
        ServerOptions {
            frontend: FrontendAssets::disabled(),
            access: ServerAccess::DesktopLocked(DesktopAccess::packaged(
                session_token,
                bootstrap_token,
            )),
        },
        shutdown_signal(),
        Some(instance_lock),
    )
    .await?;

    Ok(())
}

fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("hubris_server=debug".parse().unwrap()),
        )
        .try_init();
}

fn required_var(name: &str) -> io::Result<String> {
    std::env::var(name).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("missing required environment variable {name}"),
        )
    })
}

fn required_path(name: &str) -> io::Result<PathBuf> {
    Ok(PathBuf::from(required_var(name)?))
}

fn emit_startup_message(message: StartupMessage) {
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    serde_json::to_writer(&mut lock, &message).expect("failed to serialize startup message");
    lock.write_all(b"\n")
        .expect("failed to terminate startup message");
    lock.flush().expect("failed to flush startup message");
}

#[derive(Debug)]
enum RuntimeStartupError {
    Io(io::Error),
    Conflict(InstanceConflictInfo),
}

type RuntimeResult<T> = Result<T, RuntimeStartupError>;

impl RuntimeStartupError {
    fn conflict(&self) -> Option<StartupConflict> {
        match self {
            Self::Conflict(conflict) => Some(StartupConflict {
                holder_pid: conflict.holder_pid,
                holder_kind: conflict.holder_kind.clone(),
                listen_url: conflict.listen_url.clone(),
            }),
            Self::Io(_) => None,
        }
    }
}

impl std::fmt::Display for RuntimeStartupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => error.fmt(f),
            Self::Conflict(conflict) => write!(f, "{}", conflict.message()),
        }
    }
}

impl std::error::Error for RuntimeStartupError {}

impl From<io::Error> for RuntimeStartupError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<InstanceLockError> for RuntimeStartupError {
    fn from(value: InstanceLockError) -> Self {
        match value {
            InstanceLockError::Io(error) => Self::Io(error),
            InstanceLockError::Conflict(conflict) => Self::Conflict(conflict),
        }
    }
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
}
