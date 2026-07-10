mod access;
pub mod api;
pub mod chat;
pub mod domain;
pub mod events;
mod frontend;
mod fs_sync;
pub mod git;
pub mod instance_lock;
mod keybindings_manager;
pub mod process_manager;
pub mod project_store;
pub mod pty;
mod settings_manager;
pub mod state;
pub mod tab;
pub mod task_manager;
mod vscode;
pub mod worktree_files;
pub mod worktree_path_policy;
pub mod worktree_state;

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::Extension;
use axum::Router;
use axum::http::header::CONTENT_TYPE;
use axum::http::{Method, StatusCode};
use axum::middleware;
use axum::routing::{any, delete, get, patch, post, put};
use tokio::sync::Notify;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

pub use access::{
    DESKTOP_BOOTSTRAP_PATH, DESKTOP_SESSION_COOKIE_NAME, DesktopAccess, ServerAccess,
};
use access::{desktop_auth_middleware, desktop_bootstrap_handler};
use api::ag_ui::run_codex_ag_ui_chat;
use api::chats::{
    archive_chat, delete_chat, get_chat, get_chat_activity, interrupt_chat, list_chat_models,
    list_project_worktree_chats, patch_chat_settings, resolve_chat_pending_request,
    send_chat_message, unarchive_chat,
};
use api::editor_themes::{
    delete_editor_theme, discover_editor_themes, get_editor_theme, import_extension_theme,
    list_editor_themes, upload_editor_theme,
};
use api::events::event_stream;
use api::files::{
    get_project_worktree_file_content, get_project_worktree_git_diff, list_files,
    list_project_worktree_files, put_project_worktree_file_content, rename_project_worktree_file,
};
use api::keybindings::{get_keybindings, put_keybindings};
use api::openapi::{openapi_json, spec as openapi_spec_impl};
use api::processes::{
    get_managed_process, list_managed_processes, restart_managed_process, start_managed_process,
    stop_managed_process,
};
use api::projects::{add_project, delete_project, list_projects, reorder_projects, update_project};
use api::settings::{get_settings, patch_settings, put_settings};
use api::system::get_system_info;
use api::tabs::{
    create_tab, delete_tab, list_tabs, reorder_tabs, update_tab, update_worktree_tab_layout,
};
use api::tasks::{get_task, list_task_definitions, list_tasks, start_task};
use api::terminal::ws_handler;
use api::vscode::{
    check_vscode_update, get_desktop_code_server_connection, get_desktop_vscode_cli_connection,
    get_vscode_status, install_vscode, restart_vscode, start_vscode, stop_vscode,
};
use api::worktrees::{
    create_project_worktree, delete_project_worktree, discard_project_worktree_path,
    get_project_worktree_commit_details, get_project_worktree_git_status, import_project_worktree,
    list_importable_worktrees, list_project_worktree_start_points, list_project_worktrees,
    put_worktree_restore_state, rename_worktree_branch, reorder_project_worktrees,
    stage_project_worktree_path, unstage_project_worktree_path, update_project_worktree,
};
pub use frontend::FrontendAssets;
use frontend::apply_frontend_fallback;
pub use instance_lock::{
    InstanceConflictInfo, InstanceKind, InstanceLock, InstanceLockError, InstanceLockMetadata,
    InstanceLockOptions,
};
pub use state::AppState;
use state::RestoredTerminalTab;
use vscode::proxy_code_request;
use worktree_state::ExistingWorktree;

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

/// Resolve the default server data directory for the current runtime mode.
pub fn resolve_server_data_dir(is_dev: bool) -> std::io::Result<std::path::PathBuf> {
    if let Ok(path) = std::env::var("HUBRIS_DATA_DIR") {
        return Ok(std::path::PathBuf::from(path));
    }

    if is_dev {
        let workspace_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()?;
        return Ok(workspace_root.join("tmp/data"));
    }

    resolve_data_dir(".hubris")
}

/// Create the app state for a given data directory,
/// ensuring the directory exists first.
pub async fn create_app_state(data_dir: std::path::PathBuf) -> std::io::Result<AppState> {
    tokio::fs::create_dir_all(&data_dir).await?;
    let state = AppState::try_new(data_dir).await?;
    hydrate_persisted_worktree_state(&state).await?;
    Ok(state)
}

