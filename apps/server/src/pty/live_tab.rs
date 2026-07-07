use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

#[cfg(target_os = "macos")]
use std::ffi::CStr;

use portable_pty::{Child, MasterPty, PtySize};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::tab::TabInfo;

/// Default scrollback buffer size in bytes (~256KB).
/// Passed to `LiveTab::spawn()` so it can be overridden
/// per-tab in the future (e.g., from user settings).
pub const DEFAULT_SCROLLBACK: usize = 256 * 1024;
pub const DEFAULT_PTY_COLS: u16 = 80;
pub const DEFAULT_PTY_ROWS: u16 = 24;
const MIN_PTY_COLS: u16 = 8;
const MIN_PTY_ROWS: u16 = 2;
const PROCESS_CWD_CACHE_TTL: Duration = Duration::from_secs(2);
const PROCESS_LABEL_CACHE_TTL: Duration = Duration::from_secs(5);
#[cfg(target_os = "macos")]
const MAXPATHLEN: usize = libc::PATH_MAX as usize;
#[cfg(target_os = "macos")]
const PROC_PIDPATHINFO_MAXSIZE: usize = libc::PATH_MAX as usize * 4;
#[cfg(target_os = "macos")]
const PROC_PIDVNODEPATHINFO: libc::c_int = 9;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

/// Persisted terminal output used to rebuild a restored replay.
#[derive(Debug, Clone)]
pub struct RestoredTerminalBuffers {
    pub history: Vec<u8>,
}

pub struct RestoredTerminalState {
    pub size: TerminalSize,
    pub buffers: RestoredTerminalBuffers,
}

#[derive(Debug, Clone)]
pub(crate) enum TerminalPersistenceCapture {
    Incremental(TerminalIncrementalCapture),
    FullRebuild(Box<TerminalFullRebuildCapture>),
}

#[derive(Debug, Clone)]
pub(crate) struct TerminalIncrementalCapture {
    pub size: TerminalSize,
    pub replay_budget_bytes: usize,
    pub source_bytes_end: u64,
    pub replay_epoch: u64,
    pub source_bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub(crate) struct TerminalFullRebuildCapture {
    pub size: TerminalSize,
    pub replay_budget_bytes: usize,
    pub source_bytes_end: u64,
    pub replay_epoch: u64,
    pub replay_screen: vt100::Screen,
    pub replay_filter: ReplayFilter,
}

#[derive(Debug, Clone)]
pub(crate) struct TerminalPersistenceSeed {
    pub total_bytes: u64,
    pub replay_epoch: u64,
    pub replay_filter: ReplayFilter,
}

struct LiveTabSpawn {
    info: TabInfo,
    shell_process_name: Option<String>,
    worktree_root: PathBuf,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    scrollback_size: usize,
}

impl TerminalSize {
    pub const fn new(cols: u16, rows: u16) -> Self {
        Self { cols, rows }
    }

    pub const fn clamped(self) -> Self {
        Self {
            cols: if self.cols < MIN_PTY_COLS {
                MIN_PTY_COLS
            } else {
                self.cols
            },
            rows: if self.rows < MIN_PTY_ROWS {
                MIN_PTY_ROWS
            } else {
                self.rows
            },
        }
    }

    pub const fn default_pty() -> Self {
        Self::new(DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS)
    }

