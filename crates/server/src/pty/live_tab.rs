use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{Child, MasterPty, PtySize};
use serde::Serialize;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use ts_rs::TS;
use utoipa::ToSchema;

/// Default scrollback buffer size in bytes (~128KB).
/// Passed to `LiveTab::spawn()` so it can be overridden
/// per-tab in the future (e.g., from user settings).
pub const DEFAULT_SCROLLBACK: usize = 128 * 1024;
pub const DEFAULT_PTY_COLS: u16 = 80;
pub const DEFAULT_PTY_ROWS: u16 = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

impl TerminalSize {
    pub const fn new(cols: u16, rows: u16) -> Self {
        Self { cols, rows }
    }

    pub const fn default_pty() -> Self {
        Self::new(DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS)
    }

    pub const fn to_pty_size(self) -> PtySize {
        PtySize {
            rows: self.rows,
            cols: self.cols,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

/// Serializable tab metadata. Sent to clients via REST
/// and SSE.
#[derive(Debug, Clone, Serialize, ToSchema, TS)]
pub struct TabInfo {
    pub id: String,
    pub session_id: String,
    pub worktree_id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub tab_type: String,
    pub position: f64,
    #[ts(type = "number")]
    pub created_at: u64,
}

/// A live terminal tab with its PTY, scrollback buffer,
/// and broadcast channels for output fan-out and close
/// notification.
pub struct LiveTab {
    info: Mutex<TabInfo>,
    pub pty_master: Mutex<Box<dyn MasterPty + Send>>,
    pub pty_writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    pub scrollback: Arc<Mutex<VecDeque<u8>>>,
    /// Monotonic count of all bytes ever output by the PTY.
    /// Used for resumable WebSocket reconnection.
    total_bytes: Arc<AtomicU64>,
    pub output_tx: broadcast::Sender<Vec<u8>>,
    pty_size_tx: broadcast::Sender<TerminalSize>,
    pub close_tx: broadcast::Sender<()>,
    next_attachment_id: AtomicU64,
    attachments: Mutex<AttachmentRegistry>,
    resize_update_lock: Mutex<()>,
    _reader_handle: JoinHandle<()>,
}

pub struct LiveTabAttachment {
    pub attachment_id: u64,
    pub scrollback: Vec<u8>,
    pub current_size: TerminalSize,
    pub byte_offset: u64,
    pub data_lost: bool,
    pub output_rx: broadcast::Receiver<Vec<u8>>,
    pub pty_size_rx: broadcast::Receiver<TerminalSize>,
    pub close_rx: broadcast::Receiver<()>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AttachmentUpdate {
    candidate_size: Option<TerminalSize>,
    shared_size: TerminalSize,
}

impl LiveTab {
    /// Spawn a new LiveTab from an already-opened PTY pair
    /// and child process. Starts a background reader task
    /// that feeds scrollback and broadcasts output.
    pub fn spawn(
        info: TabInfo,
        master: Box<dyn MasterPty + Send>,
        child: Box<dyn Child + Send + Sync>,
        scrollback_size: usize,
        initial_size: TerminalSize,
    ) -> Self {
        let mut reader = master.try_clone_reader().unwrap();
        let writer = master.take_writer().unwrap();

        let scrollback = Arc::new(Mutex::new(VecDeque::with_capacity(scrollback_size)));
        let total_bytes = Arc::new(AtomicU64::new(0));
        let (output_tx, _) = broadcast::channel(64);
        let (pty_size_tx, _) = broadcast::channel(16);
        let (close_tx, _) = broadcast::channel(1);

        let sb = scrollback.clone();
        let tb = total_bytes.clone();
        let tx = output_tx.clone();
        let ctx = close_tx.clone();

        let reader_handle = tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        {
                            let mut sb = sb.lock().unwrap();
                            for &byte in &data {
                                if sb.len() >= scrollback_size {
                                    sb.pop_front();
                                }
                                sb.push_back(byte);
                            }
                        }
                        tb.fetch_add(n as u64, Ordering::Relaxed);
                        let _ = tx.send(data);
                    }
                    Err(_) => break,
                }
            }
            // Shell exited
            let _ = ctx.send(());
        });