async fn hydrate_persisted_worktree_state(state: &AppState) -> std::io::Result<()> {
    let mut existing_worktrees = Vec::new();
    for project in state.projects.list().await {
        match list_project_worktrees_for_hydration(state, &project).await {
            Ok(worktrees) => {
                for worktree in worktrees {
                    state.remember_worktree_project(&worktree.id, &project.id);
                    existing_worktrees.push(ExistingWorktree {
                        project_id: project.id.clone(),
                        worktree_id: worktree.id,
                    });
                }
            }
            Err(error) => {
                tracing::warn!(
                    project_id = project.id,
                    "failed to list worktrees during state hydration: {error}"
                );
            }
        }
    }

    let loaded = state
        .persistence
        .clone()
        .load_existing(existing_worktrees)
        .await?;
    for worktree in loaded.worktrees {
        state.remember_worktree_project(&worktree.worktree_id, &worktree.project_id);
        state
            .restore_state_by_worktree
            .insert(worktree.worktree_id.clone(), worktree.restore_state.clone());
        state.next_terminal_num_by_worktree.insert(
            worktree.worktree_id.clone(),
            worktree.next_terminal_number.max(1),
        );

        if let Some(layout) = worktree.layout {
            state
                .tab_layouts
                .insert(worktree.worktree_id.clone(), layout);
        }

        for tab in worktree.tabs {
            if tab.is_terminal() {
                let tab_id = tab.id().to_string();
                state.restored_terminal_tabs.insert(
                    tab_id.clone(),
                    RestoredTerminalTab {
                        project_id: worktree.project_id.clone(),
                        worktree_id: worktree.worktree_id.clone(),
                    },
                );
                state.terminal_restore_lock(&tab_id);
            }
            state.tabs.insert(tab.id().to_string(), tab);
        }
    }

    Ok(())
}

