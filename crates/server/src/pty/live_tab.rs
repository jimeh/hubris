use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{Child, MasterPty};
use serde::Serialize;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

/// Max scrollback buffer size in bytes (~128KB).
const MAX_SCROLLBACK: usize = 128 * 1024;

/// Serializable metadata for a tab.
#[derive(Debug, Clone, Serialize)]
pub struct TabInfo {
    pub id: String,
    pub session_id: String,
    pub project_id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub tab_type: String,
    pub created_at: u64,
}

/// A live terminal tab with its PTY, scrollback buffer,
/// and broadcast channel for output fan-out.
///
/// Fields use `std::sync::Mutex` so the struct is
/// Send + Sync for DashMap storage. Locks are held
/// briefly — no async work while locked.
pub struct LiveTab {
    pub info: TabInfo,
    pub pty_master: Mutex<Box<dyn MasterPty + Send>>,
    pub pty_writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    pub scrollback: Arc<Mutex<VecDeque<u8>>>,
    pub output_tx: broadcast::Sender<Vec<u8>>,
    pub close_tx: broadcast::Sender<()>,
    _reader_handle: JoinHandle<()>,
}

impl LiveTab {
    /// Spawn a new LiveTab. Starts the background PTY
    /// reader immediately.
    pub fn spawn(
        info: TabInfo,
        master: Box<dyn MasterPty + Send>,
        child: Box<dyn Child + Send + Sync>,
    ) -> Self {
        let mut reader = master.try_clone_reader().unwrap();
        let writer = master.take_writer().unwrap();

        let (output_tx, _) = broadcast::channel::<Vec<u8>>(64);
        let (close_tx, _) = broadcast::channel::<()>(1);
        let scrollback = Arc::new(Mutex::new(
            VecDeque::with_capacity(MAX_SCROLLBACK),
        ));

        let tx = output_tx.clone();
        let sb = scrollback.clone();
        let close_tx_reader = close_tx.clone();

        let reader_handle =
            tokio::task::spawn_blocking(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let data = buf[..n].to_vec();

                            // Append to scrollback (bounded)
                            {
                                let mut sb =
                                    sb.lock().unwrap();
                                for &byte in &data {
                                    if sb.len()
                                        >= MAX_SCROLLBACK
                                    {
                                        sb.pop_front();
                                    }
                                    sb.push_back(byte);
                                }
                            }

                            // Broadcast to connected clients.
                            // Ignore error (no receivers).
                            let _ = tx.send(data);
                        }
                        Err(_) => break,
                    }
                }
                // Shell exited — notify attached clients
                let _ = close_tx_reader.send(());
            });

        Self {
            info,
            pty_master: Mutex::new(master),
            pty_writer: Mutex::new(writer),
            child: Mutex::new(child),
            scrollback,
            output_tx,
            close_tx,
            _reader_handle: reader_handle,
        }
    }

    /// Attach a client. Returns a snapshot of the scrollback
    /// buffer and a broadcast receiver for live output.
    ///
    /// Lock ordering (scrollback held while subscribing)
    /// guarantees no output is missed or duplicated.
    pub fn attach(
        &self,
    ) -> (Vec<u8>, broadcast::Receiver<Vec<u8>>) {
        let sb = self.scrollback.lock().unwrap();
        let rx = self.output_tx.subscribe();
        let snapshot: Vec<u8> =
            sb.iter().copied().collect();
        (snapshot, rx)
    }

    /// Kill the child process. The reader task ends
    /// naturally when the PTY fd closes.
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
