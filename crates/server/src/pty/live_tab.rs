use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{Child, MasterPty, PtySize};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::tab::TabInfo;

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

/// Scans raw PTY output for notification signals:
/// standalone BEL (0x07), OSC 9, and OSC 777.
///
/// Distinguishes standalone BEL from BEL used as an OSC
/// string terminator by tracking whether we're inside an
/// OSC sequence.
struct NotificationScanner {
    state: ScanState,
    /// Number of the current OSC sequence being parsed
    /// (e.g. 9 for OSC 9, 777 for OSC 777). Only valid
    /// while `state` is `Osc` or `OscNumber`.
    osc_number: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ScanState {
    /// Not inside any escape sequence.
    Normal,
    /// Saw ESC (0x1b), waiting for next byte.
    Esc,
    /// Inside an OSC sequence number (digits after `]`).
    OscNumber,
    /// Inside an OSC sequence payload (after `;`).
    Osc,
}

impl NotificationScanner {
    fn new() -> Self {
        Self {
            state: ScanState::Normal,
            osc_number: 0,
        }
    }

    /// Scan a chunk of PTY output. Returns `true` if any
    /// notification signal was detected in this chunk.
    fn scan(&mut self, data: &[u8]) -> bool {
        let mut notified = false;
        for &byte in data {
            match self.state {
                ScanState::Normal => match byte {
                    0x07 => notified = true,
                    0x1b => self.state = ScanState::Esc,
                    _ => {}
                },
                ScanState::Esc => match byte {
                    b']' => {
                        self.state = ScanState::OscNumber;
                        self.osc_number = 0;
                    }
                    _ => self.state = ScanState::Normal,
                },
                ScanState::OscNumber => match byte {
                    b'0'..=b'9' => {
                        self.osc_number = self
                            .osc_number
                            .wrapping_mul(10)
                            .wrapping_add((byte - b'0') as u32);
                    }
                    b';' => {
                        if self.osc_number == 9 || self.osc_number == 777 {
                            notified = true;
                        }
                        self.state = ScanState::Osc;
                    }
                    0x07 => {
                        // BEL terminates OSC before payload
                        self.state = ScanState::Normal;
                    }
                    0x1b => {
                        // ESC may start ST or a new sequence
                        self.state = ScanState::Esc;
                    }
                    _ => self.state = ScanState::Osc,
                },
                ScanState::Osc => match byte {
                    // BEL terminates OSC — NOT a bell
                    0x07 => self.state = ScanState::Normal,
                    // ESC starts ST (\x1b\\) — back to
                    // Normal either way
                    0x1b => self.state = ScanState::Esc,
                    _ => {}
                },
            }
        }
        notified
    }
}

/// A live terminal tab with its PTY, scrollback buffer,
/// and broadcast channels for output fan-out and close
/// notification.
pub struct LiveTab {
    info: Mutex<TabInfo>,
    pub pty_master: Mutex<Box<dyn MasterPty + Send>>,
    pub pty_writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    output_state: Arc<Mutex<OutputState>>,
    pub output_tx: broadcast::Sender<Vec<u8>>,
    pty_size_tx: broadcast::Sender<TerminalSize>,
    pub close_tx: broadcast::Sender<()>,
    pub notification_tx: broadcast::Sender<()>,
    next_attachment_id: AtomicU64,
    attachments: Mutex<AttachmentRegistry>,
    resize_update_lock: Mutex<()>,
    _reader_handle: JoinHandle<()>,
}

pub struct LiveTabAttachment {
    pub attachment_id: u64,
    pub initial_payload: Vec<u8>,
    pub snapshot: bool,
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

struct OutputState {
    scrollback: VecDeque<u8>,
    total_bytes: u64,
    parser: vt100::Parser,
}

impl OutputState {
    fn new(scrollback_size: usize, initial_size: TerminalSize) -> Self {
        Self {
            scrollback: VecDeque::with_capacity(scrollback_size),
            total_bytes: 0,
            parser: vt100::Parser::new(initial_size.rows, initial_size.cols, 0),
        }
    }

    fn record_output(&mut self, data: &[u8], scrollback_size: usize) {
        if scrollback_size > 0 {
            let retained_data = if data.len() > scrollback_size {
                &data[data.len() - scrollback_size..]
            } else {
                data
            };
            let overflow = self
                .scrollback
                .len()
                .saturating_add(retained_data.len())
                .saturating_sub(scrollback_size);
            if overflow > 0 {
                self.scrollback.drain(..overflow);
            }
            self.scrollback.extend(retained_data.iter().copied());
        }
        self.total_bytes += data.len() as u64;
        self.parser.process(data);
    }

    fn build_attach_payload(&self, resume_from: Option<u64>) -> (Vec<u8>, bool, bool) {
        match resume_from {
            None if self.total_bytes == 0 => (Vec::new(), false, false),
            None => (self.scrollback_and_snapshot(), true, false),
            Some(pos) if pos >= self.total_bytes => (Vec::new(), false, false),
            Some(pos) => {
                let missed = (self.total_bytes - pos) as usize;
                if missed <= self.scrollback.len() {
                    let start = self.scrollback.len() - missed;
                    (
                        self.scrollback.iter().skip(start).copied().collect(),
                        false,
                        false,
                    )
                } else {
                    (self.scrollback_and_snapshot(), true, true)
                }
            }
        }
    }

