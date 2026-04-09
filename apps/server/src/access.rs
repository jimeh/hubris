use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::extract::{Extension, Query, Request};
use axum::http::header::{CACHE_CONTROL, LOCATION, SET_COOKIE};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

pub const DESKTOP_BOOTSTRAP_PATH: &str = "/_hubris/desktop/bootstrap";
pub const DESKTOP_SESSION_COOKIE_NAME: &str = "hubris_desktop_session";

/// Access mode for the Hubris server runtime.
#[derive(Clone, Debug, Default)]
pub enum ServerAccess {
    /// No additional auth; current standalone server behavior.
    #[default]
    Open,
    /// Require a desktop-issued session for protected requests.
    DesktopLocked(DesktopAccess),
}

impl ServerAccess {
    pub fn is_desktop_locked(&self) -> bool {
        matches!(self, Self::DesktopLocked(_))
    }

    pub fn desktop(&self) -> Option<&DesktopAccess> {
        match self {
            Self::Open => None,
            Self::DesktopLocked(access) => Some(access),
        }
    }
}

/// Desktop auth configuration.
#[derive(Clone)]
pub struct DesktopAccess {
    session_token: Arc<str>,
    bootstrap: Option<Arc<DesktopBootstrap>>,
    protect_frontend: bool,
}

impl fmt::Debug for DesktopAccess {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DesktopAccess")
            .field("protect_frontend", &self.protect_frontend)
            .field("has_bootstrap", &self.bootstrap.is_some())
            .finish()
    }
}

impl DesktopAccess {
    /// Desktop packaged app mode: protect frontend and backend,
    /// and allow a one-time bootstrap exchange.
    pub fn packaged(session_token: impl Into<String>, bootstrap_token: impl Into<String>) -> Self {
        Self {
            session_token: Arc::from(session_token.into()),
            bootstrap: Some(Arc::new(DesktopBootstrap::new(bootstrap_token.into()))),
            protect_frontend: true,
        }
    }

    /// Desktop dev mode for a separate frontend dev server:
    /// protect backend only and rely on the frontend origin to
    /// perform the bootstrap exchange.
    pub fn api_only(session_token: impl Into<String>) -> Self {
        Self {
            session_token: Arc::from(session_token.into()),
            bootstrap: None,
            protect_frontend: false,
        }
    }

    pub fn has_bootstrap(&self) -> bool {
        self.bootstrap.is_some()
    }

    fn requires_session(&self, path: &str) -> bool {
        self.protect_frontend
            || path.starts_with("/api")
            || path == "/code"
            || path.starts_with("/code/")
    }

    fn is_bootstrap_path(&self, path: &str) -> bool {
        self.bootstrap.is_some() && path == DESKTOP_BOOTSTRAP_PATH
    }

    fn has_valid_session_cookie(&self, headers: &HeaderMap) -> bool {
        parse_cookie(headers, DESKTOP_SESSION_COOKIE_NAME)
            .is_some_and(|value| value == self.session_token.as_ref())
    }

    fn consume_bootstrap(&self, token: &str) -> bool {
        self.bootstrap
            .as_ref()
            .is_some_and(|bootstrap| bootstrap.consume(token))
    }

    fn session_cookie_header_value(&self) -> String {
        format!(
            "{DESKTOP_SESSION_COOKIE_NAME}={}; Path=/; HttpOnly; SameSite=Strict",
            self.session_token
        )
    }
}

#[derive(Debug)]
struct DesktopBootstrap {
    token: Arc<str>,
    spent: AtomicBool,
}

impl DesktopBootstrap {
    fn new(token: String) -> Self {
        Self {
            token: Arc::from(token),
            spent: AtomicBool::new(false),
        }
    }

    fn consume(&self, token: &str) -> bool {
        if token != self.token.as_ref() {
            return false;
        }

        self.spent
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
}

#[derive(Debug, Deserialize)]
pub struct DesktopBootstrapQuery {
    token: String,
}

pub async fn desktop_auth_middleware(req: Request, next: Next) -> Response {
    let access = req.extensions().get::<DesktopAccess>().cloned();
    let Some(access) = access else {
        return next.run(req).await;
    };

    let path = req.uri().path();
    if access.is_bootstrap_path(path) || !access.requires_session(path) {
        return next.run(req).await;
    }

    if access.has_valid_session_cookie(req.headers()) {
        return next.run(req).await;
    }

    StatusCode::UNAUTHORIZED.into_response()
}

pub async fn desktop_bootstrap_handler(
    Extension(access): Extension<DesktopAccess>,
    Query(params): Query<DesktopBootstrapQuery>,
) -> Response {
    if !access.consume_bootstrap(&params.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    (
        StatusCode::FOUND,
        [
            (LOCATION, "/"),
            (CACHE_CONTROL, "no-store"),
            (SET_COOKIE, &access.session_cookie_header_value()),
        ],
    )
        .into_response()
}

fn parse_cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let cookie = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    for part in cookie.split(';') {
        let Some((key, value)) = part.trim().split_once('=') else {
            continue;
        };
        if key == name {
            return Some(value);
        }
    }
    None
}
