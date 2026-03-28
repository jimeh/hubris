use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use hubris_server::{
    FrontendAssets, ServerOptions, build_router_with_options, resolve_data_dir, run_server,
};
use tempfile::TempDir;

static ENV_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

async fn wait_for_ok(url: &str) -> reqwest::Response {
    let client = reqwest::Client::new();

    for _ in 0..20 {
        if let Ok(response) = client.get(url).send().await
            && response.status().is_success()
        {
            return response;
        }

        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    panic!("server did not become ready: {url}");
}

#[tokio::test]
async fn serves_spa_assets_from_filesystem_with_index_fallback() {
    let temp = TempDir::new().unwrap();
    let assets = temp.path().join("dist");
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::write(
        assets.join("index.html"),
        "<!doctype html><html><body>hubris</body></html>",
    )
    .unwrap();
    std::fs::write(assets.join("app.js"), "console.log('hubris');").unwrap();

    let app = build_router_with_options(
        hubris_server::AppState::new(temp.path().join("data")).await,
        ServerOptions {
            frontend: FrontendAssets::from_dir(&assets).unwrap(),
            access: hubris_server::ServerAccess::Open,
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let asset = wait_for_ok(&format!("http://127.0.0.1:{port}/app.js")).await;
    assert_eq!(asset.headers()["content-type"], "text/javascript");
    assert_eq!(asset.text().await.unwrap(), "console.log('hubris');");

    let fallback = wait_for_ok(&format!("http://127.0.0.1:{port}/deep/link")).await;
    assert!(fallback.text().await.unwrap().contains("hubris"));

    handle.abort();
}

#[test]
fn rejects_missing_frontend_asset_directory() {
    let temp = TempDir::new().unwrap();
    let error = FrontendAssets::from_dir(temp.path().join("missing")).unwrap_err();
    assert!(
        error.to_string().contains("frontend asset directory"),
        "{error}"
    );
}

#[cfg(feature = "embed-frontend")]
#[test]
fn server_options_default_uses_embedded_frontend_when_feature_enabled() {
    assert!(matches!(
        ServerOptions::default().frontend,
        FrontendAssets::Embedded
    ));
}

#[cfg(not(feature = "embed-frontend"))]
#[test]
fn server_options_default_disables_frontend_without_embed_feature() {
    assert!(matches!(
        ServerOptions::default().frontend,
        FrontendAssets::Disabled
    ));
}

#[tokio::test]
async fn run_server_uses_existing_listener_port() {
    let temp = TempDir::new().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        run_server(listener, temp.path().join("data"), ServerOptions::default())
            .await
            .unwrap();
    });

    let response = wait_for_ok(&format!("http://127.0.0.1:{port}/api/openapi.json")).await;
    assert!(response.text().await.unwrap().contains("\"openapi\""));

    handle.abort();
}

#[test]
fn resolve_data_dir_uses_home_by_default() {
    let _guard = ENV_LOCK.lock().unwrap();
    unsafe {
        std::env::remove_var("HUBRIS_DATA_DIR");
    }

    let home = dirs::home_dir().unwrap();
    assert_eq!(resolve_data_dir(".hubris").unwrap(), home.join(".hubris"),);
}

#[test]
fn resolve_data_dir_honors_hubris_data_dir_override() {
    let _guard = ENV_LOCK.lock().unwrap();
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("custom");
    unsafe {
        std::env::set_var("HUBRIS_DATA_DIR", &path);
    }

    let resolved = resolve_data_dir(".hubris").unwrap();
    assert_eq!(resolved, path);

    unsafe {
        std::env::remove_var("HUBRIS_DATA_DIR");
    }
}