        Self {
            info: Mutex::new(info),
            pty_master: Mutex::new(master),
            pty_writer: Mutex::new(writer),
            child: Mutex::new(child),
            scrollback,
            total_bytes,
            output_tx,
            pty_size_tx,
            close_tx,
            next_attachment_id: AtomicU64::new(1),
            attachments: Mutex::new(AttachmentRegistry::new(initial_size)),
            resize_update_lock: Mutex::new(()),
            _reader_handle: reader_handle,
        }
    }

    /// Get a snapshot of current tab metadata.
    pub fn info(&self) -> TabInfo {
        self.info.lock().unwrap().clone()
    }

    /// Update tab metadata under lock. Returns the updated
    /// snapshot.
    pub fn update_info(&self, f: impl FnOnce(&mut TabInfo) -> TabInfo) -> TabInfo {
        let mut info = self.info.lock().unwrap();
        f(&mut info)
    }

    /// Attach to this tab's output stream. Returns:
    /// - scrollback snapshot (missed bytes, or full buffer)
    /// - byte_offset (total bytes ever output — the
    ///   client's new position counter)
    /// - data_lost (true if gap exceeds scrollback; client
    ///   should clear its terminal before writing snapshot)
    /// - output receiver (live PTY output)
    /// - close receiver (shell exit notification)
    ///
    /// Lock ordering: scrollback mutex held while
    /// subscribing to output channel guarantees no output
    /// is missed between snapshot and subscription.
    pub fn attach(&self, resume_from: Option<u64>) -> LiveTabAttachment {
        let sb = self.scrollback.lock().unwrap();
        let total = self.total_bytes.load(Ordering::Relaxed);
        let attachment_id = self.next_attachment_id.fetch_add(1, Ordering::Relaxed);
        let current_size = {
            let mut attachments = self.attachments.lock().unwrap();
            attachments.insert(attachment_id, Instant::now());
            attachments.shared_size()
        };

        let (snapshot, data_lost) = match resume_from {
            None => {
                // First connect: send full scrollback
                (sb.iter().copied().collect(), false)
            }
            Some(pos) if pos >= total => {
                // Client is caught up (or somehow ahead)
                (Vec::new(), false)
            }
            Some(pos) => {
                let missed = (total - pos) as usize;
                if missed <= sb.len() {
                    // Gap fits in scrollback — send tail
                    let start = sb.len() - missed;
                    (sb.iter().skip(start).copied().collect(), false)
                } else {
                    // Gap exceeds scrollback — data lost
                    (sb.iter().copied().collect(), true)
                }
            }
        };

        let output_rx = self.output_tx.subscribe();
        let pty_size_rx = self.pty_size_tx.subscribe();
        let close_rx = self.close_tx.subscribe();
        LiveTabAttachment {
            attachment_id,
            scrollback: snapshot,
            current_size,
            byte_offset: total,
            data_lost,
            output_rx,
            pty_size_rx,
            close_rx,
        }
    }

    pub fn update_attachment_size(&self, attachment_id: u64, size: TerminalSize, visible: bool) {
        self.apply_attachment_update(attachment_id, Some(size), visible);
    }

    pub fn invalidate_attachment_size(&self, attachment_id: u64, visible: bool) {
        self.apply_attachment_update(attachment_id, None, visible);
    }

    pub fn detach(&self, attachment_id: u64) {
        let _resize_update_guard = self.resize_update_lock.lock().unwrap();
        let update = {
            let mut attachments = self.attachments.lock().unwrap();
            attachments.remove(attachment_id)
        };

        self.apply_resize_update(update);
    }

    pub fn touch_attachment(&self, attachment_id: u64) {
        let mut attachments = self.attachments.lock().unwrap();
        attachments.touch(attachment_id, Instant::now());
    }

    pub fn attachment_is_stale(
        &self,
        attachment_id: u64,
        now: Instant,
        stale_after: Duration,
    ) -> bool {
        let attachments = self.attachments.lock().unwrap();
        attachments.is_stale(attachment_id, now, stale_after)
    }

    fn apply_attachment_update(
        &self,
        attachment_id: u64,
        size: Option<TerminalSize>,
        visible: bool,
    ) {
        let _resize_update_guard = self.resize_update_lock.lock().unwrap();
        let update = {
            let mut attachments = self.attachments.lock().unwrap();
            attachments.update(attachment_id, size, visible)
        };

        self.apply_resize_update(update);
    }

    fn apply_resize_update(&self, update: Option<AttachmentUpdate>) {
        let Some(update) = update else {
            return;
        };

        if let Some(size) = update.candidate_size
            && self.resize_pty(size)
        {
            let mut attachments = self.attachments.lock().unwrap();
            attachments.commit_shared_size(update.shared_size);
        }
    }

    fn resize_pty(&self, size: TerminalSize) -> bool {
        let master = self.pty_master.lock().unwrap();
        if let Err(error) = master.resize(size.to_pty_size()) {
            tracing::warn!(
                "failed to resize PTY to {}x{}: {}",
                size.cols,
                size.rows,
                error
            );
            return false;
        }

        let _ = self.pty_size_tx.send(size);
        true
    }

    /// Notify all attached clients that this tab is
    /// closing. Called by `delete_tab` for explicit closure.
    pub fn notify_close(&self) {
        let _ = self.close_tx.send(());
    }

    /// Kill the child process and wait for exit.
    pub fn kill(&self) {
        let mut child = self.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(test)]
    fn lock_resize_updates_for_test(&self) -> std::sync::MutexGuard<'_, ()> {
        self.resize_update_lock.lock().unwrap()
    }
}

