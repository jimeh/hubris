pub mod api;
mod embedded;
pub mod pty;
pub mod state;

use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderValue, Method};
use axum::routing::{delete, get};
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use api::files::list_files;
use api::projects::{add_project, delete_project, list_projects};
use api::terminal::ws_handler;
use embedded::spa_handler;
pub use state::AppState;

/// Build the API router for a given AppState.
pub fn build_router(state: AppState) -> Router {
    let api = Router::new()
        .route("/files", get(list_files))
        .route("/projects", get(list_projects).post(add_project))
        .route("/projects/{id}", delete(delete_project))
        .route("/terminal/ws", get(ws_handler));

    let cors = CorsLayer::new()
        .allow_origin(
            "http://localhost:5173"
                .parse::<HeaderValue>()
                .unwrap(),
        )
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::DELETE,
        ])
        .allow_headers([CONTENT_TYPE]);

    Router::new()
        .nest("/api", api)
        .fallback(spa_handler)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
