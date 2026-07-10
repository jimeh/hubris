use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use utoipa::ToSchema;

use crate::chat::{ChatErrorKind, ChatServiceError};

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ApiErrorResponse {
    pub message: String,
}

/// A JSON error returned by a REST API handler.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    /// Create a `400 Bad Request` error.
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::with_status(StatusCode::BAD_REQUEST, message)
    }

    /// Create a `403 Forbidden` error.
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::with_status(StatusCode::FORBIDDEN, message)
    }

    /// Create a `404 Not Found` error.
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::with_status(StatusCode::NOT_FOUND, message)
    }

    /// Create a `409 Conflict` error.
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::with_status(StatusCode::CONFLICT, message)
    }

    /// Create a `500 Internal Server Error` error.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::with_status(StatusCode::INTERNAL_SERVER_ERROR, message)
    }

    /// Create a `502 Bad Gateway` error.
    pub fn bad_gateway(message: impl Into<String>) -> Self {
        Self::with_status(StatusCode::BAD_GATEWAY, message)
    }

    /// Create an error with an explicit HTTP status.
    pub fn with_status(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    pub(crate) fn status(&self) -> StatusCode {
        self.status
    }
}

impl From<ChatServiceError> for ApiError {
    fn from(error: ChatServiceError) -> Self {
        let status = match error.kind {
            ChatErrorKind::BadRequest => StatusCode::BAD_REQUEST,
            ChatErrorKind::NotFound => StatusCode::NOT_FOUND,
            ChatErrorKind::Conflict => StatusCode::CONFLICT,
            ChatErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
            ChatErrorKind::Upstream => StatusCode::BAD_GATEWAY,
        };
        Self::with_status(status, error.message)
    }
}

impl From<crate::task_manager::TaskActionError> for ApiError {
    fn from(error: crate::task_manager::TaskActionError) -> Self {
        use crate::task_manager::TaskActionErrorKind;
        let status = match error.kind() {
            TaskActionErrorKind::NotFound => StatusCode::NOT_FOUND,
            TaskActionErrorKind::InvalidRequest => StatusCode::BAD_REQUEST,
            TaskActionErrorKind::Conflict => StatusCode::CONFLICT,
            TaskActionErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self::with_status(status, error.message())
    }
}

impl From<crate::process_manager::ManagedProcessActionError> for ApiError {
    fn from(error: crate::process_manager::ManagedProcessActionError) -> Self {
        use crate::process_manager::ManagedProcessActionErrorKind;
        let status = match error.kind() {
            ManagedProcessActionErrorKind::NotFound => StatusCode::NOT_FOUND,
            ManagedProcessActionErrorKind::InvalidRequest => StatusCode::BAD_REQUEST,
            ManagedProcessActionErrorKind::Conflict => StatusCode::CONFLICT,
            ManagedProcessActionErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self::with_status(status, error.message())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ApiErrorResponse {
                message: self.message,
            }),
        )
            .into_response()
    }
}