async fn list_project_worktrees_for_hydration(
    state: &AppState,
    project: &api::projects::Project,
) -> Result<Vec<api::worktrees::Worktree>, String> {
    api::worktrees::list_worktrees_for_project(state, project).await
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
        if base_port == 0 {
            return tokio::net::TcpListener::bind((host, 0)).await;
        }

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

const SERVER_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Declares the `/api` route table once, producing both the axum
/// sub-router constructor and the public [`API_ROUTES`] manifest so
/// the registered routes and the OpenAPI spec cannot silently drift
/// apart (see `tests/contracts.rs`).
macro_rules! api_routes {
    ($(
        $path:literal => {
            $first_method:ident: $first_handler:expr
            $(, $method:ident: $handler:expr)* $(,)?
        }
    )+) => {
        /// Every `(HTTP method, path)` pair registered on the `/api`
        /// sub-router, in registration order. Paths are relative to
        /// the `/api` prefix and use axum `{param}` syntax. Contract
        /// tests compare this manifest against the OpenAPI spec, so
        /// route and spec changes must land together.
        pub const API_ROUTES: &[(&str, &str)] = &[
            $(
                (stringify!($first_method), $path),
                $((stringify!($method), $path),)*
            )+
        ];

        /// Build the `/api` sub-router from the shared route table.
        fn api_router() -> Router<AppState> {
            Router::new()
                $(.route(
                    $path,
                    $first_method($first_handler)$(.$method($handler))*,
                ))+
        }
    };
}

api_routes! {
    "/openapi.json" => { get: openapi_json }
    "/files" => { get: list_files }
    "/projects" => { get: list_projects, post: add_project }
    "/projects/reorder" => { put: reorder_projects }
    "/projects/{id}" => { delete: delete_project, patch: update_project }
    "/projects/{id}/worktrees" => {
        get: list_project_worktrees,
        post: create_project_worktree,
    }
    "/projects/{id}/worktrees/start-points" => {
        get: list_project_worktree_start_points,
    }
    "/projects/{id}/worktrees/reorder" => { put: reorder_project_worktrees }
    "/projects/{id}/worktrees/importable" => { get: list_importable_worktrees }
    "/projects/{id}/worktrees/import" => { post: import_project_worktree }
    "/projects/{id}/worktrees/{worktree_id}" => {
        delete: delete_project_worktree,
        patch: update_project_worktree,
    }
    "/projects/{id}/worktrees/{worktree_id}/tab-layout" => {
        put: update_worktree_tab_layout,
    }
    "/projects/{id}/worktrees/{worktree_id}/restore-state" => {
        put: put_worktree_restore_state,
    }
    "/projects/{id}/worktrees/{worktree_id}/git-status" => {
        get: get_project_worktree_git_status,
    }
    "/projects/{id}/worktrees/{worktree_id}/git/commits/{commit_id}" => {
        get: get_project_worktree_commit_details,
    }
    "/projects/{id}/worktrees/{worktree_id}/git/stage" => {
        post: stage_project_worktree_path,
    }
    "/projects/{id}/worktrees/{worktree_id}/git/unstage" => {
        post: unstage_project_worktree_path,
    }
    "/projects/{id}/worktrees/{worktree_id}/git/discard" => {
        post: discard_project_worktree_path,
    }
    "/projects/{id}/worktrees/{worktree_id}/git/rename-branch" => {
        post: rename_worktree_branch,
    }
    "/projects/{id}/worktrees/{worktree_id}/files" => {
        get: list_project_worktree_files,
    }
    "/projects/{id}/worktrees/{worktree_id}/files/content" => {
        get: get_project_worktree_file_content,
        put: put_project_worktree_file_content,
    }
    "/projects/{id}/worktrees/{worktree_id}/files/rename" => {
        post: rename_project_worktree_file,
    }
    "/projects/{id}/worktrees/{worktree_id}/git/diff" => {
        get: get_project_worktree_git_diff,
    }
    "/projects/{id}/worktrees/{worktree_id}/chats" => {
        get: list_project_worktree_chats,
    }
    "/tabs" => { get: list_tabs, post: create_tab }
    "/tabs/reorder" => { put: reorder_tabs }
    "/tabs/{id}" => { delete: delete_tab, patch: update_tab }
    "/chats/models" => { get: list_chat_models }
    "/chats/{conversation_id}" => { get: get_chat, delete: delete_chat }
    "/chats/{conversation_id}/archive" => { post: archive_chat }
    "/chats/{conversation_id}/unarchive" => { post: unarchive_chat }
    "/chats/{conversation_id}/activity/{item_id}" => {
        get: get_chat_activity,
    }
    "/chats/{conversation_id}/settings" => { patch: patch_chat_settings }
    "/chats/{conversation_id}/messages" => { post: send_chat_message }
    "/chats/{conversation_id}/ag-ui" => { post: run_codex_ag_ui_chat }
    "/chats/{conversation_id}/requests/{request_id}/resolve" => {
        post: resolve_chat_pending_request,
    }
    "/chats/{conversation_id}/interrupt" => { post: interrupt_chat }
    "/events" => { get: event_stream }
    "/terminal/ws" => { get: ws_handler }
    "/system" => { get: get_system_info }
    "/processes" => { get: list_managed_processes }
    "/processes/{id}" => { get: get_managed_process }
    "/processes/{id}/start" => { post: start_managed_process }
    "/processes/{id}/stop" => { post: stop_managed_process }
    "/processes/{id}/restart" => { post: restart_managed_process }
    "/tasks/definitions" => { get: list_task_definitions }
    "/tasks" => { get: list_tasks, post: start_task }
    "/tasks/{id}" => { get: get_task }
    "/vscode" => { get: get_vscode_status }
    "/vscode/check-update" => { post: check_vscode_update }
    "/vscode/install" => { post: install_vscode }
    "/vscode/start" => { post: start_vscode }
    "/vscode/stop" => { post: stop_vscode }
    "/vscode/restart" => { post: restart_vscode }
    "/settings" => {
        get: get_settings,
        put: put_settings,
        patch: patch_settings,
    }
    "/keybindings" => { get: get_keybindings, put: put_keybindings }
    "/editor-themes" => {
        get: list_editor_themes,
        post: upload_editor_theme,
    }
    "/editor-themes/discover" => { get: discover_editor_themes }
    "/editor-themes/import" => { post: import_extension_theme }
    "/editor-themes/{id}" => {
        get: get_editor_theme,
        delete: delete_editor_theme,
    }
}

/// Build the API router for a given AppState.
pub fn build_router(state: AppState) -> Router {
    build_router_with_options(state, ServerOptions::default())
}

/// Build the API router with explicit runtime options.
pub fn build_router_with_options(state: AppState, options: ServerOptions) -> Router {
    let ServerOptions { frontend, access } = options;
    let api = api_router();

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
        .route("/code/vscode-cli", any(proxy_code_request))
        .route("/code/vscode-cli/", any(proxy_code_request))
        .route("/code/vscode-cli/{*path}", any(proxy_code_request))
        .route("/code/code-server", any(proxy_code_request))
        .route("/code/code-server/", any(proxy_code_request))
        .route("/code/code-server/{*path}", any(proxy_code_request))
        .route("/code", any(|| async { StatusCode::NOT_FOUND }))
        .route("/code/", any(|| async { StatusCode::NOT_FOUND }))
        .route("/code/{*path}", any(|| async { StatusCode::NOT_FOUND }))
        .nest("/api", api);

    if access
        .desktop()
        .is_some_and(|desktop| desktop.has_bootstrap())
    {
        router = router.route(DESKTOP_BOOTSTRAP_PATH, get(desktop_bootstrap_handler));
    }

    if access.desktop().is_some() {
        router = router.route(
            "/_hubris/vscode/vscode-cli/connection",
            get(get_desktop_vscode_cli_connection),
        );
        router = router.route(
            "/_hubris/vscode/code-server/connection",
            get(get_desktop_code_server_connection),
        );
    }

    let router = router.with_state(state);

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
    run_server_with_shutdown(listener, data_dir, options, std::future::pending()).await
}

/// Run the Hubris server on an existing listener until either the
/// server exits or the provided shutdown signal resolves.
pub async fn run_server_with_shutdown<F>(
    listener: tokio::net::TcpListener,
    data_dir: std::path::PathBuf,
    options: ServerOptions,
    shutdown: F,
) -> std::io::Result<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    run_server_with_shutdown_and_lock(listener, data_dir, options, shutdown, None).await
}

