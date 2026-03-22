use axum::http::StatusCode;

use crate::worktree_files::WorktreeFileError;

pub fn map_worktree_file_error(error: WorktreeFileError) -> StatusCode {
    match error {
        WorktreeFileError::InvalidPath | WorktreeFileError::InvalidName => StatusCode::BAD_REQUEST,
        WorktreeFileError::NotFound | WorktreeFileError::NotDirectory => StatusCode::NOT_FOUND,
        WorktreeFileError::Conflict => StatusCode::CONFLICT,
        WorktreeFileError::PermissionDenied => StatusCode::FORBIDDEN,
        WorktreeFileError::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