    pub const fn to_pty_size(self) -> PtySize {
        let size = self.clamped();
        PtySize {
            rows: size.rows,
            cols: size.cols,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct TerminalScanResult {
    notified: bool,
    title: Option<Option<String>>,
}

/// Scans raw PTY output for terminal signals:
/// standalone BEL notifications, OSC 9/777 notifications,
/// and OSC 0/1/2 title updates.
///
/// Distinguishes standalone BEL from BEL used as a string
/// sequence terminator by tracking whether we're inside an
/// OSC, DCS, PM, or APC sequence.
struct TerminalSignalScanner {
    state: ScanState,
    osc_number: u32,
    osc_payload: Vec<u8>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ScanState {
    Normal,
    Esc,
    OscNumber,
    OscPayload,
    OscPayloadEsc,
    StringPayload,
    StringPayloadEsc,
}

impl TerminalSignalScanner {
    fn new() -> Self {
        Self {
            state: ScanState::Normal,
            osc_number: 0,
            osc_payload: Vec::new(),
        }
    }

    fn scan(&mut self, data: &[u8]) -> TerminalScanResult {
        let mut result = TerminalScanResult::default();
        for &byte in data {
            match self.state {
                ScanState::Normal => match byte {
                    0x07 => result.notified = true,
                    0x1b => self.state = ScanState::Esc,
                    _ => {}
                },
                ScanState::Esc => match byte {
                    b']' => {
                        self.state = ScanState::OscNumber;
                        self.osc_number = 0;
                        self.osc_payload.clear();
                    }
                    b'P' | b'^' | b'_' => {
                        self.state = ScanState::StringPayload;
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
                    b';' => self.state = ScanState::OscPayload,
                    0x07 => {
                        self.finish_osc(&mut result);
                        self.state = ScanState::Normal;
                    }
                    0x1b => self.state = ScanState::OscPayloadEsc,
                    _ => {
                        self.state = ScanState::OscPayload;
                        self.osc_payload.push(byte);
                    }
                },
                ScanState::OscPayload => match byte {
                    0x07 => {
                        self.finish_osc(&mut result);
                        self.state = ScanState::Normal;
                    }
                    0x1b => self.state = ScanState::OscPayloadEsc,
                    _ => self.osc_payload.push(byte),
                },
                ScanState::OscPayloadEsc => match byte {
                    b'\\' => {
                        self.finish_osc(&mut result);
                        self.state = ScanState::Normal;
                    }
                    b']' => {
                        self.state = ScanState::OscNumber;
                        self.osc_number = 0;
                        self.osc_payload.clear();
                    }
                    b'P' | b'^' | b'_' => self.state = ScanState::StringPayload,
                    _ => self.state = ScanState::Normal,
                },
                ScanState::StringPayload => match byte {
                    0x07 => self.state = ScanState::Normal,
                    0x1b => self.state = ScanState::StringPayloadEsc,
                    _ => {}
                },
                ScanState::StringPayloadEsc => match byte {
                    b'\\' => self.state = ScanState::Normal,
                    b']' => {
                        self.state = ScanState::OscNumber;
                        self.osc_number = 0;
                        self.osc_payload.clear();
                    }
                    b'P' | b'^' | b'_' => self.state = ScanState::StringPayload,
                    _ => self.state = ScanState::Normal,
                },
            }
        }
        result
    }

    fn finish_osc(&mut self, result: &mut TerminalScanResult) {
        match self.osc_number {
            0..=2 => {
                result.title = Some(normalize_osc_title(&self.osc_payload));
            }
            9 | 777 => {
                result.notified = true;
            }
            _ => {}
        }
        self.osc_number = 0;
        self.osc_payload.clear();
    }
}

fn normalize_osc_title(payload: &[u8]) -> Option<String> {
    let title = String::from_utf8_lossy(payload);
    (!title.is_empty()).then(|| title.into_owned())
}

#[derive(Debug, Clone)]
struct CachedProcessLabel {
    pid: libc::pid_t,
    label: Option<String>,
    expires_at: Instant,
}

#[derive(Debug, Default)]
struct ProcessLabelCache {
    entry: Option<CachedProcessLabel>,
}

#[derive(Debug, Clone)]
struct CachedProcessCwd {
    pid: libc::pid_t,
    cwd: Option<PathBuf>,
    expires_at: Instant,
}

#[derive(Debug, Default)]
struct ProcessCwdCache {
    entry: Option<CachedProcessCwd>,
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(unix)]
fn resolve_process_label_with_cache<F>(
    cache: &Mutex<ProcessLabelCache>,
    pid: libc::pid_t,
    now: Instant,
    ttl: Duration,
    resolve: F,
) -> Option<String>
where
    F: FnOnce(libc::pid_t) -> Option<String>,
{
    if let Some(cached) = lock_unpoisoned(cache).entry.as_ref()
        && cached.pid == pid
        && now < cached.expires_at
    {
        return cached.label.clone();
    }

    let label = resolve(pid as libc::pid_t);
    lock_unpoisoned(cache).entry = Some(CachedProcessLabel {
        pid,
        label: label.clone(),
        expires_at: now + ttl,
    });
    label
}

#[cfg(unix)]
fn resolve_process_cwd_with_cache<F>(
    cache: &Mutex<ProcessCwdCache>,
    pid: libc::pid_t,
    now: Instant,
    ttl: Duration,
    resolve: F,
) -> Option<PathBuf>
where
    F: FnOnce(libc::pid_t) -> Option<PathBuf>,
{
    if let Some(cached) = lock_unpoisoned(cache).entry.as_ref()
        && cached.pid == pid
        && now < cached.expires_at
    {
        return cached.cwd.clone();
    }

    let cwd = resolve(pid);
    lock_unpoisoned(cache).entry = Some(CachedProcessCwd {
        pid,
        cwd: cwd.clone(),
        expires_at: now + ttl,
    });
    cwd
}

/// A live terminal tab with its PTY, scrollback buffer,
/// and broadcast channels for output fan-out and close
/// notification.
pub struct LiveTab {
    info: Mutex<TabInfo>,
    shell_process_name: Option<String>,
    worktree_root: PathBuf,
    home_dir: Option<PathBuf>,
    pub pty_master: Mutex<Box<dyn MasterPty + Send>>,
    pub pty_writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    output_state: Arc<Mutex<OutputState>>,
    pub output_tx: broadcast::Sender<Vec<u8>>,
    pty_size_tx: broadcast::Sender<TerminalSize>,
    pub close_tx: broadcast::Sender<()>,
    pub notification_tx: broadcast::Sender<()>,
    pub title_tx: broadcast::Sender<Option<String>>,
    next_attachment_id: AtomicU64,
    attachments: Mutex<AttachmentRegistry>,
    process_cwd_cache: Mutex<ProcessCwdCache>,
    process_label_cache: Mutex<ProcessLabelCache>,
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
    replay_parser: vt100::Parser,
    replay_filter: ReplayFilter,
    replay_epoch: u64,
    replay_budget_bytes: usize,
    size: TerminalSize,
    last_good_size: TerminalSize,
}

impl OutputState {
    fn new(scrollback_size: usize, initial_size: TerminalSize) -> Self {
        let size = initial_size.clamped();
        let replay_scrollback_rows = estimated_replay_scrollback_rows(scrollback_size, size);
        Self {
            scrollback: VecDeque::with_capacity(scrollback_size),
            total_bytes: 0,
            parser: vt100::Parser::new(size.rows, size.cols, 0),
            replay_parser: vt100::Parser::new(size.rows, size.cols, replay_scrollback_rows),
            replay_filter: ReplayFilter::default(),
            replay_epoch: 0,
            replay_budget_bytes: scrollback_size,
            size,
            last_good_size: size,
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
        self.process_parser_bytes(data);
        self.process_replay_bytes(data);
    }

    fn process_parser_bytes(&mut self, data: &[u8]) {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.parser.process(data);
        }));
        if result.is_err() {
            tracing::warn!(
                "vt100 parser panicked while processing PTY output; resetting terminal parser"
            );
            self.size = self.last_good_size;
            self.parser = vt100::Parser::new(self.last_good_size.rows, self.last_good_size.cols, 0);
        }
    }

    fn process_replay_bytes(&mut self, data: &[u8]) {
        let filtered = self.replay_filter.filter(data);
        if filtered.is_empty() {
            return;
        }

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.replay_parser.process(&filtered);
        }));
        if result.is_err() {
            tracing::warn!(
                "vt100 replay parser panicked while processing PTY output; resetting persisted terminal history parser"
            );
            self.replay_parser = vt100::Parser::new(
                self.last_good_size.rows,
                self.last_good_size.cols,
                estimated_replay_scrollback_rows(self.replay_budget_bytes, self.last_good_size),
            );
            self.replay_filter = ReplayFilter::default();
            self.replay_epoch = self.replay_epoch.saturating_add(1);
        }
    }

    fn resize(&mut self, size: TerminalSize) {
        let size = size.clamped();
        if self.size != size {
            self.replay_epoch = self.replay_epoch.saturating_add(1);
        }
        self.size = size;
        self.last_good_size = size;
        self.parser.screen_mut().set_size(size.rows, size.cols);
        self.replay_parser
            .screen_mut()
            .set_size(size.rows, size.cols);
    }

    fn from_history(scrollback_size: usize, initial_size: TerminalSize, history: &[u8]) -> Self {
        let mut state = Self::new(scrollback_size, initial_size);
        state.record_output(history, scrollback_size);
        state
    }

    #[cfg(test)]
    fn replay_history(&self) -> Vec<u8> {
        let mut screen = self.replay_parser.screen().clone();
        formatted_screen_history(&mut screen, self.replay_budget_bytes)
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

#[cfg(test)]
pub(crate) fn build_replay_history_from_buffers(
    initial_size: TerminalSize,
    scrollback: &[u8],
    snapshot: &[u8],
) -> Vec<u8> {
    let mut stream = Vec::with_capacity(scrollback.len() + snapshot.len());
    stream.extend_from_slice(scrollback);
    stream.extend_from_slice(snapshot);
    build_replay_history_from_stream(initial_size, &stream)
}

#[cfg(test)]
fn build_replay_history_from_stream(initial_size: TerminalSize, stream: &[u8]) -> Vec<u8> {
    let size = initial_size.clamped();
    let scrollback_rows = estimated_replay_scrollback_rows(DEFAULT_SCROLLBACK, size);
    let mut parser = vt100::Parser::new(size.rows, size.cols, scrollback_rows);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        parser.process(stream);
        if parser.screen().alternate_screen() {
            parser.process(b"\x1b[?1049l");
        }
    }));
    if result.is_err() {
        tracing::warn!(
            "vt100 parser panicked while building replay history; dropping persisted terminal history"
        );
        return Vec::new();
    }

    formatted_screen_history(parser.screen_mut(), DEFAULT_SCROLLBACK)
}

