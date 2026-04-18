use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use hubris_server::{
    FrontendAssets, ServerOptions, build_router_with_options, create_app_state, resolve_data_dir,
    resolve_server_data_dir, run_server, run_server_with_shutdown,
};
use sqlx::Connection as _;
use sqlx::SqliteConnection;
use sqlx::sqlite::SqliteConnectOptions;
use tempfile::TempDir;
use tokio::sync::oneshot;

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

#[tokio::test]
async fn run_server_with_shutdown_stops_on_signal() {
    let temp = TempDir::new().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let handle = tokio::spawn(async move {
        run_server_with_shutdown(
            listener,
            temp.path().join("data"),
            ServerOptions::default(),
            async move {
                let _ = shutdown_rx.await;
            },
        )
        .await
        .unwrap();
    });

    let response = wait_for_ok(&format!("http://127.0.0.1:{port}/api/openapi.json")).await;
    assert!(response.text().await.unwrap().contains("\"openapi\""));

    shutdown_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), handle)
        .await
        .expect("server did not stop after shutdown signal")
        .unwrap();
}

#[tokio::test]
async fn run_server_with_shutdown_stops_with_open_event_stream() {
    let temp = TempDir::new().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let handle = tokio::spawn(async move {
        run_server_with_shutdown(
            listener,
            temp.path().join("data"),
            ServerOptions::default(),
            async move {
                let _ = shutdown_rx.await;
            },
        )
        .await
        .unwrap();
    });

    let _stream = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/api/events"))
        .send()
        .await
        .unwrap();

    shutdown_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(4), handle)
        .await
        .expect("server did not stop with open event stream")
        .unwrap();
}

#[tokio::test]
async fn create_app_state_returns_error_for_unrecognized_state_db() {
    let temp = TempDir::new().unwrap();
    let data_dir = temp.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    let db_path = data_dir.join("state.sqlite3");

    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true);
    let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query("CREATE TABLE legacy_state (id TEXT PRIMARY KEY)")
        .execute(&mut conn)
        .await
        .unwrap();
    drop(conn);

    let error = match create_app_state(data_dir).await {
        Ok(_) => panic!("expected invalid state DB to fail app-state creation"),
        Err(error) => error,
    };
    assert!(
        error
            .to_string()
            .contains("is not a valid sqlx-managed Hubris state DB"),
        "{error}"
    );
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

#[test]
fn resolve_server_data_dir_uses_repo_local_tmp_data_in_dev() {
    let _guard = ENV_LOCK.lock().unwrap();
    let temp = TempDir::new().unwrap();
    let original_cwd = std::env::current_dir().unwrap();
    let server_dir = temp.path().join("apps/server");
    std::fs::create_dir_all(&server_dir).unwrap();
    unsafe {
        std::env::remove_var("HUBRIS_DATA_DIR");
    }
    std::env::set_current_dir(server_dir).unwrap();

    let resolved = resolve_server_data_dir(true).unwrap();

    let expected_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    assert_eq!(resolved, expected_root.join("tmp/data"));

    std::env::set_current_dir(original_cwd).unwrap();
}

#[test]
fn hubris_server_exits_when_data_dir_lock_is_held() {
    let temp = TempDir::new().unwrap();
    let data_dir = temp.path().join("data");
    let mut first = Command::new(env!("CARGO_BIN_EXE_hubris-server"))
        .env("HUBRIS_DATA_DIR", &data_dir)
        .env("HUBRIS_HOST", "127.0.0.1")
        .env("HUBRIS_PORT", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let lock_path = data_dir.join("instance.lock");
    for _ in 0..40 {
        if let Ok(contents) = std::fs::read_to_string(&lock_path)
            && !contents.trim().is_empty()
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    let mut second = Command::new(env!("CARGO_BIN_EXE_hubris-server"))
        .env("HUBRIS_DATA_DIR", &data_dir)
        .env("HUBRIS_HOST", "127.0.0.1")
        .env("HUBRIS_PORT", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let start = std::time::Instant::now();
    loop {
        if let Some(status) = second.try_wait().unwrap() {
            assert!(!status.success());
            break;
        }
        if start.elapsed() > Duration::from_secs(2) {
            let _ = second.kill();
            panic!("second hubris-server instance did not exit on lock conflict");
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    let output = second.wait_with_output().unwrap();
    let _ = first.kill();
    let _ = first.wait();

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("already running for data dir"),
        "expected lock conflict in stderr, got: {stderr}"
    );
}