    /// Returns the full scrollback buffer followed by the VT100 screen
    /// snapshot. Replaying the raw scrollback bytes through xterm.js
    /// populates its scrollback buffer; the trailing snapshot then
    /// overwrites the visible screen to the correct current state.
    fn scrollback_and_snapshot(&self) -> Vec<u8> {
        let snapshot = self.snapshot_state();
        let mut payload = Vec::with_capacity(self.scrollback.len() + snapshot.len());
        let (front, back) = self.scrollback.as_slices();
        payload.extend_from_slice(front);
        payload.extend_from_slice(back);
        payload.extend(snapshot);
        payload
    }

    fn snapshot_state(&self) -> Vec<u8> {
        let mut snapshot = vec![];
        // vt100::Screen::state_formatted() restores cursor position, drawing
        // state, and input modes including xterm mouse tracking. Alternate
        // screen needs an explicit switch first so those restored modes apply
        // to the correct screen buffer.
        if self.parser.screen().alternate_screen() {
            snapshot.extend_from_slice(b"\x1b[?1049h");
        }
        snapshot.extend(self.parser.screen().state_formatted());
        snapshot
    }
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

        let output_state = Arc::new(Mutex::new(OutputState::new(scrollback_size, initial_size)));
        let (output_tx, _) = broadcast::channel(64);
        let (pty_size_tx, _) = broadcast::channel(16);
        let (close_tx, _) = broadcast::channel(1);
        let (notification_tx, _) = broadcast::channel(16);

        let output_state_clone = output_state.clone();
        let tx = output_tx.clone();
        let ctx = close_tx.clone();
        let ntx = notification_tx.clone();