/// Run the Hubris server on an existing listener while holding an optional
/// data-directory instance lock for the server lifetime.
pub async fn run_server_with_shutdown_and_lock<F>(
    listener: tokio::net::TcpListener,
    data_dir: std::path::PathBuf,
    options: ServerOptions,
    shutdown: F,
    instance_lock: Option<InstanceLock>,
) -> std::io::Result<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    let _instance_lock = instance_lock;
    let state = create_app_state(data_dir).await?;
    let persistence = state.persistence.clone();
    let app = build_router_with_options(state.clone(), options);
    let shutdown_signal = Arc::new(ShutdownSignal::default());
    let signal_task = {
        let shutdown_signal = shutdown_signal.clone();
        tokio::spawn(async move {
            shutdown.await;
            shutdown_signal.trigger();
        })
    };

    let shutdown_wait = shutdown_signal.clone();
    let server = axum::serve(listener, app).with_graceful_shutdown(async move {
        shutdown_wait.wait().await;
    });
    let mut server_task = tokio::spawn(async move { server.await.map_err(std::io::Error::other) });

    let result = tokio::select! {
        result = &mut server_task => {
            signal_task.abort();
            result.map_err(std::io::Error::other)?
        }
        _ = shutdown_signal.clone().wait() => {
            if let Err(error) = state.processes.shutdown_all().await {
                tracing::warn!("failed to shut down managed processes: {error}");
            }

            let result = match tokio::time::timeout(
                SERVER_SHUTDOWN_TIMEOUT,
                &mut server_task,
            ).await {
                Ok(result) => result.map_err(std::io::Error::other)?,
                Err(_) => {
                    tracing::warn!(
                        "server did not stop after {:?}; aborting open connections",
                        SERVER_SHUTDOWN_TIMEOUT
                    );
                    server_task.abort();
                    let _ = server_task.await;
                    Ok(())
                }
            };
            signal_task.abort();
            if let Err(error) = persistence.clone().shutdown().await {
                tracing::warn!("failed to flush persisted worktree state: {error}");
            }
            result
        }
    };

    if !shutdown_signal.is_triggered()
        && let Err(error) = state.processes.shutdown_all().await
    {
        tracing::warn!("failed to shut down managed processes: {error}");
    }
    if !shutdown_signal.is_triggered()
        && let Err(error) = persistence.clone().shutdown().await
    {
        tracing::warn!("failed to flush persisted worktree state: {error}");
    }

    result
}

#[derive(Default)]
struct ShutdownSignal {
    triggered: AtomicBool,
    notify: Notify,
}

impl ShutdownSignal {
    fn trigger(&self) {
        self.triggered.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    fn is_triggered(&self) -> bool {
        self.triggered.load(Ordering::SeqCst)
    }

    async fn wait(self: Arc<Self>) {
        loop {
            let notified = self.notify.notified();
            if self.is_triggered() {
                return;
            }
            notified.await;
        }
    }
}

pub fn openapi_spec() -> utoipa::openapi::OpenApi {
    openapi_spec_impl()
}
