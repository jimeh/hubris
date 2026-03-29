mod access;
pub mod api;
mod code_server;
pub mod events;
mod frontend;
mod fs_sync;
pub mod git;
pub mod pty;
mod settings_manager;
pub mod state;
pub mod tab;
pub mod worktree_files;
pub mod worktree_path_policy;

use axum::Extension;
use axum::Router;
use axum::http::Method;
use axum::http::header::CONTENT_TYPE;
use axum::middleware;
use axum::routing::{any, delete, get, post, put};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

pub use access::{
    DESKTOP_BOOTSTRAP_PATH, DESKTOP_SESSION_COOKIE_NAME, DesktopAccess, ServerAccess,
};
use access::{desktop_auth_middleware, desktop_bootstrap_handler};
use api::events::event_stream;
use api::files::{
    get_project_worktree_file_content, get_project_worktree_git_diff, list_files,
    list_project_worktree_files, put_project_worktree_file_content, rename_project_worktree_file,
};
use api::openapi::{openapi_json, spec as openapi_spec_impl};
use api::projects::{add_project, delete_project, list_projects, reorder_projects, update_project};
use api::settings::{get_settings, patch_settings, put_settings};
use api::tabs::{create_tab, delete_tab, list_tabs, reorder_tabs, update_tab};
use api::terminal::ws_handler;
use api::worktrees::{
    create_project_worktree, delete_project_worktree, discard_project_worktree_path,
    get_project_worktree_commit_details, get_project_worktree_git_status,
    list_project_worktree_start_points, list_project_worktrees, reorder_project_worktrees,
    stage_project_worktree_path, unstage_project_worktree_path, update_project_worktree,
};
use code_server::proxy_code_request;
pub use frontend::FrontendAssets;
use frontend::apply_frontend_fallback;
pub use state::AppState;

/// Runtime options for the Hubris server.
#[derive(Clone, Debug)]
pub struct ServerOptions {
    pub frontend: FrontendAssets,
    pub access: ServerAccess,
}

impl Default for ServerOptions {
    fn default() -> Self {
        let frontend = {
            #[cfg(feature = "embed-frontend")]
            {
                FrontendAssets::embedded()
            }
            #[cfg(not(feature = "embed-frontend"))]
            {
                FrontendAssets::disabled()
            }
        };

        Self {
            frontend,
            access: ServerAccess::Open,
        }
    }
}

/// Resolve the Hubris data directory from the environment or
/// a provided default directory name under the user's home.
pub fn resolve_data_dir(default_dir_name: &str) -> std::io::Result<std::path::PathBuf> {
    if let Ok(path) = std::env::var("HUBRIS_DATA_DIR") {
        return Ok(std::path::PathBuf::from(path));
    }

    let home = dirs::home_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home directory"))?;

    Ok(home.join(default_dir_name))
}

/// Create the app state for a given data directory,
/// ensuring the directory exists first.
pub async fn create_app_state(data_dir: std::path::PathBuf) -> std::io::Result<AppState> {
    tokio::fs::create_dir_all(&data_dir).await?;
    Ok(AppState::new(data_dir).await)
}

/// Try binding to `host:start_port`, incrementing port up
/// to `max_attempts` times if already in use.
pub async fn bind_with_port_fallback(
    host: &str,
    start_port: u16,
    max_attempts: u16,
) -> std::io::Result<tokio::net::TcpListener> {
    for offset in 0..max_attempts {
        let port = start_port + offset;
        let addr: std::net::SocketAddr = format!("{host}:{port}").parse().map_err(|e| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("invalid address {host}:{port}: {e}"),
            )
        })?;
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                if offset > 0 {
                    tracing::info!("port {} in use, using {} instead", start_port, port,);
                }
                return Ok(listener);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AddrInUse,
        format!(
            "no available port (tried {}–{})",
            start_port,
            start_port + max_attempts - 1,
        ),
    ))
}

/// Select listener from inherited socket activation fd or
/// fallback bind behavior.
///
/// Priority:
/// 1. use inherited listener when present.
/// 2. in dev mode, bind with port fallback from offset.
/// 3. otherwise bind exact host/base port.
pub async fn select_listener(
    inherited: Option<std::net::TcpListener>,
    host: &str,
    base_port: u16,
    is_dev: bool,
    dev_backend_port_offset: u16,
    max_port_attempts: u16,
) -> std::io::Result<tokio::net::TcpListener> {
    if let Some(listener) = inherited {
        listener.set_nonblocking(true)?;
        return tokio::net::TcpListener::from_std(listener);
    }

    if is_dev {
        let dev_port = base_port
            .checked_add(dev_backend_port_offset)
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("invalid dev port: {base_port} + {dev_backend_port_offset}"),
                )
            })?;
        return bind_with_port_fallback(host, dev_port, max_port_attempts).await;
    }

    let addr: std::net::SocketAddr = format!("{host}:{base_port}").parse().map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("invalid address {host}:{base_port}: {e}"),
        )
    })?;

    tokio::net::TcpListener::bind(addr).await
}

