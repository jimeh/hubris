pub mod api;
mod embedded;
pub mod events;
pub mod git;
pub mod pty;
pub mod state;

use axum::Router;
use axum::http::Method;
use axum::http::header::CONTENT_TYPE;
use axum::routing::{delete, get, put};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use api::events::event_stream;
use api::files::list_files;
use api::openapi::{openapi_json, spec as openapi_spec_impl};
use api::projects::{add_project, delete_project, list_projects, reorder_projects, update_project};
use api::settings::{get_settings, save_settings};
use api::tabs::{create_tab, delete_tab, list_tabs, reorder_tabs, update_tab};
use api::terminal::ws_handler;
use api::worktrees::{
    create_project_worktree, delete_project_worktree, list_project_worktree_start_points,
    list_project_worktrees, reorder_project_worktrees,
};
use embedded::spa_handler;
pub use state::AppState;

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
            delete(delete_project_worktree),
        )
        .route("/tabs", get(list_tabs).post(create_tab))
        .route("/tabs/reorder", put(reorder_tabs))
        .route("/tabs/{id}", delete(delete_tab).patch(update_tab))
        .route("/events", get(event_stream))
        .route("/terminal/ws", get(ws_handler))
        .route("/settings", get(get_settings).put(save_settings));

    let cors = if cfg!(debug_assertions) {
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

    Router::new()
        .nest("/api", api)
        .fallback(spa_handler)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

pub fn openapi_spec() -> utoipa::openapi::OpenApi {
    openapi_spec_impl()
}