fn estimated_replay_scrollback_rows(budget_bytes: usize, size: TerminalSize) -> usize {
    let cols = usize::from(size.cols.max(1));
    let rows = usize::from(size.rows.max(1));
    (budget_bytes / cols).max(rows)
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ReplayFilter {
    in_alt_screen: bool,
    state: ReplayFilterState,
}

#[derive(Clone, Debug, Default)]
enum ReplayFilterState {
    #[default]
    Ground,
    Esc,
    Csi(Vec<u8>),
    StringSequence(StringSequenceKind),
    StringSequenceEsc(StringSequenceKind),
}

#[derive(Clone, Copy, Debug)]
enum StringSequenceKind {
    Osc,
    Dcs,
    Pm,
    Apc,
}

impl ReplayFilter {
    fn filter(&mut self, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len());
        for &byte in data {
            match &mut self.state {
                ReplayFilterState::Ground => {
                    if byte == 0x1b {
                        self.state = ReplayFilterState::Esc;
                    } else if !self.in_alt_screen {
                        out.push(byte);
                    }
                }
                ReplayFilterState::Esc => match byte {
                    b'[' => {
                        self.state = ReplayFilterState::Csi(vec![0x1b, b'[']);
                    }
                    b']' => {
                        self.state = ReplayFilterState::StringSequence(StringSequenceKind::Osc);
                    }
                    b'P' => {
                        self.state = ReplayFilterState::StringSequence(StringSequenceKind::Dcs);
                    }
                    b'^' => {
                        self.state = ReplayFilterState::StringSequence(StringSequenceKind::Pm);
                    }
                    b'_' => {
                        self.state = ReplayFilterState::StringSequence(StringSequenceKind::Apc);
                    }
                    b'c' | b'=' | b'>' => {
                        self.state = ReplayFilterState::Ground;
                    }
                    _ => {
                        if !self.in_alt_screen {
                            out.push(0x1b);
                            out.push(byte);
                        }
                        self.state = ReplayFilterState::Ground;
                    }
                },
                ReplayFilterState::Csi(seq) => {
                    seq.push(byte);
                    if (0x40..=0x7e).contains(&byte) {
                        if let Some(private_modes) = parse_private_mode_sequence(seq, byte) {
                            for mode in private_modes {
                                if matches!(mode, 47 | 1047 | 1049) {
                                    self.in_alt_screen = byte == b'h';
                                }
                            }
                        } else if !self.in_alt_screen {
                            out.extend_from_slice(seq);
                        }
                        self.state = ReplayFilterState::Ground;
                    }
                }
                ReplayFilterState::StringSequence(kind) => match byte {
                    0x07 => self.state = ReplayFilterState::Ground,
                    0x1b => {
                        self.state = ReplayFilterState::StringSequenceEsc(*kind);
                    }
                    _ => {}
                },
                ReplayFilterState::StringSequenceEsc(kind) => {
                    if byte == b'\\' {
                        self.state = ReplayFilterState::Ground;
                    } else {
                        self.state = ReplayFilterState::StringSequence(*kind);
                    }
                }
            }
        }
        out
    }
}

pub(crate) fn filter_replay_bytes(filter: &mut ReplayFilter, data: &[u8]) -> Vec<u8> {
    filter.filter(data)
}

pub(crate) fn render_replay_screen_history(
    mut screen: vt100::Screen,
    budget_bytes: usize,
) -> Vec<u8> {
    formatted_screen_history(&mut screen, budget_bytes)
}

fn parse_private_mode_sequence(seq: &[u8], final_byte: u8) -> Option<Vec<u16>> {
    if !(final_byte == b'h' || final_byte == b'l') {
        return None;
    }
    if seq.len() < 5 || seq[0] != 0x1b || seq[1] != b'[' || seq[2] != b'?' {
        return None;
    }

    let params = &seq[3..seq.len().saturating_sub(1)];
    let parsed = String::from_utf8_lossy(params)
        .split(';')
        .filter_map(|part| part.parse::<u16>().ok())
        .collect::<Vec<_>>();
    Some(parsed)
}

struct RestoredHistoryRow {
    formatted: Vec<u8>,
    plain: String,
    wrapped: bool,
}