const API_METHODS: [Method; 5] = [
    Method::GET,
    Method::POST,
    Method::PUT,
    Method::DELETE,
    Method::PATCH,
];

/// Build the API router for a given AppState.
pub fn build_router(state: AppState) -> Router {
    build_router_with_options(state, ServerOptions::default())
}

/// Build the API router with explicit runtime options.
pub fn build_router_with_options(state: AppState, options: ServerOptions) -> Router {
    let ServerOptions { frontend, access } = options;
    let api = Router::new()
        .route("/openapi.json", get(openapi_json))
        .route("/files", get(list_files))
        .route("/projects", get(list_projects).post(add_project))
        .route("/projects/reorder", put(reorder_projects))
        .route(
            "/projects/{id}",
            delete(delete_project).patch(update_project),
        )
        .route(
            "/projects/{id}/worktrees",
            get(list_project_worktrees).post(create_project_worktree),
        )
        .route(
            "/projects/{id}/worktrees/start-points",
            get(list_project_worktree_start_points),
        )
        .route(
            "/projects/{id}/worktrees/reorder",
            put(reorder_project_worktrees),
        )
        .route(
            "/projects/{id}/worktrees/{worktree_id}",
            delete(delete_project_worktree).patch(update_project_worktree),
        )
        .route(
            "/projects/{id}/worktrees/{worktree_id}/git-status",
            get(get_project_worktree_git_status),
        )
        .route(
            "/projects/{id}/worktrees/{worktree_id}/git/commits/{commit_id}",
            get(get_project_worktree_commit_details),
        )
        .route(
            "/projects/{id}/worktrees/{worktree_id}/git/stage",
            post(stage_project_worktree_path),
        )
        .route(
            "/projects/{id}/worktrees/{worktree_id}/git/unstage",
            post(unstage_project_worktree_path),
        )
        .route(
            "/projects/{id}/worktrees/{worktree_id}/git/discard",
            post(discard_project_worktree_path),
        )
        .route(
            "/projects/{id}/worktrees/{worktree_id}/files",
            get(list_project_worktree_files),
        )
        .route(
            "/projects/{id}/worktrees/{worktree_id}/files/content",
            get(get_project_worktree_file_content).put(put_project_worktree_file_content),
        )
        .route(
            "/projects/{id}/worktrees/{worktree_id}/files/rename",
            post(rename_project_worktree_file),
        )
        .route(
            "/projects/{id}/worktrees/{worktree_id}/git/diff",
            get(get_project_worktree_git_diff),
        )
        .route("/tabs", get(list_tabs).post(create_tab))
        .route("/tabs/reorder", put(reorder_tabs))
        .route("/tabs/{id}", delete(delete_tab).patch(update_tab))
        .route("/events", get(event_stream))
        .route("/terminal/ws", get(ws_handler))
        .route(
            "/settings",
            get(get_settings).put(put_settings).patch(patch_settings),
        );

    let cors = if cfg!(debug_assertions) && !access.is_desktop_locked() {
        CorsLayer::new()
            .allow_origin(tower_http::cors::Any)
            .allow_methods(API_METHODS)
            .allow_headers([CONTENT_TYPE])
    } else {
        // Production: no CORS needed, frontend is embedded
        // and served from the same origin.
        CorsLayer::new()
            .allow_methods(API_METHODS)
            .allow_headers([CONTENT_TYPE])
    };

    let mut router = Router::new()
        .route("/code", any(proxy_code_request))
        .route("/code/", any(proxy_code_request))
        .route("/code/{*path}", any(proxy_code_request))
        .nest("/api", api)
        .with_state(state);

    if access
        .desktop()
        .is_some_and(|desktop| desktop.has_bootstrap())
    {
        router = router.route(DESKTOP_BOOTSTRAP_PATH, get(desktop_bootstrap_handler));
    }

    let redact_query = access.is_desktop_locked();
    let trace =
        TraceLayer::new_for_http().make_span_with(move |request: &axum::http::Request<_>| {
            let uri = if redact_query {
                request.uri().path().to_string()
            } else {
                request.uri().to_string()
            };

            tracing::debug_span!(
                "request",
                method = %request.method(),
                uri = %uri,
                version = ?request.version(),
            )
        });

    let router = apply_frontend_fallback(router, frontend);
    let router = router.layer(cors).layer(trace);

    if let Some(desktop) = access.desktop().cloned() {
        router
            .layer(middleware::from_fn(desktop_auth_middleware))
            .layer(Extension(desktop))
    } else {
        router
    }
}

/// Run the Hubris server on an existing listener.
pub async fn run_server(
    listener: tokio::net::TcpListener,
    data_dir: std::path::PathBuf,
    options: ServerOptions,
) -> std::io::Result<()> {
    let state = create_app_state(data_dir).await?;
    let app = build_router_with_options(state.clone(), options);
    let result = axum::serve(listener, app)
        .await
        .map_err(std::io::Error::other);

    if let Err(error) = state.code_server.shutdown().await {
        tracing::warn!("failed to shut down shared code server: {error}");
    }

    result
}

pub fn openapi_spec() -> utoipa::openapi::OpenApi {
    openapi_spec_impl()
}
