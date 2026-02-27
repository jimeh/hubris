use std::path::PathBuf;

use tracing_subscriber::EnvFilter;

use hubris_server::{build_router, AppState};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env()
                .add_directive(
                    "hubris_server=debug".parse().unwrap(),
                ),
        )
        .init();

    let data_dir = if cfg!(debug_assertions) {
        PathBuf::from("./data")
    } else {
        dirs::home_dir()
            .expect("no home directory")
            .join(".hubris")
    };
    tokio::fs::create_dir_all(&data_dir)
        .await
        .expect("failed to create data dir");

    let state = AppState::new(data_dir);
    let app = build_router(state);

    let addr = "0.0.0.0:3001";
    tracing::info!("listening on {}", addr);
    let listener =
        tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
