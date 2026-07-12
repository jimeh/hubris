use std::time::{SystemTime, UNIX_EPOCH};

/// Return the current Unix timestamp in milliseconds.
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Return the identifier for the default session.
pub(crate) fn default_session_id() -> String {
    "default".to_string()
}