fn formatted_screen_history(screen: &mut vt100::Screen, budget_bytes: usize) -> Vec<u8> {
    screen.set_scrollback(usize::MAX);
    let total_scrollback = screen.scrollback();
    let (rows, cols) = screen.size();
    let mut history_rows = Vec::new();

    append_window_rows(&mut history_rows, screen, rows, cols);
    if total_scrollback > 0 {
        for offset in (0..total_scrollback).rev() {
            screen.set_scrollback(offset);
            append_row(&mut history_rows, screen, rows.saturating_sub(1), cols);
        }
    }

    screen.set_scrollback(0);
    trim_trailing_blank_rows(&mut history_rows);
    trim_leading_rows_to_budget(&mut history_rows, budget_bytes);

    let mut out = Vec::new();
    for (index, row) in history_rows.iter().enumerate() {
        if index > 0 && !out.ends_with(b"\n") && !history_rows[index - 1].wrapped {
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(&row.formatted);
        if !row.wrapped {
            out.extend_from_slice(b"\x1b[m");
            out.extend_from_slice(b"\r\n");
        }
    }

    out
}

fn append_window_rows(
    out: &mut Vec<RestoredHistoryRow>,
    screen: &vt100::Screen,
    rows: u16,
    cols: u16,
) {
    for row in 0..rows {
        append_row(out, screen, row, cols);
    }
}

fn append_row(out: &mut Vec<RestoredHistoryRow>, screen: &vt100::Screen, row: u16, cols: u16) {
    let Some(formatted) = screen.rows_formatted(0, cols).nth(row as usize) else {
        return;
    };
    let plain = screen.rows(0, cols).nth(row as usize).unwrap_or_default();
    out.push(RestoredHistoryRow {
        formatted,
        plain,
        wrapped: screen.row_wrapped(row),
    });
}

fn trim_trailing_blank_rows(rows: &mut Vec<RestoredHistoryRow>) {
    while rows
        .last()
        .is_some_and(|row| row.plain.trim_end().is_empty())
    {
        rows.pop();
    }
}

fn trim_leading_rows_to_budget(rows: &mut Vec<RestoredHistoryRow>, budget_bytes: usize) {
    while rows.len() > 1 && rendered_history_len(rows) > budget_bytes {
        rows.remove(0);
    }
}

fn rendered_history_len(rows: &[RestoredHistoryRow]) -> usize {
    let mut len = 0usize;
    for (index, row) in rows.iter().enumerate() {
        if index > 0 && !rows[index - 1].wrapped {
            len = len.saturating_add(2);
        }
        len = len.saturating_add(row.formatted.len());
        if !row.wrapped {
            len = len.saturating_add(5);
        }
    }
    len
}

impl LiveTab {
    /// Spawn a new LiveTab from an already-opened PTY pair
    /// and child process. Starts a background reader task
    /// that feeds scrollback and broadcasts output.
    pub fn spawn(
        info: TabInfo,
        shell_process_name: Option<String>,
        worktree_root: PathBuf,
        master: Box<dyn MasterPty + Send>,
        child: Box<dyn Child + Send + Sync>,
        scrollback_size: usize,
        initial_size: TerminalSize,
    ) -> std::io::Result<Self> {
        let spawn = LiveTabSpawn {
            info,
            shell_process_name,
            worktree_root,
            master,
            child,
            scrollback_size,
        };
        Self::spawn_with_output_state(
            spawn,
            initial_size,
            OutputState::new(scrollback_size, initial_size),
        )
    }

    pub fn spawn_restored(
        info: TabInfo,
        shell_process_name: Option<String>,
        worktree_root: PathBuf,
        master: Box<dyn MasterPty + Send>,
        child: Box<dyn Child + Send + Sync>,
        scrollback_size: usize,
        restored: RestoredTerminalState,
    ) -> std::io::Result<Self> {
        let spawn = LiveTabSpawn {
            info,
            shell_process_name,
            worktree_root,
            master,
            child,
            scrollback_size,
        };
        Self::spawn_with_output_state(
            spawn,
            restored.size,
            OutputState::from_history(scrollback_size, restored.size, &restored.buffers.history),
        )
    }

    fn spawn_with_output_state(
        spawn: LiveTabSpawn,
        initial_size: TerminalSize,
        output_state: OutputState,
    ) -> std::io::Result<Self> {
        let LiveTabSpawn {
            info,
            shell_process_name,
            worktree_root,
            master,
            mut child,
            scrollback_size,
        } = spawn;
        // A PTY driver that fails to hand back a reader/writer must surface as
        // a recoverable error to the API/WS caller rather than panicking and
        // taking down the whole server. The shell child is already running at
        // this point, so reap it before bailing or it would be orphaned.
        let handles = master
            .try_clone_reader()
            .and_then(|reader| master.take_writer().map(|writer| (reader, writer)));
        let (mut reader, writer) = match handles {
            Ok(handles) => handles,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(std::io::Error::other(error));
            }
        };

        let output_state = Arc::new(Mutex::new(output_state));
        let (output_tx, _) = broadcast::channel(64);
        let (pty_size_tx, _) = broadcast::channel(16);
        let (close_tx, _) = broadcast::channel(1);
        let (notification_tx, _) = broadcast::channel(16);
        let (title_tx, _) = broadcast::channel(16);

        let output_state_clone = output_state.clone();
        let tx = output_tx.clone();
        let ctx = close_tx.clone();
        let ntx = notification_tx.clone();
        let ttx = title_tx.clone();

        let reader_handle = tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 4096];
            let mut scanner = TerminalSignalScanner::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        let scan = scanner.scan(&data);
                        if scan.notified {
                            let _ = ntx.send(());
                        }
                        if let Some(title) = scan.title {
                            let _ = ttx.send(title);
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

        Ok(Self {
            info: Mutex::new(info),
            shell_process_name,
            worktree_root,
            home_dir: std::env::var_os("HOME").map(PathBuf::from),
            pty_master: Mutex::new(master),
            pty_writer: Mutex::new(writer),
            child: Mutex::new(child),
            output_state,
            output_tx,
            pty_size_tx,
            close_tx,
            notification_tx,
            title_tx,
            next_attachment_id: AtomicU64::new(1),
            attachments: Mutex::new(AttachmentRegistry::new(initial_size)),
            process_cwd_cache: Mutex::new(ProcessCwdCache::default()),
            process_label_cache: Mutex::new(ProcessLabelCache::default()),
            resize_update_lock: Mutex::new(()),
            _reader_handle: reader_handle,
        })
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

    pub fn resolve_smart_label(&self) -> Option<String> {
        resolve_live_tab_smart_label(
            &self.pty_master,
            &self.process_cwd_cache,
            &self.process_label_cache,
            self.shell_process_name.as_deref(),
            &self.worktree_root,
            self.home_dir.as_deref(),
        )
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
        self.apply_attachment_update(attachment_id, Some(size.clamped()), visible);
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
        let size = size.clamped();
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
        output_state.resize(size);
        let _ = self.pty_size_tx.send(size);
        true
    }

    /// Notify all attached clients that this tab is
    /// closing. Called by `delete_tab` for explicit closure.
    pub fn notify_close(&self) {
        let _ = self.close_tx.send(());
    }

    pub(crate) fn capture_persistence_snapshot(
        &self,
        requested_source_offset: u64,
        requested_replay_epoch: u64,
    ) -> TerminalPersistenceCapture {
        let output_state = self.output_state.lock().unwrap();
        let raw_start_offset = output_state
            .total_bytes
            .saturating_sub(output_state.scrollback.len() as u64);
        if output_state.replay_epoch == requested_replay_epoch
            && requested_source_offset >= raw_start_offset
        {
            let source_start = requested_source_offset.min(output_state.total_bytes);
            let offset_in_scrollback = (source_start.saturating_sub(raw_start_offset)) as usize;
            let (front, back) = output_state.scrollback.as_slices();
            let mut source_bytes =
                Vec::with_capacity((output_state.total_bytes - source_start) as usize);
            let front_skip = offset_in_scrollback.min(front.len());
            source_bytes.extend_from_slice(&front[front_skip..]);
            if offset_in_scrollback > front.len() {
                source_bytes.extend_from_slice(&back[offset_in_scrollback - front.len()..]);
            } else {
                source_bytes.extend_from_slice(back);
            }
            return TerminalPersistenceCapture::Incremental(TerminalIncrementalCapture {
                size: output_state.size,
                replay_budget_bytes: output_state.replay_budget_bytes,
                source_bytes_end: output_state.total_bytes,
                replay_epoch: output_state.replay_epoch,
                source_bytes,
            });
        }

        TerminalPersistenceCapture::FullRebuild(Box::new(TerminalFullRebuildCapture {
            size: output_state.size,
            replay_budget_bytes: output_state.replay_budget_bytes,
            source_bytes_end: output_state.total_bytes,
            replay_epoch: output_state.replay_epoch,
            replay_screen: output_state.replay_parser.screen().clone(),
            replay_filter: output_state.replay_filter.clone(),
        }))
    }

    pub(crate) fn capture_persistence_seed(&self) -> TerminalPersistenceSeed {
        let output_state = self.output_state.lock().unwrap();
        TerminalPersistenceSeed {
            total_bytes: output_state.total_bytes,
            replay_epoch: output_state.replay_epoch,
            replay_filter: output_state.replay_filter.clone(),
        }
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

#[cfg(unix)]
fn resolve_live_tab_smart_label(
    pty_master: &Mutex<Box<dyn MasterPty + Send>>,
    process_cwd_cache: &Mutex<ProcessCwdCache>,
    process_label_cache: &Mutex<ProcessLabelCache>,
    shell_process_name: Option<&str>,
    worktree_root: &Path,
    home_dir: Option<&Path>,
) -> Option<String> {
    let leader = {
        let pty_master = lock_unpoisoned(pty_master);
        pty_master.process_group_leader()?
    };

    let process_label = resolve_process_label_from_pid(leader, process_label_cache)?;
    if shell_process_name.is_some_and(|shell_process_name| {
        process_name_matches_shell(&process_label, shell_process_name)
    }) {
        return resolve_process_cwd_from_pid(leader, process_cwd_cache)
            .map(|cwd| format_smart_shell_path(&cwd, worktree_root, home_dir))
            .or(Some(process_label));
    }

    Some(process_label)
}

#[cfg(not(unix))]
fn resolve_live_tab_smart_label(
    _pty_master: &Mutex<Box<dyn MasterPty + Send>>,
    _process_cwd_cache: &Mutex<ProcessCwdCache>,
    _process_label_cache: &Mutex<ProcessLabelCache>,
    _shell_process_name: Option<&str>,
    _worktree_root: &Path,
    _home_dir: Option<&Path>,
) -> Option<String> {
    None
}

#[cfg(unix)]
fn resolve_process_label_from_pid(
    pid: libc::pid_t,
    process_label_cache: &Mutex<ProcessLabelCache>,
) -> Option<String> {
    if pid <= 0 {
        return None;
    }

    resolve_process_label_with_cache(
        process_label_cache,
        pid,
        Instant::now(),
        PROCESS_LABEL_CACHE_TTL,
        |pid| {
            resolve_process_label_from_procfs(pid)
                .or_else(|| resolve_process_label_from_libproc(pid))
                .or_else(|| resolve_process_label_from_ps(pid))
        },
    )
}

#[cfg(unix)]
fn resolve_process_label_from_procfs(pid: libc::pid_t) -> Option<String> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    normalize_process_label(&raw)
}

#[cfg(target_os = "macos")]
fn resolve_process_label_from_libproc(pid: libc::pid_t) -> Option<String> {
    let mut path_buf = vec![0 as libc::c_char; PROC_PIDPATHINFO_MAXSIZE];
    let path_len =
        unsafe { proc_pidpath(pid, path_buf.as_mut_ptr().cast(), path_buf.len() as u32) };
    if path_len > 0 {
        let raw = unsafe { CStr::from_ptr(path_buf.as_ptr()) };
        return normalize_process_label(&raw.to_string_lossy());
    }

    let mut name_buf = [0 as libc::c_char; 2 * 16];
    let name_len = unsafe { proc_name(pid, name_buf.as_mut_ptr().cast(), name_buf.len() as u32) };
    if name_len > 0 {
        let raw = unsafe { CStr::from_ptr(name_buf.as_ptr()) };
        return normalize_process_label(&raw.to_string_lossy());
    }

    None
}

#[cfg(not(target_os = "macos"))]
fn resolve_process_label_from_libproc(_pid: libc::pid_t) -> Option<String> {
    None
}

#[cfg(unix)]
#[cfg(not(target_os = "macos"))]
fn resolve_process_label_from_ps(pid: libc::pid_t) -> Option<String> {
    let output = std::process::Command::new("ps")
        .args(["-o", "comm=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    normalize_process_label(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(target_os = "macos")]
fn resolve_process_label_from_ps(_pid: libc::pid_t) -> Option<String> {
    None
}

fn normalize_process_label(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let normalized = Path::new(trimmed)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(trimmed);
    Some(normalized.to_string())
}

pub(crate) fn normalize_shell_process_name(raw: &str) -> Option<String> {
    normalize_process_label(raw).map(|label| label.trim_start_matches('-').to_string())
}

fn process_name_matches_shell(process_label: &str, shell_process_name: &str) -> bool {
    process_label.trim_start_matches('-') == shell_process_name.trim_start_matches('-')
}

fn format_smart_shell_path(path: &Path, worktree_root: &Path, home_dir: Option<&Path>) -> String {
    if path == worktree_root {
        return "./".to_string();
    }

    if let Ok(stripped) = path.strip_prefix(worktree_root)
        && !stripped.as_os_str().is_empty()
    {
        return format!("./{}", stripped.display());
    }

    format_home_relative_path(path, home_dir)
}

fn format_home_relative_path(path: &Path, home_dir: Option<&Path>) -> String {
    let Some(home) = home_dir else {
        return path.display().to_string();
    };

    if path == home {
        return "~".to_string();
    }

    if let Ok(stripped) = path.strip_prefix(home) {
        if stripped.as_os_str().is_empty() {
            return "~".to_string();
        }
        return format!("~/{}", stripped.display());
    }

    path.display().to_string()
}

#[cfg(unix)]
fn resolve_process_cwd_from_pid(
    pid: libc::pid_t,
    process_cwd_cache: &Mutex<ProcessCwdCache>,
) -> Option<PathBuf> {
    if pid <= 0 {
        return None;
    }

    resolve_process_cwd_with_cache(
        process_cwd_cache,
        pid,
        Instant::now(),
        PROCESS_CWD_CACHE_TTL,
        |pid| {
            resolve_process_cwd_from_procfs(pid)
                .or_else(|| resolve_process_cwd_from_libproc(pid))
                .or_else(|| resolve_process_cwd_from_lsof(pid))
        },
    )
}

#[cfg(not(unix))]
fn resolve_process_cwd_from_pid(
    _pid: libc::pid_t,
    _process_cwd_cache: &Mutex<ProcessCwdCache>,
) -> Option<PathBuf> {
    None
}

#[cfg(unix)]
fn resolve_process_cwd_from_procfs(pid: libc::pid_t) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(target_os = "macos")]
fn resolve_process_cwd_from_libproc(pid: libc::pid_t) -> Option<PathBuf> {
    let mut info = std::mem::MaybeUninit::<ProcVnodePathInfo>::zeroed();
    let info_len = unsafe {
        proc_pidinfo(
            pid,
            PROC_PIDVNODEPATHINFO,
            0,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<ProcVnodePathInfo>() as libc::c_int,
        )
    };
    if info_len != std::mem::size_of::<ProcVnodePathInfo>() as libc::c_int {
        return None;
    }

    let info = unsafe { info.assume_init() };
    let raw = unsafe { CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr()) };
    let path = raw.to_string_lossy();
    (!path.is_empty()).then(|| PathBuf::from(path.into_owned()))
}

#[cfg(not(target_os = "macos"))]
fn resolve_process_cwd_from_libproc(_pid: libc::pid_t) -> Option<PathBuf> {
    None
}

#[cfg(unix)]
fn resolve_process_cwd_from_lsof(pid: libc::pid_t) -> Option<PathBuf> {
    let output = std::process::Command::new("lsof")
        .args(["-a", "-d", "cwd", "-p", &pid.to_string(), "-Fn"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix('n').map(PathBuf::from))
}

impl Drop for LiveTab {
    fn drop(&mut self) {
        self.kill();
        self._reader_handle.abort();
    }
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn proc_name(pid: libc::c_int, buffer: *mut libc::c_void, buffersize: u32) -> libc::c_int;
    fn proc_pidpath(pid: libc::c_int, buffer: *mut libc::c_void, buffersize: u32) -> libc::c_int;
    fn proc_pidinfo(
        pid: libc::c_int,
        flavor: libc::c_int,
        arg: u64,
        buffer: *mut libc::c_void,
        buffersize: libc::c_int,
    ) -> libc::c_int;
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct VinfoStat {
    vst_dev: u32,
    vst_mode: u16,
    vst_nlink: u16,
    vst_ino: u64,
    vst_uid: libc::uid_t,
    vst_gid: libc::gid_t,
    vst_atime: i64,
    vst_atimensec: i64,
    vst_mtime: i64,
    vst_mtimensec: i64,
    vst_ctime: i64,
    vst_ctimensec: i64,
    vst_birthtime: i64,
    vst_birthtimensec: i64,
    vst_size: libc::off_t,
    vst_blocks: i64,
    vst_blksize: i32,
    vst_flags: u32,
    vst_gen: u32,
    vst_rdev: u32,
    vst_qspare: [i64; 2],
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct VnodeInfo {
    vi_stat: VinfoStat,
    vi_type: libc::c_int,
    vi_pad: libc::c_int,
    vi_fsid: libc::fsid_t,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct VnodeInfoPath {
    vip_vi: VnodeInfo,
    vip_path: [libc::c_char; MAXPATHLEN],
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct ProcVnodePathInfo {
    pvi_cdir: VnodeInfoPath,
    pvi_rdir: VnodeInfoPath,
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
    use std::cell::Cell;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration as StdDuration;
    use std::time::Duration;

    use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
    use tokio::time::Instant;

    use super::{
        AttachmentRegistry, DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS, DEFAULT_SCROLLBACK, LiveTab,
        OutputState, RestoredTerminalBuffers, RestoredTerminalState, TabInfo,
        TerminalSignalScanner, TerminalSize, build_replay_history_from_buffers,
    };

    #[test]
    fn scanner_detects_standalone_bel() {
        let mut s = TerminalSignalScanner::new();
        assert!(s.scan(b"hello\x07world").notified);
    }

    #[test]
    fn scanner_ignores_bel_as_osc_terminator() {
        let mut s = TerminalSignalScanner::new();
        // OSC 52 (clipboard) terminated by BEL — not a bell
        assert!(!s.scan(b"\x1b]52;c;dGVzdA==\x07").notified);
    }

    #[test]
    fn scanner_detects_osc_9() {
        let mut s = TerminalSignalScanner::new();
        assert!(s.scan(b"\x1b]9;2;task done\x07").notified);
    }

    #[test]
    fn scanner_detects_osc_777() {
        let mut s = TerminalSignalScanner::new();
        assert!(s.scan(b"\x1b]777;notify;title;body\x07").notified);
    }

    #[test]
    fn scanner_extracts_title_from_osc_0() {
        let mut s = TerminalSignalScanner::new();
        let result = s.scan(b"\x1b]0;window title\x07");
        assert!(!result.notified);
        assert_eq!(result.title, Some(Some("window title".to_string())));
    }

    #[test]
    fn scanner_extracts_empty_title_as_clear() {
        let mut s = TerminalSignalScanner::new();
        let result = s.scan(b"\x1b]2;\x07");
        assert_eq!(result.title, Some(None));
    }

    #[test]
    fn scanner_handles_osc_with_st_terminator() {
        let mut s = TerminalSignalScanner::new();
        assert!(s.scan(b"\x1b]9;2;done\x1b\\").notified);
    }

    #[test]
    fn scanner_handles_split_chunks() {
        let mut s = TerminalSignalScanner::new();
        // ESC in first chunk, ] in second
        assert!(!s.scan(b"output\x1b").notified);
        assert!(s.scan(b"]9;task done\x07").notified);
    }

    #[test]
    fn scanner_handles_split_osc_number() {
        let mut s = TerminalSignalScanner::new();
        assert!(!s.scan(b"\x1b]77").notified);
        assert!(s.scan(b"7;notify;title;body\x07").notified);
    }

    #[test]
    fn scanner_handles_split_title_payload() {
        let mut s = TerminalSignalScanner::new();
        assert_eq!(s.scan(b"\x1b]2;wind").title, None);
        assert_eq!(
            s.scan(b"ow title\x07").title,
            Some(Some("window title".to_string()))
        );
    }

    #[test]
    fn scanner_no_false_positive_on_plain_text() {
        let mut s = TerminalSignalScanner::new();
        assert!(!s.scan(b"just some regular terminal output\r\n").notified);
    }

    #[test]
    fn scanner_ignores_bel_as_dcs_terminator() {
        let mut s = TerminalSignalScanner::new();
        // DCS sequence terminated by BEL — not a bell
        assert!(!s.scan(b"\x1bPq#0;2;0;0;0#1;2;100;100;0\x07").notified);
    }

    #[test]
    fn scanner_ignores_bel_as_pm_terminator() {
        let mut s = TerminalSignalScanner::new();
        // PM sequence terminated by BEL — not a bell
        assert!(!s.scan(b"\x1b^some private message\x07").notified);
    }

    #[test]
    fn scanner_ignores_bel_as_apc_terminator() {
        let mut s = TerminalSignalScanner::new();
        // APC sequence terminated by BEL — not a bell
        assert!(!s.scan(b"\x1b_Gf=100,a=T;payload\x07").notified);
    }

    #[test]
    fn scanner_detects_bel_after_dcs_ends() {
        let mut s = TerminalSignalScanner::new();
        // DCS terminated by ST, then standalone BEL
        assert!(s.scan(b"\x1bPq#0\x1b\\\x07").notified);
    }

    #[test]
    fn scanner_esc_in_osc_number_starts_new_sequence() {
        let mut s = TerminalSignalScanner::new();
        // Malformed OSC interrupted by ESC starting new OSC 9
        assert!(s.scan(b"\x1b]12\x1b]9;bell\x07").notified);
    }

    #[test]
    fn normalize_process_label_uses_command_basename() {
        assert_eq!(
            super::normalize_process_label("/opt/homebrew/bin/bun"),
            Some("bun".to_string())
        );
        assert_eq!(
            super::normalize_process_label("cargo"),
            Some("cargo".to_string())
        );
        assert_eq!(super::normalize_process_label("  "), None);
    }

    #[test]
    fn normalize_shell_process_name_strips_login_prefix() {
        assert_eq!(
            super::normalize_shell_process_name("/bin/-zsh"),
            Some("zsh".to_string())
        );
    }

    #[test]
    fn format_home_relative_path_uses_tilde_prefix() {
        let home = Path::new("/Users/jimeh");
        assert_eq!(
            super::format_home_relative_path(Path::new("/Users/jimeh/projects/hubris"), Some(home)),
            "~/projects/hubris"
        );
        assert_eq!(
            super::format_home_relative_path(Path::new("/Users/jimeh"), Some(home)),
            "~"
        );
        assert_eq!(
            super::format_home_relative_path(Path::new("/tmp/hubris"), Some(home)),
            "/tmp/hubris"
        );
    }

    #[test]
    fn format_smart_shell_path_uses_worktree_relative_prefix() {
        let home = Path::new("/Users/jimeh");
        let worktree_root = Path::new("/Users/jimeh/projects/hubris");

        assert_eq!(
            super::format_smart_shell_path(worktree_root, worktree_root, Some(home)),
            "./"
        );
        assert_eq!(
            super::format_smart_shell_path(
                Path::new("/Users/jimeh/projects/hubris/apps/server"),
                worktree_root,
                Some(home)
            ),
            "./apps/server"
        );
        assert_eq!(
            super::format_smart_shell_path(
                Path::new("/Users/jimeh/projects/other"),
                worktree_root,
                Some(home)
            ),
            "~/projects/other"
        );
    }

    #[test]
    fn smart_label_prefers_shell_cwd_when_foreground_process_is_shell() {
        assert!(super::process_name_matches_shell("zsh", "zsh"));
        assert!(super::process_name_matches_shell("-zsh", "zsh"));
        assert!(!super::process_name_matches_shell("cargo", "zsh"));
    }

    #[cfg(unix)]
    #[test]
    fn process_label_cache_reuses_fresh_entry_for_same_pid() {
        let cache = Mutex::new(super::ProcessLabelCache::default());
        let calls = Cell::new(0);
        let now = Instant::now();

        let first = super::resolve_process_label_with_cache(
            &cache,
            123,
            now,
            Duration::from_secs(5),
            |_| {
                calls.set(calls.get() + 1);
                Some("cargo".to_string())
            },
        );
        let second = super::resolve_process_label_with_cache(
            &cache,
            123,
            now + Duration::from_secs(1),
            Duration::from_secs(5),
            |_| {
                calls.set(calls.get() + 1);
                Some("ignored".to_string())
            },
        );

        assert_eq!(first, Some("cargo".to_string()));
        assert_eq!(second, Some("cargo".to_string()));
        assert_eq!(calls.get(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn process_label_cache_refreshes_when_entry_expires() {
        let cache = Mutex::new(super::ProcessLabelCache::default());
        let calls = Cell::new(0);
        let now = Instant::now();

        let first = super::resolve_process_label_with_cache(
            &cache,
            123,
            now,
            Duration::from_secs(5),
            |_| {
                calls.set(calls.get() + 1);
                Some("cargo".to_string())
            },
        );
        let second = super::resolve_process_label_with_cache(
            &cache,
            123,
            now + Duration::from_secs(6),
            Duration::from_secs(5),
            |_| {
                calls.set(calls.get() + 1);
                Some("bun".to_string())
            },
        );

        assert_eq!(first, Some("cargo".to_string()));
        assert_eq!(second, Some("bun".to_string()));
        assert_eq!(calls.get(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn process_cwd_cache_reuses_fresh_entry_for_same_pid() {
        let cache = Mutex::new(super::ProcessCwdCache::default());
        let calls = Cell::new(0);
        let now = Instant::now();

        let first =
            super::resolve_process_cwd_with_cache(&cache, 123, now, Duration::from_secs(2), |_| {
                calls.set(calls.get() + 1);
                Some(PathBuf::from("/tmp/first"))
            });
        let second = super::resolve_process_cwd_with_cache(
            &cache,
            123,
            now + Duration::from_millis(500),
            Duration::from_secs(2),
            |_| {
                calls.set(calls.get() + 1);
                Some(PathBuf::from("/tmp/ignored"))
            },
        );

        assert_eq!(first, Some(PathBuf::from("/tmp/first")));
        assert_eq!(second, Some(PathBuf::from("/tmp/first")));
        assert_eq!(calls.get(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn process_cwd_cache_refreshes_when_entry_expires() {
        let cache = Mutex::new(super::ProcessCwdCache::default());
        let calls = Cell::new(0);
        let now = Instant::now();

        let first =
            super::resolve_process_cwd_with_cache(&cache, 123, now, Duration::from_secs(2), |_| {
                calls.set(calls.get() + 1);
                Some(PathBuf::from("/tmp/first"))
            });
        let second = super::resolve_process_cwd_with_cache(
            &cache,
            123,
            now + Duration::from_secs(3),
            Duration::from_secs(2),
            |_| {
                calls.set(calls.get() + 1);
                Some(PathBuf::from("/tmp/second"))
            },
        );

        assert_eq!(first, Some(PathBuf::from("/tmp/first")));
        assert_eq!(second, Some(PathBuf::from("/tmp/second")));
        assert_eq!(calls.get(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn process_label_cache_recovers_after_mutex_poison() {
        let cache = Mutex::new(super::ProcessLabelCache::default());
        let now = Instant::now();

        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = cache.lock().unwrap();
            panic!("poison cache");
        }));

        let resolved = super::resolve_process_label_with_cache(
            &cache,
            123,
            now,
            Duration::from_secs(5),
            |_| Some("cargo".to_string()),
        );

        assert_eq!(resolved, Some("cargo".to_string()));
    }

    #[test]
    fn terminal_size_clamps_tiny_dimensions() {
        assert_eq!(TerminalSize::new(0, 0).clamped(), TerminalSize::new(8, 2));
        assert_eq!(TerminalSize::new(1, 4).clamped(), TerminalSize::new(8, 4));
    }

    fn test_cat_path() -> &'static str {
        ["/bin/cat", "/usr/bin/cat"]
            .into_iter()
            .find(|path| std::path::Path::new(path).is_file())
            .expect("expected cat at /bin/cat or /usr/bin/cat")
    }

    fn spawn_test_live_tab() -> Arc<LiveTab> {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(TerminalSize::default_pty().to_pty_size())
            .unwrap();

        let mut cmd = CommandBuilder::new(test_cat_path());
        // PTY tests run inside the Linux docker:test container. portable-pty's
        // controlling-tty setup can fail there even though the child command
        // itself is fine, and these tests only need a simple echoing process.
        cmd.set_controlling_tty(false);
        cmd.cwd("/");
        cmd.env("TERM", "xterm-256color");

        let child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);

        Arc::new(
            LiveTab::spawn(
                TabInfo::Terminal {
                    id: "tab".to_string(),
                    session_id: "default".to_string(),
                    worktree_id: "worktree".to_string(),
                    pane_id: "pane-1".to_string(),
                    label: "Terminal 1".to_string(),
                    position: 1.0,
                    created_at: 0,
                    preview: false,
                    has_notification: false,
                    labels: crate::tab::TerminalTabLabels {
                        custom_label: None,
                        smart_label: None,
                        title_label: None,
                    },
                },
                Some("sh".to_string()),
                PathBuf::from("/tmp/worktree"),
                pair.master,
                child,
                DEFAULT_SCROLLBACK,
                TerminalSize::default_pty(),
            )
            .expect("spawn test live tab"),
        )
    }

    fn spawn_test_restored_tab(history: Vec<u8>, size: TerminalSize) -> Arc<LiveTab> {
        let pty_system = NativePtySystem::default();
        let pair = pty_system.openpty(size.to_pty_size()).unwrap();

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("cat");
        cmd.set_controlling_tty(false);
        cmd.cwd("/");
        cmd.env("TERM", "xterm-256color");

        let child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);

        Arc::new(
            LiveTab::spawn_restored(
                TabInfo::Terminal {
                    id: "tab".to_string(),
                    session_id: "default".to_string(),
                    worktree_id: "worktree".to_string(),
                    pane_id: "pane-1".to_string(),
                    label: "Terminal 1".to_string(),
                    position: 1.0,
                    created_at: 0,
                    preview: false,
                    has_notification: false,
                    labels: crate::tab::TerminalTabLabels {
                        custom_label: None,
                        smart_label: None,
                        title_label: None,
                    },
                },
                Some("sh".to_string()),
                PathBuf::from("/tmp/worktree"),
                pair.master,
                child,
                DEFAULT_SCROLLBACK,
                RestoredTerminalState {
                    size,
                    buffers: RestoredTerminalBuffers { history },
                },
            )
            .expect("spawn test restored tab"),
        )
    }

    /// A `MasterPty` whose reader/writer handles always fail, used to drive
    /// the spawn error path.
    #[cfg(unix)]
    #[derive(Debug)]
    struct FailingMaster;

    #[cfg(unix)]
    impl MasterPty for FailingMaster {
        fn resize(&self, _size: PtySize) -> Result<(), anyhow::Error> {
            Ok(())
        }

        fn get_size(&self) -> Result<PtySize, anyhow::Error> {
            Ok(PtySize::default())
        }

        fn try_clone_reader(&self) -> Result<Box<dyn std::io::Read + Send>, anyhow::Error> {
            Err(anyhow::anyhow!("pty reader unavailable"))
        }

        fn take_writer(&self) -> Result<Box<dyn std::io::Write + Send>, anyhow::Error> {
            Err(anyhow::anyhow!("pty writer unavailable"))
        }

        fn process_group_leader(&self) -> Option<libc::pid_t> {
            None
        }

        fn as_raw_fd(&self) -> Option<std::os::unix::io::RawFd> {
            None
        }

        fn tty_name(&self) -> Option<PathBuf> {
            None
        }
    }

    /// Wraps a real child and records whether the spawn error path reaped it.
    #[cfg(unix)]
    #[derive(Debug)]
    struct ReapTrackingChild {
        inner: Box<dyn portable_pty::Child + Send + Sync>,
        killed: Arc<std::sync::atomic::AtomicBool>,
        waited: Arc<std::sync::atomic::AtomicBool>,
    }

    #[cfg(unix)]
    impl portable_pty::ChildKiller for ReapTrackingChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.killed.store(true, std::sync::atomic::Ordering::SeqCst);
            self.inner.kill()
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            self.inner.clone_killer()
        }
    }

    #[cfg(unix)]
    impl portable_pty::Child for ReapTrackingChild {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            self.inner.try_wait()
        }

        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            self.waited.store(true, std::sync::atomic::Ordering::SeqCst);
            self.inner.wait()
        }

        fn process_id(&self) -> Option<u32> {
            self.inner.process_id()
        }
    }

    #[cfg(unix)]
    #[test]
    fn spawn_returns_error_when_pty_reader_unavailable() {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(TerminalSize::default_pty().to_pty_size())
            .unwrap();

        let mut cmd = CommandBuilder::new(test_cat_path());
        cmd.set_controlling_tty(false);
        cmd.cwd("/");
        cmd.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        // Drop the real master and hand spawn one that refuses to yield a
        // reader, exercising the spawn failure path.
        drop(pair.master);

        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let waited = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let child = Box::new(ReapTrackingChild {
            inner: child,
            killed: killed.clone(),
            waited: waited.clone(),
        });

        let result = LiveTab::spawn(
            TabInfo::Terminal {
                id: "tab".to_string(),
                session_id: "default".to_string(),
                worktree_id: "worktree".to_string(),
                pane_id: "pane-1".to_string(),
                label: "Terminal 1".to_string(),
                position: 1.0,
                created_at: 0,
                preview: false,
                has_notification: false,
                labels: crate::tab::TerminalTabLabels {
                    custom_label: None,
                    smart_label: None,
                    title_label: None,
                },
            },
            Some("sh".to_string()),
            PathBuf::from("/tmp/worktree"),
            Box::new(FailingMaster),
            child,
            DEFAULT_SCROLLBACK,
            TerminalSize::default_pty(),
        );

        assert!(result.is_err());
        // The failure path must reap the already-running shell child rather
        // than leaving it orphaned.
        assert!(killed.load(std::sync::atomic::Ordering::SeqCst));
        assert!(waited.load(std::sync::atomic::Ordering::SeqCst));
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
    async fn restored_attach_omits_alternate_screen_history() {
        let normal_history = b"before alt\r\n";
        let enable_mouse = b"\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h";
        let body = b"\x1b[31mhtop\x1b[m";
        let mut restored = Vec::new();
        restored.extend_from_slice(normal_history);
        restored.extend_from_slice(enable_mouse);
        restored.extend_from_slice(body);
        let restored_size = TerminalSize::new(132, 47);
        let replay_history = build_replay_history_from_buffers(restored_size, &restored, &[]);
        let tab = spawn_test_restored_tab(replay_history.clone(), restored_size);

        let first_attachment = tab.attach(Some(0));
        let first_payload = String::from_utf8_lossy(&first_attachment.initial_payload);

        assert!(!first_attachment.snapshot);
        assert_eq!(first_attachment.current_size, restored_size);
        assert!(first_payload.contains("before alt"));
        assert!(!first_payload.contains("htop"));
        assert!(!first_payload.contains("\x1b[?1049h"));
        assert!(!first_payload.contains("\x1b[?1000h"));
        assert!(!first_payload.contains("\x1b[?1002h"));
        assert!(!first_payload.contains("\x1b[?1006h"));

        let second_attachment = tab.attach(None);
        let second_payload = String::from_utf8_lossy(&second_attachment.initial_payload);

        assert!(second_attachment.snapshot);
        assert_eq!(second_attachment.current_size, restored_size);
        assert!(second_payload.contains("before alt"));
        assert!(!second_payload.contains("htop"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn restored_attach_replays_inert_history_for_every_fresh_attach() {
        let restored = b"\x1b[31mclaude\x1b[m".to_vec();
        let tab = spawn_test_restored_tab(restored.clone(), TerminalSize::default_pty());

        let first_attachment = tab.attach(Some(0));
        let first_payload = String::from_utf8_lossy(&first_attachment.initial_payload);
        assert!(first_payload.contains("claude"));
        assert!(first_payload.contains("\x1b[31m"));

        let second_attachment = tab.attach(None);
        let second_payload = String::from_utf8_lossy(&second_attachment.initial_payload);
        assert!(second_payload.contains("claude"));
        assert!(second_payload.contains("\x1b[31m"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn restored_attach_byte_offset_includes_restored_history() {
        let restored = b"before restart\r\n".to_vec();
        let tab = spawn_test_restored_tab(restored.clone(), TerminalSize::default_pty());

        let attachment = tab.attach(Some(0));

        assert_eq!(
            attachment.byte_offset,
            attachment.initial_payload.len() as u64
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn restored_resume_replays_missing_history_prefix() {
        let restored = b"before restart".to_vec();
        let tab = spawn_test_restored_tab(restored.clone(), TerminalSize::default_pty());

        let first_attachment = tab.attach(Some(0));
        let resume_from = first_attachment.byte_offset.saturating_sub(4);
        let resumed_attachment = tab.attach(Some(resume_from));
        let resumed_payload = String::from_utf8_lossy(&resumed_attachment.initial_payload);

        assert!(!resumed_attachment.snapshot);
        assert!(resumed_payload.contains("tart"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn restored_attach_trims_blank_tail_rows() {
        let restored = b"~/Devbox\r\n\x1b[32m>\x1b[m ".to_vec();
        let tab = spawn_test_restored_tab(restored.clone(), TerminalSize::new(132, 47));

        let attachment = tab.attach(Some(0));
        let payload = String::from_utf8_lossy(&attachment.initial_payload);

        assert!(payload.contains("~/Devbox"));
        assert!(!payload.contains("\n\n\n\n\n\n\n\n\n\n"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn restored_attach_resets_formatting_after_non_wrapped_rows() {
        let restored = b"\x1b[4mVagrantfile\x1b[m\r\nprompt".to_vec();
        let tab = spawn_test_restored_tab(restored.clone(), TerminalSize::new(132, 47));

        let attachment = tab.attach(Some(0));
        let mut parser = vt100::Parser::new(DEFAULT_PTY_ROWS, DEFAULT_PTY_COLS, 0);
        parser.process(&attachment.initial_payload);

        assert!(!parser.screen().underline());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resize_updates_parser_size() {
        let tab = spawn_test_live_tab();

        assert!(tab.resize_pty(TerminalSize::new(120, 40)));

        assert_eq!(tab.screen_for_test().size(), (40, 120));
    }

    #[test]
    fn replay_history_omits_alternate_screen_bytes_before_budgeting() {
        let mut output_state = OutputState::new(64, TerminalSize::default_pty());
        output_state.record_output(b"before alt\r\n", 64);
        output_state.record_output(b"\x1b[?1049h", 64);
        output_state.record_output(&vec![b'x'; 1024], 64);
        output_state.record_output(b"\x1b[?1049l", 64);

        let replay_history = output_state.replay_history();
        let history = String::from_utf8_lossy(&replay_history);

        assert!(history.contains("before alt"));
        assert!(!history.contains("xxxxxxxxxx"));
    }
}
