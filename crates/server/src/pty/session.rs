/// PTY session tracking.
///
/// For the initial implementation, PTY sessions are ephemeral —
/// they live only as long as the WebSocket is connected. The
/// handle_terminal function in api/terminal.rs manages the
/// lifecycle directly. This struct exists for future use when
/// we add session persistence and reconnection.
pub struct PtySession {
    pub id: String,
    pub created_at: std::time::Instant,
}
