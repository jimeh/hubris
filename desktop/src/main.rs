use std::error::Error;
use std::net::Ipv4Addr;

use hubris_server::{FrontendAssets, ServerOptions, resolve_data_dir, run_server};
use tauri::path::BaseDirectory;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tracing_subscriber::EnvFilter;
use url::Url;

const APP_DATA_DIR_NAME: &str = ".hubris";
const DESKTOP_HOST: Ipv4Addr = Ipv4Addr::LOCALHOST;
const DIST_RESOURCE_DIR: &str = "dist";
const WINDOW_LABEL: &str = "main";

fn main() {
    init_tracing();

    tauri::Builder::default()
        .setup(|app| -> Result<(), Box<dyn Error>> {
            let url = if cfg!(debug_assertions) {
                app.config()
                    .build
                    .dev_url
                    .clone()
                    .ok_or("missing build.devUrl in debug config")?
            } else {
                start_embedded_server(app)?
            };

            WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(url))
                .title("Hubris")
                .inner_size(1440.0, 960.0)
                .min_inner_size(1024.0, 720.0)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Hubris desktop");
}

/// Start the bundled Hubris server and return the local URL the
/// desktop webview should load.
fn start_embedded_server<R: tauri::Runtime>(app: &tauri::App<R>) -> Result<Url, Box<dyn Error>> {
    let dist_dir = app
        .path()
        .resolve(DIST_RESOURCE_DIR, BaseDirectory::Resource)?;
    let frontend = FrontendAssets::from_dir(dist_dir)?;
    let data_dir = resolve_data_dir(APP_DATA_DIR_NAME)?;
    std::fs::create_dir_all(&data_dir)?;

    let listener = tauri::async_runtime::block_on(async {
        tokio::net::TcpListener::bind((DESKTOP_HOST, 0)).await
    })?;
    let port = listener.local_addr()?.port();

    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_server(listener, data_dir, ServerOptions { frontend }).await {
            tracing::error!("desktop server exited: {error}");
        }
    });

    Ok(format!("http://{DESKTOP_HOST}:{port}").parse()?)
}

fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env()
                .add_directive("hubris_server=debug".parse().unwrap())
                .add_directive("hubris_desktop=debug".parse().unwrap()),
        )
        .try_init();
}
