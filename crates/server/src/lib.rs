pub mod api;
pub mod pty;
pub mod state;

use std::path::PathBuf;

use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderValue, Method};
use axum::routing::{delete, get};
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use api::projects::{add_project, delete_project, list_projects};
use api::terminal::ws_handler;
pub use state::AppState;

/// Build the API router for a given AppState.
pub fn build_router(state: AppState) -> Router {
    let api = Router::new()
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

    let mut app = Router::new()
        .nest("/api", api)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    // In production, serve frontend from dist/
    let frontend_dist = PathBuf::from("frontend/dist");
    if frontend_dist.is_dir() {
        let spa = ServeDir::new(&frontend_dist).fallback(
            ServeFile::new(frontend_dist.join("index.html")),
        );
        app = app.fallback_service(spa);
    }

    app.with_state(state)
}