impl Drop for LiveTab {
    fn drop(&mut self) {
        self.kill();
        self._reader_handle.abort();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AttachmentInfo {
    visible: bool,
    size: Option<TerminalSize>,
    last_seen: Instant,
}

#[derive(Debug)]
struct AttachmentRegistry {
    entries: HashMap<u64, AttachmentInfo>,
    shared_size: TerminalSize,
}

impl AttachmentRegistry {
    fn new(shared_size: TerminalSize) -> Self {
        Self {
            entries: HashMap::new(),
            shared_size,
        }
    }

    fn insert(&mut self, attachment_id: u64, now: Instant) {
        self.entries.insert(
            attachment_id,
            AttachmentInfo {
                visible: false,
                size: None,
                last_seen: now,
            },
        );
    }

    fn update(
        &mut self,
        attachment_id: u64,
        size: Option<TerminalSize>,
        visible: bool,
    ) -> Option<AttachmentUpdate> {
        let entry = self.entries.get_mut(&attachment_id)?;
        entry.visible = visible;
        entry.size = size;
        Some(self.candidate_update())
    }

    fn remove(&mut self, attachment_id: u64) -> Option<AttachmentUpdate> {
        self.entries.remove(&attachment_id)?;
        Some(self.candidate_update())
    }

    fn touch(&mut self, attachment_id: u64, now: Instant) -> bool {
        let Some(entry) = self.entries.get_mut(&attachment_id) else {
            return false;
        };

        entry.last_seen = now;
        true
    }

    fn is_stale(&self, attachment_id: u64, now: Instant, stale_after: Duration) -> bool {
        self.entries
            .get(&attachment_id)
            .map(|entry| now.duration_since(entry.last_seen) >= stale_after)
            .unwrap_or(false)
    }

    fn shared_size(&self) -> TerminalSize {
        self.shared_size
    }

    fn commit_shared_size(&mut self, size: TerminalSize) {
        self.shared_size = size;
    }

    fn candidate_update(&self) -> AttachmentUpdate {
        let next = self
            .entries
            .values()
            .filter(|entry| entry.visible)
            .filter_map(|entry| entry.size)
            .reduce(|acc, size| TerminalSize {
                cols: acc.cols.min(size.cols),
                rows: acc.rows.min(size.rows),
            });

        AttachmentUpdate {
            candidate_size: next.filter(|next| *next != self.shared_size),
            shared_size: next.unwrap_or(self.shared_size),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration as StdDuration;
    use std::time::Duration;

    use portable_pty::{CommandBuilder, NativePtySystem, PtySystem};
    use tokio::time::Instant;

    use super::{AttachmentRegistry, DEFAULT_SCROLLBACK, LiveTab, TabInfo, TerminalSize};

    fn spawn_test_live_tab() -> Arc<LiveTab> {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(TerminalSize::default_pty().to_pty_size())
            .unwrap();

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("cat");
        cmd.env("TERM", "xterm-256color");

        let child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);

        Arc::new(LiveTab::spawn(
            TabInfo {
                id: "tab".to_string(),
                session_id: "default".to_string(),
                worktree_id: "worktree".to_string(),
                label: "Terminal 1".to_string(),
                tab_type: "terminal".to_string(),
                position: 1.0,
                created_at: 0,
            },
            pair.master,
            child,
            DEFAULT_SCROLLBACK,
            TerminalSize::default_pty(),
        ))
    }

    #[test]
    fn attachment_registry_uses_smallest_visible_size() {
        let mut registry = AttachmentRegistry::new(TerminalSize::default_pty());
        let now = Instant::now();
        registry.insert(1, now);
        registry.insert(2, now);

        let first = registry
            .update(1, Some(TerminalSize::new(120, 40)), true)
            .unwrap();
        assert_eq!(first.candidate_size, Some(TerminalSize::new(120, 40)));
        registry.commit_shared_size(first.shared_size);

        let second = registry
            .update(2, Some(TerminalSize::new(90, 30)), true)
            .unwrap();
        assert_eq!(second.candidate_size, Some(TerminalSize::new(90, 30)));
        registry.commit_shared_size(second.shared_size);
        assert_eq!(registry.shared_size(), TerminalSize::new(90, 30));
    }

    #[test]
    fn attachment_registry_grows_when_smallest_client_disconnects() {
        let mut registry = AttachmentRegistry::new(TerminalSize::new(90, 30));
        let now = Instant::now();
        registry.insert(1, now);
        registry.insert(2, now);
        let first = registry
            .update(1, Some(TerminalSize::new(120, 40)), true)
            .unwrap();
        registry.commit_shared_size(first.shared_size);
        let second = registry
            .update(2, Some(TerminalSize::new(90, 30)), true)
            .unwrap();
        registry.commit_shared_size(second.shared_size);

        let removed = registry.remove(2).unwrap();
        assert_eq!(removed.candidate_size, Some(TerminalSize::new(120, 40)));
        registry.commit_shared_size(removed.shared_size);
        assert_eq!(registry.shared_size(), TerminalSize::new(120, 40));
    }

    #[test]
    fn attachment_registry_ignores_hidden_clients() {
        let mut registry = AttachmentRegistry::new(TerminalSize::new(120, 40));
        let now = Instant::now();
        registry.insert(1, now);
        registry.insert(2, now);
        let first = registry
            .update(1, Some(TerminalSize::new(120, 40)), true)
            .unwrap();
        registry.commit_shared_size(first.shared_size);
        let second = registry
            .update(2, Some(TerminalSize::new(80, 20)), false)
            .unwrap();
        assert_eq!(second.candidate_size, None);

        assert_eq!(registry.shared_size(), TerminalSize::new(120, 40));
    }

    #[test]
    fn attachment_registry_preserves_size_without_visible_clients() {
        let mut registry = AttachmentRegistry::new(TerminalSize::new(90, 30));
        let now = Instant::now();
        registry.insert(1, now);
        let first = registry
            .update(1, Some(TerminalSize::new(90, 30)), true)
            .unwrap();
        registry.commit_shared_size(first.shared_size);

        let hidden = registry.update(1, None, false).unwrap();
        assert_eq!(hidden.candidate_size, None);
        assert_eq!(registry.shared_size(), TerminalSize::new(90, 30));
    }

    #[test]
    fn attachment_registry_does_not_commit_candidate_until_explicitly_applied() {
        let mut registry = AttachmentRegistry::new(TerminalSize::new(120, 40));
        let now = Instant::now();
        registry.insert(1, now);
        registry.insert(2, now);

        let first = registry
            .update(1, Some(TerminalSize::new(120, 40)), true)
            .unwrap();
        registry.commit_shared_size(first.shared_size);

        let second = registry
            .update(2, Some(TerminalSize::new(90, 30)), true)
            .unwrap();
        assert_eq!(second.candidate_size, Some(TerminalSize::new(90, 30)));
        assert_eq!(registry.shared_size(), TerminalSize::new(120, 40));
    }

    #[test]
    fn attachment_registry_starts_fresh_and_becomes_stale_after_timeout() {
        let mut registry = AttachmentRegistry::new(TerminalSize::default_pty());
        let now = Instant::now();
        registry.insert(1, now);

        assert!(!registry.is_stale(1, now + Duration::from_secs(44), Duration::from_secs(45)));
        assert!(registry.is_stale(1, now + Duration::from_secs(45), Duration::from_secs(45)));
    }

    #[test]
    fn attachment_registry_touch_refreshes_last_seen() {
        let mut registry = AttachmentRegistry::new(TerminalSize::default_pty());
        let now = Instant::now();
        registry.insert(1, now);

        assert!(registry.touch(1, now + Duration::from_secs(20)));
        assert!(!registry.is_stale(1, now + Duration::from_secs(64), Duration::from_secs(45)));
        assert!(registry.is_stale(1, now + Duration::from_secs(65), Duration::from_secs(45)));
    }

    #[test]
    fn hidden_stale_attachment_detaches_without_changing_shared_size() {
        let mut registry = AttachmentRegistry::new(TerminalSize::new(120, 40));
        let now = Instant::now();
        registry.insert(1, now);
        registry.insert(2, now);

        let visible = registry
            .update(1, Some(TerminalSize::new(120, 40)), true)
            .unwrap();
        registry.commit_shared_size(visible.shared_size);

        registry
            .update(2, Some(TerminalSize::new(80, 20)), false)
            .unwrap();

        assert!(registry.is_stale(2, now + Duration::from_secs(45), Duration::from_secs(45)));

        let removed = registry.remove(2).unwrap();
        assert_eq!(removed.candidate_size, None);
        assert_eq!(registry.shared_size(), TerminalSize::new(120, 40));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resize_updates_are_serialized() {
        let tab = spawn_test_live_tab();
        let first_attachment = tab.attach(None).attachment_id;
        let second_attachment = tab.attach(None).attachment_id;
        let resize_guard = tab.lock_resize_updates_for_test();
        let (tx, rx) = mpsc::channel();
        let tab_for_thread = tab.clone();

        let update_thread = thread::spawn(move || {
            tab_for_thread.update_attachment_size(
                first_attachment,
                TerminalSize::new(120, 40),
                true,
            );
            tab_for_thread.update_attachment_size(
                second_attachment,
                TerminalSize::new(90, 30),
                true,
            );
            tx.send(()).unwrap();
        });

        assert!(rx.recv_timeout(StdDuration::from_millis(50)).is_err());

        drop(resize_guard);

        rx.recv_timeout(StdDuration::from_secs(1)).unwrap();
        update_thread.join().unwrap();
    }
}