        let reader_handle = tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 4096];
            let mut scanner = NotificationScanner::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        if scanner.scan(&data) {
                            let _ = ntx.send(());
                        }
                        {
                            let mut output_state = output_state_clone.lock().unwrap();
                            output_state.record_output(&data, scrollback_size);
                        }
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
            output_state,
            output_tx,
            pty_size_tx,
            close_tx,
            notification_tx,
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
    /// - initial payload (raw replay bytes or a full snapshot)
    /// - snapshot flag (true when the initial payload is a
    ///   full terminal snapshot)
    /// - byte_offset (total bytes ever output — the
    ///   client's new position counter)
    /// - data_lost (true if byte-resume was impossible)
    /// - output receiver (live PTY output)
    /// - close receiver (shell exit notification)
    ///
    /// Lock ordering: output-state mutex held while
    /// subscribing to output channel guarantees no output
    /// is missed between snapshot and subscription.
    pub fn attach(&self, resume_from: Option<u64>) -> LiveTabAttachment {
        let output_state = self.output_state.lock().unwrap();
        let total = output_state.total_bytes;
        let attachment_id = self.next_attachment_id.fetch_add(1, Ordering::Relaxed);
        let current_size = {
            let mut attachments = self.attachments.lock().unwrap();
            attachments.insert(attachment_id, Instant::now());
            attachments.shared_size()
        };

        let (initial_payload, snapshot, data_lost) = output_state.build_attach_payload(resume_from);
        let output_rx = self.output_tx.subscribe();
        let pty_size_rx = self.pty_size_tx.subscribe();
        let close_rx = self.close_tx.subscribe();
        LiveTabAttachment {
            attachment_id,
            initial_payload,
            snapshot,
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

        let mut output_state = self.output_state.lock().unwrap();
        output_state
            .parser
            .screen_mut()
            .set_size(size.rows, size.cols);
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

    #[cfg(test)]
    fn record_output_for_test(&self, data: &[u8], scrollback_size: usize) {
        let mut output_state = self.output_state.lock().unwrap();
        output_state.record_output(data, scrollback_size);
    }

    #[cfg(test)]
    fn screen_for_test(&self) -> vt100::Screen {
        self.output_state.lock().unwrap().parser.screen().clone()
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

    use super::{
        AttachmentRegistry, DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS, DEFAULT_SCROLLBACK, LiveTab,
        NotificationScanner, TabInfo, TerminalSize,
    };

    #[test]
    fn scanner_detects_standalone_bel() {
        let mut s = NotificationScanner::new();
        assert!(s.scan(b"hello\x07world"));
    }

    #[test]
    fn scanner_ignores_bel_as_osc_terminator() {
        let mut s = NotificationScanner::new();
        // OSC 52 (clipboard) terminated by BEL — not a bell
        assert!(!s.scan(b"\x1b]52;c;dGVzdA==\x07"));
    }

    #[test]
    fn scanner_detects_osc_9() {
        let mut s = NotificationScanner::new();
        assert!(s.scan(b"\x1b]9;2;task done\x07"));
    }

    #[test]
    fn scanner_detects_osc_777() {
        let mut s = NotificationScanner::new();
        assert!(s.scan(b"\x1b]777;notify;title;body\x07"));
    }

    #[test]
    fn scanner_ignores_unrelated_osc() {
        let mut s = NotificationScanner::new();
        assert!(!s.scan(b"\x1b]0;window title\x07"));
    }

    #[test]
    fn scanner_handles_osc_with_st_terminator() {
        let mut s = NotificationScanner::new();
        assert!(s.scan(b"\x1b]9;2;done\x1b\\"));
    }

    #[test]
    fn scanner_handles_split_chunks() {
        let mut s = NotificationScanner::new();
        // ESC in first chunk, ] in second
        assert!(!s.scan(b"output\x1b"));
        assert!(s.scan(b"]9;task done\x07"));
    }

    #[test]
    fn scanner_handles_split_osc_number() {
        let mut s = NotificationScanner::new();
        assert!(!s.scan(b"\x1b]77"));
        assert!(s.scan(b"7;notify;title;body\x07"));
    }

    #[test]
    fn scanner_no_false_positive_on_plain_text() {
        let mut s = NotificationScanner::new();
        assert!(!s.scan(b"just some regular terminal output\r\n"));
    }

    #[test]
    fn scanner_esc_in_osc_number_starts_new_sequence() {
        let mut s = NotificationScanner::new();
        // Malformed OSC interrupted by ESC starting new OSC 9
        assert!(s.scan(b"\x1b]12\x1b]9;bell\x07"));
    }

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
            TabInfo::Terminal {
                id: "tab".to_string(),
                session_id: "default".to_string(),
                worktree_id: "worktree".to_string(),
                label: "Terminal 1".to_string(),
                position: 1.0,
                created_at: 0,
                preview: false,
                has_notification: false,
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

    #[tokio::test(flavor = "current_thread")]
    async fn initial_attach_returns_snapshot_payload() {
        let tab = spawn_test_live_tab();

        tab.record_output_for_test(b"hello", DEFAULT_SCROLLBACK);

        let attachment = tab.attach(None);
        let mut parser = vt100::Parser::new(DEFAULT_PTY_ROWS, DEFAULT_PTY_COLS, 0);
        parser.process(&attachment.initial_payload);

        assert!(attachment.snapshot);
        assert!(!attachment.data_lost);
        assert!(!attachment.initial_payload.is_empty());
        assert!(parser.screen().contents().contains("hello"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn fresh_attach_without_output_returns_empty_non_snapshot_payload() {
        let tab = spawn_test_live_tab();

        let attachment = tab.attach(None);

        assert!(!attachment.snapshot);
        assert!(!attachment.data_lost);
        assert!(attachment.initial_payload.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resumable_attach_replays_raw_bytes_without_snapshot() {
        let tab = spawn_test_live_tab();

        tab.record_output_for_test(b"hello", DEFAULT_SCROLLBACK);

        let attachment = tab.attach(Some(2));

        assert!(!attachment.snapshot);
        assert!(!attachment.data_lost);
        assert_eq!(attachment.initial_payload, b"llo");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn caught_up_resume_returns_empty_payload_without_snapshot() {
        let tab = spawn_test_live_tab();

        tab.record_output_for_test(b"hello", DEFAULT_SCROLLBACK);

        let attachment = tab.attach(Some(5));

        assert!(!attachment.snapshot);
        assert!(!attachment.data_lost);
        assert!(attachment.initial_payload.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn overflow_attach_falls_back_to_snapshot() {
        let tab = spawn_test_live_tab();

        tab.record_output_for_test(b"abcdef", 3);

        let attachment = tab.attach(Some(0));
        let mut parser = vt100::Parser::new(DEFAULT_PTY_ROWS, DEFAULT_PTY_COLS, 0);
        parser.process(&attachment.initial_payload);

        assert!(attachment.snapshot);
        assert!(attachment.data_lost);
        assert!(!attachment.initial_payload.is_empty());
        assert!(parser.screen().contents().contains("abcdef"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn snapshot_preserves_mouse_mode_after_scrollback_overflow() {
        let tab = spawn_test_live_tab();
        let enable_mouse = b"\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h";
        let overflow = vec![b'x'; DEFAULT_SCROLLBACK + 32];

        tab.record_output_for_test(enable_mouse, DEFAULT_SCROLLBACK);
        tab.record_output_for_test(&overflow, DEFAULT_SCROLLBACK);

        let attachment = tab.attach(Some(0));

        assert!(attachment.snapshot);
        assert!(attachment.data_lost);

        let mut parser = vt100::Parser::new(DEFAULT_PTY_ROWS, DEFAULT_PTY_COLS, 0);
        parser.process(&attachment.initial_payload);

        assert!(parser.screen().alternate_screen());
        assert_eq!(
            parser.screen().mouse_protocol_mode(),
            vt100::MouseProtocolMode::ButtonMotion
        );
        assert_eq!(
            parser.screen().mouse_protocol_encoding(),
            vt100::MouseProtocolEncoding::Sgr
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resize_updates_parser_size() {
        let tab = spawn_test_live_tab();

        assert!(tab.resize_pty(TerminalSize::new(120, 40)));

        assert_eq!(tab.screen_for_test().size(), (40, 120));
    }
}
