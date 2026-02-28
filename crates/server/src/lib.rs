pub mod api;
mod embedded;
pub mod events;
pub mod pty;
pub mod state;

use axum::Router;
use axum::http::Method;
use axum::http::header::CONTENT_TYPE;
use axum::routing::{delete, get};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use api::events::event_stream;
use api::files::list_files;
use api::projects::{add_project, delete_project, list_projects};
use api::tabs::{create_tab, delete_tab, list_tabs, update_tab};
use api::terminal::ws_handler;
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

/// Build the API router for a given AppState.
pub fn build_router(state: AppState) -> Router {
    let api = Router::new()
        .route("/files", get(list_files))
        .route("/projects", get(list_projects).post(add_project))
        .route("/projects/{id}", delete(delete_project))
        .route("/tabs", get(list_tabs).post(create_tab))
        .route("/tabs/{id}", delete(delete_tab).patch(update_tab))
        .route("/events", get(event_stream))
        .route("/terminal/ws", get(ws_handler));

    let cors = if cfg!(debug_assertions) {
        CorsLayer::new()
            .allow_origin(tower_http::cors::Any)
            .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::PATCH])
            .allow_headers([CONTENT_TYPE])
    } else {
        // Production: no CORS needed, frontend is embedded
        // and served from the same origin.
        CorsLayer::new()
            .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::PATCH])
            .allow_headers([CONTENT_TYPE])
    };

    Router::new()
        .nest("/api", api)
        .fallback(spa_handler)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
