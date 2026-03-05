use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{Child, MasterPty};
use serde::Serialize;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use ts_rs::TS;
use utoipa::ToSchema;

/// Default scrollback buffer size in bytes (~128KB).
/// Passed to `LiveTab::spawn()` so it can be overridden
/// per-tab in the future (e.g., from user settings).
pub const DEFAULT_SCROLLBACK: usize = 128 * 1024;

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
    pub close_tx: broadcast::Sender<()>,
    _reader_handle: JoinHandle<()>,
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
    ) -> Self {
        let mut reader = master.try_clone_reader().unwrap();
        let writer = master.take_writer().unwrap();

        let scrollback = Arc::new(Mutex::new(VecDeque::with_capacity(scrollback_size)));
        let total_bytes = Arc::new(AtomicU64::new(0));
        let (output_tx, _) = broadcast::channel(64);
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
            close_tx,
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
    pub fn attach(
        &self,
        resume_from: Option<u64>,
    ) -> (
        Vec<u8>,
        u64,
        bool,
        broadcast::Receiver<Vec<u8>>,
        broadcast::Receiver<()>,
    ) {
        let sb = self.scrollback.lock().unwrap();
        let total = self.total_bytes.load(Ordering::Relaxed);

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
        let close_rx = self.close_tx.subscribe();
        (snapshot, total, data_lost, output_rx, close_rx)
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
}

impl Drop for LiveTab {
    fn drop(&mut self) {
        self.kill();
        self._reader_handle.abort();
    }
}
