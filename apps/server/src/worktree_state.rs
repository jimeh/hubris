use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqliteJournalMode, SqliteSynchronous};
use sqlx::{Connection as _, QueryBuilder, Row, Sqlite, Transaction};
use tokio::sync::{mpsc, oneshot};
use tokio::time::MissedTickBehavior;
use ts_rs::TS;
use utoipa::ToSchema;

use crate::pty::live_tab::TerminalSize;
use crate::tab::{TabInfo, TerminalTabLabels, WorktreePaneNode, WorktreeTabLayout};

const WRITER_TICK: Duration = Duration::from_millis(250);
const TERMINAL_REPLAY_CHUNK_SIZE: usize = 32 * 1024;
static STATE_DB_MIGRATOR: Migrator = sqlx::migrate!();

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRestoreState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pane_mru: Vec<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub tab_mru_by_pane: HashMap<String, Vec<String>>,
}

pub fn normalize_restore_state_for_snapshot(
    restore_state: WorktreeRestoreState,
    tabs: &[TabInfo],
    layout: Option<&WorktreeTabLayout>,
) -> WorktreeRestoreState {
    let mut valid_pane_ids = layout
        .map(|layout| {
            layout
                .nodes
                .iter()
                .filter_map(|node| match node {
                    WorktreePaneNode::Leaf { pane_id, .. } => Some(pane_id.clone()),
                    WorktreePaneNode::Split { .. } => None,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    for tab in tabs {
        if !valid_pane_ids
            .iter()
            .any(|pane_id| pane_id == tab.pane_id())
        {
            valid_pane_ids.push(tab.pane_id().to_string());
        }
    }

    let tabs_by_id: HashMap<String, &TabInfo> =
        tabs.iter().map(|tab| (tab.id().to_string(), tab)).collect();
    let mut seen_panes = std::collections::HashSet::new();
    let mut pane_mru = restore_state
        .pane_mru
        .into_iter()
        .filter(|pane_id| valid_pane_ids.iter().any(|candidate| candidate == pane_id))
        .filter(|pane_id| seen_panes.insert(pane_id.clone()))
        .collect::<Vec<_>>();

    let active_tab_id = restore_state
        .active_tab_id
        .filter(|tab_id| tabs_by_id.contains_key(tab_id));
    let active_tab_pane_id = active_tab_id
        .as_ref()
        .and_then(|tab_id| tabs_by_id.get(tab_id))
        .map(|tab| tab.pane_id().to_string());

    let mut focused_pane_id = restore_state
        .focused_pane_id
        .filter(|pane_id| valid_pane_ids.iter().any(|candidate| candidate == pane_id));
    if focused_pane_id.is_none() {
        focused_pane_id = pane_mru
            .first()
            .cloned()
            .or(active_tab_pane_id.clone())
            .or_else(|| valid_pane_ids.first().cloned());
    }
    if let Some(focused_pane_id) = focused_pane_id.clone() {
        pane_mru.retain(|pane_id| pane_id != &focused_pane_id);
        pane_mru.insert(0, focused_pane_id);
    }

    let mut tab_mru_by_pane = HashMap::new();
    for (pane_id, tab_ids) in restore_state.tab_mru_by_pane {
        if !valid_pane_ids.iter().any(|candidate| candidate == &pane_id) {
            continue;
        }

        let mut seen_tab_ids = std::collections::HashSet::new();
        let normalized = tab_ids
            .into_iter()
            .filter(|tab_id| {
                tabs_by_id
                    .get(tab_id)
                    .is_some_and(|tab| tab.pane_id() == pane_id)
            })
            .filter(|tab_id| seen_tab_ids.insert(tab_id.clone()))
            .collect::<Vec<_>>();

        if !normalized.is_empty() {
            tab_mru_by_pane.insert(pane_id, normalized);
        }
    }

    if let (Some(active_tab_id), Some(active_tab_pane_id)) =
        (active_tab_id.clone(), active_tab_pane_id)
    {
        let entry = tab_mru_by_pane.entry(active_tab_pane_id).or_default();
        entry.retain(|tab_id| tab_id != &active_tab_id);
        entry.insert(0, active_tab_id);
    }

    WorktreeRestoreState {
        active_tab_id,
        focused_pane_id,
        pane_mru,
        tab_mru_by_pane,
    }
}

#[derive(Debug, Clone)]
pub struct LoadedWorktreeState {
    pub project_id: String,
    pub worktree_id: String,
    pub layout: Option<WorktreeTabLayout>,
    pub tabs: Vec<TabInfo>,
    pub restore_state: WorktreeRestoreState,
    pub next_terminal_number: u32,
}

#[derive(Debug, Clone)]
pub struct LoadedStateSnapshot {
    pub worktrees: Vec<LoadedWorktreeState>,
}

#[derive(Debug, Clone)]
pub struct TerminalRestorePayload {
    pub size: TerminalSize,
    pub history: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct TerminalPersistedState {
    pub kind: TerminalPersistedStateKind,
}

#[derive(Debug, Clone)]
pub enum TerminalPersistedStateKind {
    Append {
        size: TerminalSize,
        replay_budget_bytes: usize,
        replay_epoch: u64,
        source_bytes_end: u64,
        replay_total_bytes: u64,
        replay_append: Vec<u8>,
    },
    Rebuild {
        size: TerminalSize,
        replay_budget_bytes: usize,
        replay_epoch: u64,
        source_bytes_end: u64,
        replay_total_bytes: u64,
        replay_history: Vec<u8>,
    },
}

#[derive(Debug, Clone)]
pub struct TerminalFlush {
    pub project_id: String,
    pub worktree_id: String,
    pub tab_id: String,
    pub metadata: TerminalPersistedState,
    pub flushed_at_ms: u64,
}

#[derive(Debug, Clone)]
pub struct TerminalLabelsSnapshot {
    pub project_id: String,
    pub worktree_id: String,
    pub tab_id: String,
    pub custom_label: Option<String>,
    pub process_label: Option<String>,
}

#[derive(Debug, Clone)]
pub struct WorktreeSnapshot {
    pub project_id: String,
    pub worktree_id: String,
    pub layout: Option<WorktreeTabLayout>,
    pub tabs: Vec<TabInfo>,
    pub restore_state: WorktreeRestoreState,
    pub next_terminal_number: u32,
}

#[derive(Debug, Clone)]
pub struct ExistingWorktree {
    pub project_id: String,
    pub worktree_id: String,
}

#[derive(Debug)]
pub struct WorktreeStateService {
    tx: mpsc::UnboundedSender<Command>,
    db_path: PathBuf,
}

impl WorktreeStateService {
    pub async fn new(db_path: PathBuf) -> std::io::Result<Self> {
        if let Some(parent) = db_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let (tx, rx) = mpsc::unbounded_channel();
        let (ready_tx, ready_rx) = oneshot::channel();
        let thread_db_path = db_path.clone();
        thread::Builder::new()
            .name("worktree-state".to_string())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("failed to build worktree-state runtime");
                runtime.block_on(async move {
                    match open_connection(&thread_db_path).await {
                        Ok(conn) => {
                            let _ = ready_tx.send(Ok(()));
                            run_worker(conn, rx).await;
                        }
                        Err(error) => {
                            let _ = ready_tx.send(Err(error));
                        }
                    }
                });
            })
            .map_err(io::Error::other)?;
        ready_rx.await.map_err(channel_closed)??;

        Ok(Self { tx, db_path })
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub async fn load_existing(
        self: std::sync::Arc<Self>,
        existing_worktrees: Vec<ExistingWorktree>,
    ) -> std::io::Result<LoadedStateSnapshot> {
        let (reply_tx, reply_rx) = oneshot::channel();
        let tx = self.tx.clone();
        tx.send(Command::LoadExisting {
            existing_worktrees,
            reply: reply_tx,
        })
        .map_err(channel_closed)?;
        reply_rx.await.map_err(channel_closed)?
    }

    pub fn replace_worktree_state(&self, snapshot: WorktreeSnapshot) {
        let _ = self.tx.send(Command::ReplaceWorktreeState { snapshot });
    }

    pub fn update_restore_state(
        &self,
        project_id: String,
        worktree_id: String,
        restore_state: WorktreeRestoreState,
    ) {
        let _ = self.tx.send(Command::UpdateRestoreState {
            project_id,
            worktree_id,
            restore_state,
        });
    }

    pub fn enqueue_terminal_flush(&self, flush: TerminalFlush) {
        let _ = self.tx.send(Command::EnqueueTerminalFlush { flush });
    }

    pub fn update_terminal_labels(&self, labels: TerminalLabelsSnapshot) {
        let _ = self.tx.send(Command::UpdateTerminalLabels { labels });
    }

    pub async fn load_terminal_restore_payload(
        self: std::sync::Arc<Self>,
        tab_id: String,
        replay_budget_bytes: usize,
    ) -> std::io::Result<TerminalRestorePayload> {
        let (reply_tx, reply_rx) = oneshot::channel();
        let tx = self.tx.clone();
        tx.send(Command::LoadTerminalRestorePayload {
            tab_id,
            replay_budget_bytes,
            reply: reply_tx,
        })
        .map_err(channel_closed)?;
        reply_rx.await.map_err(channel_closed)?
    }

    pub fn delete_tab_state(&self, tab_id: String, worktree_id: String) {
        let _ = self.tx.send(Command::DeleteTabState {
            tab_id,
            worktree_id,
        });
    }

    pub fn delete_worktree(&self, project_id: String, worktree_id: String) {
        let _ = self.tx.send(Command::DeleteWorktree {
            project_id,
            worktree_id,
        });
    }

    pub fn delete_project(&self, project_id: String) {
        let _ = self.tx.send(Command::DeleteProject { project_id });
    }

    pub async fn shutdown(self: std::sync::Arc<Self>) -> std::io::Result<()> {
        let (reply_tx, reply_rx) = oneshot::channel();
        let tx = self.tx.clone();
        tx.send(Command::Shutdown { reply: reply_tx })
            .map_err(channel_closed)?;
        reply_rx.await.map_err(channel_closed)?
    }
}

#[derive(Debug)]
enum Command {
    LoadExisting {
        existing_worktrees: Vec<ExistingWorktree>,
        reply: oneshot::Sender<std::io::Result<LoadedStateSnapshot>>,
    },
    ReplaceWorktreeState {
        snapshot: WorktreeSnapshot,
    },
    UpdateRestoreState {
        project_id: String,
        worktree_id: String,
        restore_state: WorktreeRestoreState,
    },
    UpdateTerminalLabels {
        labels: TerminalLabelsSnapshot,
    },
    EnqueueTerminalFlush {
        flush: TerminalFlush,
    },
    LoadTerminalRestorePayload {
        tab_id: String,
        replay_budget_bytes: usize,
        reply: oneshot::Sender<std::io::Result<TerminalRestorePayload>>,
    },
    DeleteTabState {
        tab_id: String,
        worktree_id: String,
    },
    DeleteWorktree {
        project_id: String,
        worktree_id: String,
    },
    DeleteProject {
        project_id: String,
    },
    Shutdown {
        reply: oneshot::Sender<std::io::Result<()>>,
    },
}

#[derive(Debug, Default)]
struct WriterState {
    pending_terminal_flushes: VecDeque<TerminalFlush>,
    pending_worktree_snapshots: HashMap<String, WorktreeSnapshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExistingDatabaseState {
    Fresh,
    SqlxManaged,
    Unrecognized,
}

fn channel_closed<T>(_error: T) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::BrokenPipe,
        "worktree state service channel closed",
    )
}

async fn run_worker(mut conn: SqliteConnection, mut rx: mpsc::UnboundedReceiver<Command>) {
    let mut state = WriterState::default();
    let mut tick = tokio::time::interval(WRITER_TICK);
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            maybe_command = rx.recv() => {
                match maybe_command {
                    Some(Command::Shutdown { reply }) => {
                        let result = match flush_pending_worktree_snapshots(
                            &mut conn,
                            &mut state,
                        )
                        .await
                        {
                            Ok(()) => match flush_pending_terminal_batches(
                                &mut conn,
                                &mut state,
                            )
                            .await
                            {
                                Ok(()) => checkpoint_database(&mut conn)
                                .await
                                .map_err(std::io::Error::other),
                                Err(error) => Err(std::io::Error::other(error)),
                            },
                            Err(error) => Err(std::io::Error::other(error)),
                        };
                        let _ = reply.send(result);
                        break;
                    }
                    Some(command) => handle_command(&mut conn, &mut state, command).await,
                    None => {
                        let _ = flush_pending_worktree_snapshots(&mut conn, &mut state).await;
                        let _ = flush_pending_terminal_batches(&mut conn, &mut state).await;
                        let _ = checkpoint_database(&mut conn).await;
                        break;
                    }
                }
            }
            _ = tick.tick() => {
                if let Err(error) = flush_pending_worktree_snapshots(&mut conn, &mut state).await
                {
                    tracing::warn!("failed to flush pending worktree state: {error}");
                }
                if let Err(error) = flush_pending_terminal_batches(&mut conn, &mut state).await {
                    tracing::warn!("failed to flush pending terminal state: {error}");
                }
            }
        }
    }
}

async fn open_connection(path: &Path) -> io::Result<SqliteConnection> {
    let existed = path.exists();
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(false);
    let mut conn = SqliteConnection::connect_with(&options)
        .await
        .map_err(io::Error::other)?;

    if existed && existing_database_state(&mut conn).await? == ExistingDatabaseState::Unrecognized {
        return Err(io::Error::other(format!(
            "existing state database at {} is not a valid sqlx-managed Hubris state DB",
            path.display()
        )));
    }

    STATE_DB_MIGRATOR
        .run(&mut conn)
        .await
        .map_err(|error| map_migration_error(path, error))?;
    cleanup_orphaned_tab_rows(&mut conn)
        .await
        .map_err(io::Error::other)?;
    Ok(conn)
}

fn map_migration_error(path: &Path, error: sqlx::migrate::MigrateError) -> io::Error {
    let detail = error.to_string();
    let hint = if detail.contains("previously applied but has been modified") {
        " If this is a disposable dev database from an older local iteration, \
         removing the state.sqlite3 file and restarting will recreate it."
    } else {
        ""
    };

    io::Error::other(format!(
        "failed to initialize state database schema at {}: {}{}",
        path.display(),
        detail,
        hint
    ))
}

async fn existing_database_state(conn: &mut SqliteConnection) -> io::Result<ExistingDatabaseState> {
    let rows = sqlx::query!(
        "
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name
        "
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(io::Error::other)?;

    if rows.is_empty() {
        return Ok(ExistingDatabaseState::Fresh);
    }

    if rows
        .iter()
        .any(|row| row.name.as_deref() == Some("_sqlx_migrations"))
    {
        return Ok(ExistingDatabaseState::SqlxManaged);
    }

    Ok(ExistingDatabaseState::Unrecognized)
}

fn axis_to_string(axis: crate::tab::TabPaneSplitAxis) -> &'static str {
    match axis {
        crate::tab::TabPaneSplitAxis::Horizontal => "horizontal",
        crate::tab::TabPaneSplitAxis::Vertical => "vertical",
    }
}

fn git_diff_scope_to_string(scope: crate::tab::GitDiffScope) -> &'static str {
    match scope {
        crate::tab::GitDiffScope::Staged => "staged",
        crate::tab::GitDiffScope::Unstaged => "unstaged",
        crate::tab::GitDiffScope::Commit => "commit",
    }
}

async fn handle_command(conn: &mut SqliteConnection, state: &mut WriterState, command: Command) {
    match command {
        Command::LoadExisting {
            existing_worktrees,
            reply,
        } => {
            let _ = flush_pending_worktree_snapshots(conn, state).await;
            let _ = flush_pending_terminal_batches(conn, state).await;
            let _ = reply.send(
                load_existing_worktrees(conn, existing_worktrees)
                    .await
                    .map_err(std::io::Error::other),
            );
        }
        Command::ReplaceWorktreeState { snapshot } => {
            state
                .pending_worktree_snapshots
                .insert(snapshot.worktree_id.clone(), snapshot);
        }
        Command::UpdateRestoreState {
            project_id,
            worktree_id,
            restore_state,
        } => {
            if let Err(error) = flush_pending_worktree_snapshot(conn, state, &worktree_id).await {
                tracing::warn!(
                    worktree_id,
                    "failed to flush pending worktree state before restore update: {error}"
                );
            }
            if let Err(error) =
                update_restore_state(conn, &project_id, &worktree_id, &restore_state).await
            {
                tracing::warn!(worktree_id, "failed to persist restore state: {error}");
            }
        }
        Command::UpdateTerminalLabels { labels } => {
            if let Err(error) =
                flush_pending_worktree_snapshot(conn, state, &labels.worktree_id).await
            {
                tracing::warn!(
                    worktree_id = labels.worktree_id,
                    "failed to flush pending worktree state before label update: {error}"
                );
            }
            if let Err(error) = update_terminal_labels(conn, &labels).await {
                tracing::warn!(
                    tab_id = labels.tab_id,
                    "failed to persist terminal labels: {error}"
                );
            }
        }
        Command::EnqueueTerminalFlush { flush } => {
            state.pending_terminal_flushes.push_back(flush);
        }
        Command::LoadTerminalRestorePayload {
            tab_id,
            replay_budget_bytes,
            reply,
        } => {
            let _ = flush_pending_worktree_snapshots(conn, state).await;
            let _ = flush_pending_terminal_batches(conn, state).await;
            let _ = reply.send(
                load_terminal_restore_payload(conn, &tab_id, replay_budget_bytes)
                    .await
                    .map_err(std::io::Error::other),
            );
        }
        Command::DeleteTabState {
            tab_id,
            worktree_id,
        } => {
            if let Err(error) = flush_pending_worktree_snapshot(conn, state, &worktree_id).await {
                tracing::warn!(
                    worktree_id,
                    "failed to flush pending worktree state before tab delete: {error}"
                );
            }
            state
                .pending_terminal_flushes
                .retain(|flush| flush.tab_id != tab_id);
            if let Err(error) = delete_tab_rows(conn, &[tab_id]).await {
                tracing::warn!("failed to delete tab rows: {error}");
            }
        }
        Command::DeleteWorktree {
            project_id,
            worktree_id,
        } => {
            if let Err(error) = flush_pending_worktree_snapshot(conn, state, &worktree_id).await {
                tracing::warn!(
                    worktree_id,
                    "failed to flush pending worktree state before worktree delete: {error}"
                );
            }
            state
                .pending_terminal_flushes
                .retain(|flush| flush.worktree_id != worktree_id);
            if let Err(error) = delete_worktree_rows(conn, &project_id, &worktree_id).await {
                tracing::warn!(worktree_id, "failed to delete worktree rows: {error}");
            }
        }
        Command::DeleteProject { project_id } => {
            if let Err(error) = flush_pending_project_snapshots(conn, state, &project_id).await {
                tracing::warn!(
                    project_id,
                    "failed to flush pending worktree state before project delete: {error}"
                );
            }
            state
                .pending_terminal_flushes
                .retain(|flush| flush.project_id != project_id);
            if let Err(error) = delete_project_rows(conn, &project_id).await {
                tracing::warn!(project_id, "failed to delete project rows: {error}");
            }
        }
        Command::Shutdown { .. } => unreachable!("shutdown handled in outer loop"),
    }
}

async fn flush_pending_terminal_batches(
    conn: &mut SqliteConnection,
    state: &mut WriterState,
) -> Result<(), sqlx::Error> {
    let pending = std::mem::take(&mut state.pending_terminal_flushes);
    for flush in pending {
        persist_terminal_flush(conn, &flush).await?;
    }
    Ok(())
}

async fn flush_pending_worktree_snapshots(
    conn: &mut SqliteConnection,
    state: &mut WriterState,
) -> Result<(), sqlx::Error> {
    let pending = std::mem::take(&mut state.pending_worktree_snapshots);
    for snapshot in pending.into_values() {
        replace_worktree_state(conn, &snapshot).await?;
    }
    Ok(())
}

async fn flush_pending_worktree_snapshot(
    conn: &mut SqliteConnection,
    state: &mut WriterState,
    worktree_id: &str,
) -> Result<(), sqlx::Error> {
    let Some(snapshot) = state.pending_worktree_snapshots.remove(worktree_id) else {
        return Ok(());
    };
    replace_worktree_state(conn, &snapshot).await
}

async fn flush_pending_project_snapshots(
    conn: &mut SqliteConnection,
    state: &mut WriterState,
    project_id: &str,
) -> Result<(), sqlx::Error> {
    let worktree_ids: Vec<String> = state
        .pending_worktree_snapshots
        .iter()
        .filter(|(_, snapshot)| snapshot.project_id == project_id)
        .map(|(worktree_id, _)| worktree_id.clone())
        .collect();

    for worktree_id in worktree_ids {
        flush_pending_worktree_snapshot(conn, state, &worktree_id).await?;
    }
    Ok(())
}

async fn cleanup_orphaned_tab_rows(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    let mut tx = conn.begin().await?;
    sqlx::query!(
        "
        DELETE FROM terminal_replay_chunks
        WHERE NOT EXISTS (
            SELECT 1 FROM tabs WHERE tabs.tab_id = terminal_replay_chunks.tab_id
        )
        "
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "
        DELETE FROM terminal_state
        WHERE NOT EXISTS (
            SELECT 1 FROM tabs WHERE tabs.tab_id = terminal_state.tab_id
        )
        "
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "
        DELETE FROM browser_history_entries
        WHERE NOT EXISTS (
            SELECT 1 FROM tabs WHERE tabs.tab_id = browser_history_entries.tab_id
        )
        "
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

fn serialize_json_column<T: Serialize>(value: &T) -> Option<String> {
    match serde_json::to_string(value) {
        Ok(json) if json != "[]" && json != "{}" => Some(json),
        Ok(_) => None,
        Err(_) => None,
    }
}

fn deserialize_vec_column(value: Option<String>) -> Vec<String> {
    value
        .as_deref()
        .and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or_default()
}

fn deserialize_map_column(value: Option<String>) -> HashMap<String, Vec<String>> {
    value
        .as_deref()
        .and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or_default()
}

async fn replace_worktree_state(
    conn: &mut SqliteConnection,
    snapshot: &WorktreeSnapshot,
) -> Result<(), sqlx::Error> {
    let now_ms = now_ms() as i64;
    let restore_state = normalize_restore_state_for_snapshot(
        snapshot.restore_state.clone(),
        &snapshot.tabs,
        snapshot.layout.as_ref(),
    );
    let layout_root_id = snapshot
        .layout
        .as_ref()
        .map(|layout| layout.root_id.clone());
    let next_terminal_number = i64::from(snapshot.next_terminal_number);
    let pane_mru_json = serialize_json_column(&restore_state.pane_mru);
    let tab_mru_by_pane_json = serialize_json_column(&restore_state.tab_mru_by_pane);
    let mut tx = conn.begin().await?;

    sqlx::query!(
        "
        INSERT INTO worktree_state (
            project_id,
            worktree_id,
            active_tab_id,
            focused_pane_id,
            pane_mru_json,
            tab_mru_by_pane_json,
            layout_root_id,
            next_terminal_number,
            updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(worktree_id) DO UPDATE SET
            project_id = excluded.project_id,
            active_tab_id = excluded.active_tab_id,
            focused_pane_id = excluded.focused_pane_id,
            pane_mru_json = excluded.pane_mru_json,
            tab_mru_by_pane_json = excluded.tab_mru_by_pane_json,
            layout_root_id = excluded.layout_root_id,
            next_terminal_number = excluded.next_terminal_number,
            updated_at_ms = excluded.updated_at_ms
        ",
        snapshot.project_id,
        snapshot.worktree_id,
        restore_state.active_tab_id,
        restore_state.focused_pane_id,
        pane_mru_json,
        tab_mru_by_pane_json,
        layout_root_id,
        next_terminal_number,
        now_ms,
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query!(
        "DELETE FROM layout_nodes WHERE worktree_id = ?1",
        snapshot.worktree_id
    )
    .execute(&mut *tx)
    .await?;

    if let Some(layout) = &snapshot.layout {
        for node in &layout.nodes {
            match node {
                WorktreePaneNode::Leaf { id, pane_id } => {
                    sqlx::query!(
                        "
                        INSERT INTO layout_nodes (
                            worktree_id, node_id, node_type, pane_id
                        ) VALUES (?1, ?2, 'leaf', ?3)
                        ",
                        snapshot.worktree_id,
                        id,
                        pane_id,
                    )
                    .execute(&mut *tx)
                    .await?;
                }
                WorktreePaneNode::Split {
                    id,
                    axis,
                    ratio,
                    first_id,
                    second_id,
                } => {
                    let axis = axis_to_string(*axis);
                    sqlx::query!(
                        "
                        INSERT INTO layout_nodes (
                            worktree_id,
                            node_id,
                            node_type,
                            axis,
                            ratio,
                            first_id,
                            second_id
                        ) VALUES (?1, ?2, 'split', ?3, ?4, ?5, ?6)
                        ",
                        snapshot.worktree_id,
                        id,
                        axis,
                        ratio,
                        first_id,
                        second_id,
                    )
                    .execute(&mut *tx)
                    .await?;
                }
            }
        }
    }

    sqlx::query!(
        "
        DELETE FROM browser_history_entries
        WHERE tab_id IN (
            SELECT tab_id FROM tabs WHERE worktree_id = ?1
        )
        ",
        snapshot.worktree_id,
    )
    .execute(&mut *tx)
    .await?;

    let current_tab_ids: Vec<String> = snapshot
        .tabs
        .iter()
        .map(|tab| tab.id().to_string())
        .collect();
    for tab in &snapshot.tabs {
        let (
            tab_type,
            path,
            scope,
            original_path,
            commit_id,
            url,
            conversation_id,
            custom_label,
            process_label,
            title_label,
        ) = match tab {
            TabInfo::Terminal { labels, .. } => (
                "terminal",
                None,
                None,
                None,
                None,
                None,
                None,
                labels.custom_label.as_deref(),
                labels.smart_label.as_deref(),
                None::<&str>,
            ),
            TabInfo::File { path, .. } => (
                "file",
                Some(path.as_str()),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            ),
            TabInfo::GitDiff {
                path,
                scope,
                original_path,
                commit_id,
                ..
            } => (
                "git_diff",
                Some(path.as_str()),
                Some(git_diff_scope_to_string(*scope)),
                original_path.as_deref(),
                commit_id.as_deref(),
                None,
                None,
                None,
                None,
                None,
            ),
            TabInfo::Browser { url, .. } => (
                "browser",
                None,
                None,
                None,
                None,
                Some(url.as_str()),
                None,
                None,
                None,
                None,
            ),
            TabInfo::AgentChat {
                conversation_id, ..
            } => (
                "agent_chat",
                None,
                None,
                None,
                None,
                None,
                Some(conversation_id.as_str()),
                None,
                None,
                None,
            ),
        };
        let tab_id = tab.id().to_string();
        let session_id = tab.session_id().to_string();
        let pane_id = tab.pane_id().to_string();
        let label = tab.label().to_string();
        let position = tab.position();
        let created_at_ms = tab.created_at() as i64;
        let preview = tab.preview();
        let history_index = tab.history_index().map(|index| index as i64);

        sqlx::query(
            "
            INSERT INTO tabs (
                tab_id,
                project_id,
                worktree_id,
                session_id,
                tab_type,
                pane_id,
                label,
                position,
                created_at_ms,
                preview,
                custom_label,
                process_label,
                title_label,
                path,
                scope,
                original_path,
                commit_id,
                url,
                browser_history_index,
                conversation_id
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18, ?19, ?20
            )
            ON CONFLICT(tab_id) DO UPDATE SET
                project_id = excluded.project_id,
                worktree_id = excluded.worktree_id,
                session_id = excluded.session_id,
                tab_type = excluded.tab_type,
                pane_id = excluded.pane_id,
                label = excluded.label,
                position = excluded.position,
                created_at_ms = excluded.created_at_ms,
                preview = excluded.preview,
                custom_label = excluded.custom_label,
                process_label = excluded.process_label,
                title_label = excluded.title_label,
                path = excluded.path,
                scope = excluded.scope,
                original_path = excluded.original_path,
                commit_id = excluded.commit_id,
                url = excluded.url,
                browser_history_index = excluded.browser_history_index,
                conversation_id = excluded.conversation_id
            ",
        )
        .bind(tab_id)
        .bind(&snapshot.project_id)
        .bind(&snapshot.worktree_id)
        .bind(session_id)
        .bind(tab_type)
        .bind(pane_id)
        .bind(label)
        .bind(position)
        .bind(created_at_ms)
        .bind(preview)
        .bind(custom_label)
        .bind(process_label)
        .bind(title_label)
        .bind(path)
        .bind(scope)
        .bind(original_path)
        .bind(commit_id)
        .bind(url)
        .bind(history_index)
        .bind(conversation_id)
        .execute(&mut *tx)
        .await?;

        if let TabInfo::Browser { id, history, .. } = tab {
            for (index, entry) in history.iter().enumerate() {
                let history_index = index as i64;
                sqlx::query!(
                    "
                    INSERT INTO browser_history_entries (tab_id, history_index, url)
                    VALUES (?1, ?2, ?3)
                    ",
                    id,
                    history_index,
                    entry,
                )
                .execute(&mut *tx)
                .await?;
            }
        }
    }

    delete_missing_worktree_rows(&mut tx, snapshot, &current_tab_ids).await?;
    tx.commit().await?;
    Ok(())
}

async fn delete_missing_worktree_rows(
    tx: &mut Transaction<'_, Sqlite>,
    snapshot: &WorktreeSnapshot,
    current_tab_ids: &[String],
) -> Result<(), sqlx::Error> {
    if current_tab_ids.is_empty() {
        delete_all_worktree_tab_rows(tx, &snapshot.worktree_id).await?;
        return Ok(());
    }

    delete_missing_tab_owned_rows(tx, &snapshot.worktree_id, current_tab_ids).await?;
    Ok(())
}

async fn update_restore_state(
    conn: &mut SqliteConnection,
    project_id: &str,
    worktree_id: &str,
    restore_state: &WorktreeRestoreState,
) -> Result<(), sqlx::Error> {
    let updated_at_ms = now_ms() as i64;
    let pane_mru_json = serialize_json_column(&restore_state.pane_mru);
    let tab_mru_by_pane_json = serialize_json_column(&restore_state.tab_mru_by_pane);
    sqlx::query!(
        "
        INSERT INTO worktree_state (
            project_id,
            worktree_id,
            active_tab_id,
            focused_pane_id,
            pane_mru_json,
            tab_mru_by_pane_json,
            layout_root_id,
            next_terminal_number,
            updated_at_ms
        )
        VALUES (
            ?1,
            ?2,
            ?3,
            ?4,
            ?5,
            ?6,
            (SELECT layout_root_id FROM worktree_state WHERE worktree_id = ?2),
            COALESCE((SELECT next_terminal_number FROM worktree_state WHERE worktree_id = ?2), 0),
            ?7
        )
        ON CONFLICT(worktree_id) DO UPDATE SET
            project_id = excluded.project_id,
            active_tab_id = excluded.active_tab_id,
            focused_pane_id = excluded.focused_pane_id,
            pane_mru_json = excluded.pane_mru_json,
            tab_mru_by_pane_json = excluded.tab_mru_by_pane_json,
            updated_at_ms = excluded.updated_at_ms
        ",
        project_id,
        worktree_id,
        restore_state.active_tab_id,
        restore_state.focused_pane_id,
        pane_mru_json,
        tab_mru_by_pane_json,
        updated_at_ms,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn update_terminal_labels(
    conn: &mut SqliteConnection,
    labels: &TerminalLabelsSnapshot,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "
        UPDATE tabs
        SET
            project_id = ?2,
            worktree_id = ?3,
            custom_label = ?4,
            process_label = ?5
        WHERE tab_id = ?1
        ",
        labels.tab_id,
        labels.project_id,
        labels.worktree_id,
        labels.custom_label,
        labels.process_label,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn upsert_terminal_state_metadata_tx(
    tx: &mut Transaction<'_, Sqlite>,
    flush: &TerminalFlush,
    size: TerminalSize,
    replay_total_bytes: u64,
    source_bytes_end: u64,
    replay_epoch: u64,
) -> Result<(), sqlx::Error> {
    let last_size_cols = i64::from(size.cols);
    let last_size_rows = i64::from(size.rows);
    let replay_total_bytes = replay_total_bytes as i64;
    let source_bytes_end = source_bytes_end as i64;
    let replay_epoch = replay_epoch as i64;
    let last_flush_at_ms = flush.flushed_at_ms as i64;
    let updated_at_ms = now_ms() as i64;
    sqlx::query!(
        "
        INSERT INTO terminal_state (
            tab_id,
            project_id,
            worktree_id,
            last_size_cols,
            last_size_rows,
            replay_total_bytes,
            source_bytes_end,
            replay_epoch,
            last_flush_at_ms,
            updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(tab_id) DO UPDATE SET
            project_id = excluded.project_id,
            worktree_id = excluded.worktree_id,
            last_size_cols = excluded.last_size_cols,
            last_size_rows = excluded.last_size_rows,
            replay_total_bytes = excluded.replay_total_bytes,
            source_bytes_end = excluded.source_bytes_end,
            replay_epoch = excluded.replay_epoch,
            last_flush_at_ms = excluded.last_flush_at_ms,
            updated_at_ms = excluded.updated_at_ms
        ",
        flush.tab_id,
        flush.project_id,
        flush.worktree_id,
        last_size_cols,
        last_size_rows,
        replay_total_bytes,
        source_bytes_end,
        replay_epoch,
        last_flush_at_ms,
        updated_at_ms,
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn append_replay_bytes_tx(
    tx: &mut Transaction<'_, Sqlite>,
    tab_id: &str,
    start_offset: u64,
    data: &[u8],
    created_at_ms: i64,
) -> Result<(), sqlx::Error> {
    if data.is_empty() {
        return Ok(());
    }

    let mut offset = start_offset;
    let mut remaining = data;
    let tail = sqlx::query!(
        "
        SELECT replay_start_offset, length(data) AS \"byte_len!: i64\"
        FROM terminal_replay_chunks
        WHERE tab_id = ?1
        ORDER BY replay_start_offset DESC
        LIMIT 1
        ",
        tab_id,
    )
    .fetch_optional(&mut **tx)
    .await?;

    if let Some(tail) = tail {
        let tail_start = tail.replay_start_offset.max(0) as u64;
        let tail_len = tail.byte_len.max(0) as usize;
        let tail_end = tail_start.saturating_add(tail_len as u64);
        if tail_end == start_offset && tail_len < TERMINAL_REPLAY_CHUNK_SIZE {
            let append_len = remaining
                .len()
                .min(TERMINAL_REPLAY_CHUNK_SIZE.saturating_sub(tail_len));
            let append_bytes = &remaining[..append_len];
            sqlx::query!(
                "
                UPDATE terminal_replay_chunks
                SET data = data || ?3
                WHERE tab_id = ?1 AND replay_start_offset = ?2
                ",
                tab_id,
                tail.replay_start_offset,
                append_bytes,
            )
            .execute(&mut **tx)
            .await?;
            offset = offset.saturating_add(append_len as u64);
            remaining = &remaining[append_len..];
        }
    }

    while !remaining.is_empty() {
        let chunk_len = remaining.len().min(TERMINAL_REPLAY_CHUNK_SIZE);
        let chunk_offset = offset as i64;
        let chunk_bytes = &remaining[..chunk_len];
        sqlx::query!(
            "
            INSERT INTO terminal_replay_chunks (
                tab_id,
                replay_start_offset,
                data,
                created_at_ms
            ) VALUES (?1, ?2, ?3, ?4)
            ",
            tab_id,
            chunk_offset,
            chunk_bytes,
            created_at_ms,
        )
        .execute(&mut **tx)
        .await?;
        offset = offset.saturating_add(chunk_len as u64);
        remaining = &remaining[chunk_len..];
    }

    Ok(())
}

async fn replace_replay_history_tx(
    tx: &mut Transaction<'_, Sqlite>,
    tab_id: &str,
    replay_history: &[u8],
    created_at_ms: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "DELETE FROM terminal_replay_chunks WHERE tab_id = ?1",
        tab_id,
    )
    .execute(&mut **tx)
    .await?;
    append_replay_bytes_tx(tx, tab_id, 0, replay_history, created_at_ms).await
}

async fn prune_replay_chunks_tx(
    tx: &mut Transaction<'_, Sqlite>,
    tab_id: &str,
    replay_total_bytes: u64,
    replay_budget_bytes: usize,
) -> Result<(), sqlx::Error> {
    let retained_from = replay_total_bytes.saturating_sub(replay_budget_bytes as u64);
    if retained_from == 0 {
        return Ok(());
    }

    let rows = sqlx::query!(
        "
        SELECT replay_start_offset, length(data) AS \"byte_len!: i64\"
        FROM terminal_replay_chunks
        WHERE tab_id = ?1
        ORDER BY replay_start_offset
        ",
        tab_id,
    )
    .fetch_all(&mut **tx)
    .await?;

    for row in rows {
        let start = row.replay_start_offset.max(0) as u64;
        let end = start.saturating_add(row.byte_len.max(0) as u64);
        if end <= retained_from {
            sqlx::query!(
                "
                DELETE FROM terminal_replay_chunks
                WHERE tab_id = ?1 AND replay_start_offset = ?2
                ",
                tab_id,
                row.replay_start_offset,
            )
            .execute(&mut **tx)
            .await?;
        } else {
            break;
        }
    }

    Ok(())
}

async fn persist_terminal_flush(
    conn: &mut SqliteConnection,
    flush: &TerminalFlush,
) -> Result<(), sqlx::Error> {
    let mut tx = conn.begin().await?;
    let created_at_ms = now_ms() as i64;
    match &flush.metadata.kind {
        TerminalPersistedStateKind::Append {
            size,
            replay_budget_bytes,
            replay_epoch,
            source_bytes_end,
            replay_total_bytes,
            replay_append,
        } => {
            let replay_start_offset = replay_total_bytes.saturating_sub(replay_append.len() as u64);
            append_replay_bytes_tx(
                &mut tx,
                &flush.tab_id,
                replay_start_offset,
                replay_append,
                created_at_ms,
            )
            .await?;
            prune_replay_chunks_tx(
                &mut tx,
                &flush.tab_id,
                *replay_total_bytes,
                *replay_budget_bytes,
            )
            .await?;
            upsert_terminal_state_metadata_tx(
                &mut tx,
                flush,
                *size,
                *replay_total_bytes,
                *source_bytes_end,
                *replay_epoch,
            )
            .await?;
        }
        TerminalPersistedStateKind::Rebuild {
            size,
            replay_budget_bytes,
            replay_epoch,
            source_bytes_end,
            replay_total_bytes,
            replay_history,
        } => {
            replace_replay_history_tx(&mut tx, &flush.tab_id, replay_history, created_at_ms)
                .await?;
            prune_replay_chunks_tx(
                &mut tx,
                &flush.tab_id,
                *replay_total_bytes,
                *replay_budget_bytes,
            )
            .await?;
            upsert_terminal_state_metadata_tx(
                &mut tx,
                flush,
                *size,
                *replay_total_bytes,
                *source_bytes_end,
                *replay_epoch,
            )
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

async fn load_existing_worktrees(
    conn: &mut SqliteConnection,
    existing_worktrees: Vec<ExistingWorktree>,
) -> Result<LoadedStateSnapshot, sqlx::Error> {
    let existing_by_worktree: HashMap<String, String> = existing_worktrees
        .into_iter()
        .map(|worktree| (worktree.worktree_id, worktree.project_id))
        .collect();

    let worktree_rows = sqlx::query!(
        "
        SELECT
            project_id as \"project_id!\",
            worktree_id as \"worktree_id!\",
            active_tab_id,
            focused_pane_id,
            pane_mru_json,
            tab_mru_by_pane_json,
            layout_root_id,
            next_terminal_number as \"next_terminal_number!\"
        FROM worktree_state
        "
    )
    .fetch_all(&mut *conn)
    .await?;

    let mut worktrees_by_id = HashMap::<String, LoadedWorktreeState>::new();
    for row in worktree_rows {
        if !existing_by_worktree.contains_key(&row.worktree_id) {
            continue;
        }
        worktrees_by_id.insert(
            row.worktree_id.clone(),
            LoadedWorktreeState {
                project_id: row.project_id,
                worktree_id: row.worktree_id.clone(),
                layout: row.layout_root_id.map(|root_id| WorktreeTabLayout {
                    root_id,
                    nodes: Vec::new(),
                }),
                tabs: Vec::new(),
                restore_state: WorktreeRestoreState {
                    active_tab_id: row.active_tab_id,
                    focused_pane_id: row.focused_pane_id,
                    pane_mru: deserialize_vec_column(row.pane_mru_json),
                    tab_mru_by_pane: deserialize_map_column(row.tab_mru_by_pane_json),
                },
                next_terminal_number: row.next_terminal_number.max(0) as u32,
            },
        );
    }

    let layout_rows = sqlx::query!(
        "
        SELECT
            worktree_id as \"worktree_id!\",
            node_id as \"node_id!\",
            node_type as \"node_type!\",
            pane_id,
            axis,
            ratio,
            first_id,
            second_id
        FROM layout_nodes
        ORDER BY worktree_id, node_id
        "
    )
    .fetch_all(&mut *conn)
    .await?;
    for row in layout_rows {
        let Some(worktree) = worktrees_by_id.get_mut(&row.worktree_id) else {
            continue;
        };
        let Some(layout) = worktree.layout.as_mut() else {
            continue;
        };
        match row.node_type.as_str() {
            "leaf" => {
                if let Some(pane_id) = row.pane_id {
                    layout.nodes.push(WorktreePaneNode::Leaf {
                        id: row.node_id,
                        pane_id,
                    });
                }
            }
            "split" => {
                if let (Some(axis), Some(ratio), Some(first_id), Some(second_id)) =
                    (row.axis, row.ratio, row.first_id, row.second_id)
                {
                    layout.nodes.push(WorktreePaneNode::Split {
                        id: row.node_id,
                        axis: if axis == "vertical" {
                            crate::tab::TabPaneSplitAxis::Vertical
                        } else {
                            crate::tab::TabPaneSplitAxis::Horizontal
                        },
                        ratio,
                        first_id,
                        second_id,
                    });
                }
            }
            _ => {}
        }
    }

    let browser_histories = load_browser_histories(conn).await?;
    let tab_rows = sqlx::query(
        "
        SELECT
            tab_id,
            project_id,
            worktree_id,
            session_id,
            tab_type,
            pane_id,
            label,
            position,
            created_at_ms,
            preview,
            custom_label,
            process_label,
            title_label,
            path,
            scope,
            original_path,
            commit_id,
            url,
            browser_history_index,
            conversation_id
        FROM tabs
        ORDER BY worktree_id, pane_id, position, created_at_ms, tab_id
        ",
    )
    .fetch_all(&mut *conn)
    .await?;

    for row in tab_rows {
        let worktree_id: String = row.try_get("worktree_id")?;
        let Some(worktree) = worktrees_by_id.get_mut(&worktree_id) else {
            continue;
        };
        let project_id: String = row.try_get("project_id")?;
        worktree.project_id = project_id;
        let session_id: String = row.try_get("session_id")?;
        let tab_type: String = row.try_get("tab_type")?;
        let pane_id: String = row.try_get("pane_id")?;
        let label: String = row.try_get("label")?;
        let position: f64 = row.try_get("position")?;
        let created_at_ms: i64 = row.try_get("created_at_ms")?;
        let created_at = created_at_ms.max(0) as u64;
        let preview = row.try_get::<i64, _>("preview")? != 0;
        let path = row.try_get::<Option<String>, _>("path")?;
        let scope = row.try_get::<Option<String>, _>("scope")?;
        let original_path = row.try_get::<Option<String>, _>("original_path")?;
        let commit_id = row.try_get::<Option<String>, _>("commit_id")?;
        let url = row.try_get::<Option<String>, _>("url")?;
        let browser_history_index = row.try_get::<Option<i64>, _>("browser_history_index")?;
        let custom_label = row.try_get::<Option<String>, _>("custom_label")?;
        let process_label = row.try_get::<Option<String>, _>("process_label")?;
        let conversation_id = row.try_get::<Option<String>, _>("conversation_id")?;
        let tab_id: String = row.try_get("tab_id")?;

        let tab = match tab_type.as_str() {
            "terminal" => TabInfo::Terminal {
                id: tab_id,
                session_id,
                worktree_id,
                pane_id,
                label,
                position,
                created_at,
                preview,
                has_notification: false,
                labels: TerminalTabLabels {
                    custom_label,
                    smart_label: process_label,
                    title_label: None,
                },
            },
            "file" => TabInfo::File {
                id: tab_id,
                session_id,
                worktree_id,
                pane_id,
                label,
                position,
                created_at,
                preview,
                path: path.unwrap_or_default(),
            },
            "git_diff" => TabInfo::GitDiff {
                id: tab_id,
                session_id,
                worktree_id,
                pane_id,
                label,
                position,
                created_at,
                preview,
                path: path.unwrap_or_default(),
                scope: match scope.as_deref() {
                    Some("staged") => crate::tab::GitDiffScope::Staged,
                    Some("commit") => crate::tab::GitDiffScope::Commit,
                    _ => crate::tab::GitDiffScope::Unstaged,
                },
                original_path,
                commit_id,
            },
            "browser" => {
                let history = browser_histories.get(&tab_id).cloned().unwrap_or_default();
                let history_index = browser_history_index.unwrap_or_default().max(0) as usize;
                let clamped_history_index = history_index.min(history.len().saturating_sub(1));
                TabInfo::Browser {
                    id: tab_id,
                    session_id,
                    worktree_id,
                    pane_id,
                    label,
                    position,
                    created_at,
                    preview,
                    url: url.unwrap_or_else(|| "about:blank".to_string()),
                    history,
                    history_index: clamped_history_index,
                }
            }
            "agent_chat" => {
                let Some(conversation_id) =
                    conversation_id.filter(|conversation_id| !conversation_id.is_empty())
                else {
                    tracing::warn!(
                        tab_id,
                        "skipping restored agent chat tab without a conversation id"
                    );
                    continue;
                };
                TabInfo::AgentChat {
                    id: tab_id,
                    session_id,
                    worktree_id,
                    pane_id,
                    label,
                    position,
                    created_at,
                    preview,
                    conversation_id,
                }
            }
            _ => continue,
        };
        worktree.tabs.push(tab);
    }

    Ok(LoadedStateSnapshot {
        worktrees: worktrees_by_id.into_values().collect(),
    })
}

async fn load_browser_histories(
    conn: &mut SqliteConnection,
) -> Result<HashMap<String, Vec<String>>, sqlx::Error> {
    let rows = sqlx::query!(
        "
        SELECT
            tab_id as \"tab_id!\",
            history_index as \"history_index!\",
            url as \"url!\"
        FROM browser_history_entries
        ORDER BY tab_id, history_index
        "
    )
    .fetch_all(&mut *conn)
    .await?;

    let mut histories = HashMap::<String, Vec<String>>::new();
    for row in rows {
        let history = histories.entry(row.tab_id).or_default();
        let index = row.history_index.max(0) as usize;
        if history.len() <= index {
            history.resize(index + 1, String::new());
        }
        history[index] = row.url;
    }
    for history in histories.values_mut() {
        history.retain(|entry| !entry.is_empty());
    }
    Ok(histories)
}

async fn load_terminal_restore_payload(
    conn: &mut SqliteConnection,
    tab_id: &str,
    replay_budget_bytes: usize,
) -> Result<TerminalRestorePayload, sqlx::Error> {
    let row = sqlx::query!(
        "
        SELECT last_size_cols, last_size_rows, replay_total_bytes
        FROM terminal_state
        WHERE tab_id = ?1
        ",
        tab_id,
    )
    .fetch_optional(&mut *conn)
    .await?;

    let (cols, rows, replay_total_bytes) = row
        .map(|row| {
            (
                row.last_size_cols,
                row.last_size_rows,
                row.replay_total_bytes.max(0) as u64,
            )
        })
        .unwrap_or((
            i64::from(TerminalSize::default_pty().cols),
            i64::from(TerminalSize::default_pty().rows),
            0,
        ));

    let chunk_rows = sqlx::query!(
        "
        SELECT replay_start_offset, data
        FROM terminal_replay_chunks
        WHERE tab_id = ?1
        ORDER BY replay_start_offset
        ",
        tab_id,
    )
    .fetch_all(&mut *conn)
    .await?;

    let retained_from = replay_total_bytes.saturating_sub(replay_budget_bytes as u64);
    let mut history =
        Vec::with_capacity(replay_total_bytes.min(replay_budget_bytes as u64) as usize);
    for row in chunk_rows {
        let start = row.replay_start_offset.max(0) as u64;
        let data = row.data;
        let end = start.saturating_add(data.len() as u64);
        if end <= retained_from {
            continue;
        }

        let skip = retained_from.saturating_sub(start) as usize;
        history.extend_from_slice(&data[skip.min(data.len())..]);
    }

    Ok(TerminalRestorePayload {
        size: TerminalSize::new(cols.max(0) as u16, rows.max(0) as u16).clamped(),
        history,
    })
}

async fn delete_worktree_rows(
    conn: &mut SqliteConnection,
    project_id: &str,
    worktree_id: &str,
) -> Result<(), sqlx::Error> {
    let mut tx = conn.begin().await?;
    sqlx::query!(
        "
        DELETE FROM terminal_replay_chunks
        WHERE tab_id IN (
            SELECT tab_id FROM terminal_state
            WHERE project_id = ?1 AND worktree_id = ?2
        )
        ",
        project_id,
        worktree_id,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "DELETE FROM terminal_state WHERE project_id = ?1 AND worktree_id = ?2",
        project_id,
        worktree_id,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "DELETE FROM browser_history_entries WHERE tab_id IN (SELECT tab_id FROM tabs WHERE project_id = ?1 AND worktree_id = ?2)",
        project_id,
        worktree_id,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "
        UPDATE chat_conversations
        SET open_tab_id = NULL
        WHERE open_tab_id IN (
            SELECT tab_id FROM tabs
            WHERE project_id = ?1 AND worktree_id = ?2
        )
        ",
    )
    .bind(project_id)
    .bind(worktree_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "DELETE FROM tabs WHERE project_id = ?1 AND worktree_id = ?2",
        project_id,
        worktree_id,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "DELETE FROM layout_nodes WHERE worktree_id = ?1",
        worktree_id,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "DELETE FROM worktree_state WHERE project_id = ?1 AND worktree_id = ?2",
        project_id,
        worktree_id,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn delete_project_rows(
    conn: &mut SqliteConnection,
    project_id: &str,
) -> Result<(), sqlx::Error> {
    let mut tx = conn.begin().await?;
    sqlx::query!(
        "
        DELETE FROM terminal_replay_chunks
        WHERE tab_id IN (
            SELECT tab_id FROM terminal_state WHERE project_id = ?1
        )
        ",
        project_id,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "DELETE FROM terminal_state WHERE project_id = ?1",
        project_id,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "DELETE FROM browser_history_entries WHERE tab_id IN (SELECT tab_id FROM tabs WHERE project_id = ?1)",
        project_id,
    )
    .execute(&mut *tx)
    .await?;
    delete_project_chat_rows(&mut tx, project_id).await?;
    sqlx::query!("DELETE FROM tabs WHERE project_id = ?1", project_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query!(
        "DELETE FROM layout_nodes WHERE worktree_id IN (SELECT worktree_id FROM worktree_state WHERE project_id = ?1)",
        project_id,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "DELETE FROM worktree_state WHERE project_id = ?1",
        project_id,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn delete_project_chat_rows(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    project_id: &str,
) -> Result<(), sqlx::Error> {
    for table in [
        "chat_item_outputs",
        "chat_reconciliations",
        "chat_context_usage",
        "chat_diff_summaries",
        "chat_plans",
        "chat_pending_requests",
        "chat_items",
        "chat_turns",
        "chat_runs",
        "chat_messages",
    ] {
        let sql = format!(
            "DELETE FROM {table}
             WHERE conversation_id IN (
                 SELECT id FROM chat_conversations WHERE project_id = ?
             )"
        );
        sqlx::query(&sql)
            .bind(project_id)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query("DELETE FROM chat_conversations WHERE project_id = ?")
        .bind(project_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn checkpoint_database(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    sqlx::query("PRAGMA wal_checkpoint(PASSIVE);")
        .fetch_all(&mut *conn)
        .await?;
    Ok(())
}

async fn delete_tab_rows(
    conn: &mut SqliteConnection,
    tab_ids: &[String],
) -> Result<(), sqlx::Error> {
    if tab_ids.is_empty() {
        return Ok(());
    }

    let mut tx = conn.begin().await?;
    delete_tab_rows_tx(&mut tx, tab_ids).await?;
    tx.commit().await?;
    Ok(())
}

async fn delete_tab_rows_tx(
    tx: &mut Transaction<'_, Sqlite>,
    tab_ids: &[String],
) -> Result<(), sqlx::Error> {
    if tab_ids.is_empty() {
        return Ok(());
    }

    let mut replay_chunks_query =
        QueryBuilder::<Sqlite>::new("DELETE FROM terminal_replay_chunks WHERE tab_id IN (");
    let mut separated = replay_chunks_query.separated(", ");
    for tab_id in tab_ids {
        separated.push_bind(tab_id);
    }
    separated.push_unseparated(")");
    replay_chunks_query.build().execute(&mut **tx).await?;

    let mut terminal_state_query =
        QueryBuilder::<Sqlite>::new("DELETE FROM terminal_state WHERE tab_id IN (");
    let mut separated = terminal_state_query.separated(", ");
    for tab_id in tab_ids {
        separated.push_bind(tab_id);
    }
    separated.push_unseparated(")");
    terminal_state_query.build().execute(&mut **tx).await?;

    let mut history_query =
        QueryBuilder::<Sqlite>::new("DELETE FROM browser_history_entries WHERE tab_id IN (");
    let mut separated = history_query.separated(", ");
    for tab_id in tab_ids {
        separated.push_bind(tab_id);
    }
    separated.push_unseparated(")");
    history_query.build().execute(&mut **tx).await?;

    let mut tabs_query = QueryBuilder::<Sqlite>::new("DELETE FROM tabs WHERE tab_id IN (");
    let mut separated = tabs_query.separated(", ");
    for tab_id in tab_ids {
        separated.push_bind(tab_id);
    }
    separated.push_unseparated(")");
    tabs_query.build().execute(&mut **tx).await?;
    Ok(())
}

async fn delete_all_worktree_tab_rows(
    tx: &mut Transaction<'_, Sqlite>,
    worktree_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "
        DELETE FROM terminal_replay_chunks
        WHERE tab_id IN (
            SELECT tab_id FROM terminal_state WHERE worktree_id = ?1
        )
        ",
        worktree_id
    )
    .execute(&mut **tx)
    .await?;
    sqlx::query!(
        "DELETE FROM terminal_state WHERE worktree_id = ?1",
        worktree_id
    )
    .execute(&mut **tx)
    .await?;
    sqlx::query!(
        "
        DELETE FROM browser_history_entries
        WHERE tab_id IN (SELECT tab_id FROM tabs WHERE worktree_id = ?1)
        ",
        worktree_id
    )
    .execute(&mut **tx)
    .await?;
    sqlx::query!("DELETE FROM tabs WHERE worktree_id = ?1", worktree_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn delete_missing_tab_owned_rows(
    tx: &mut Transaction<'_, Sqlite>,
    worktree_id: &str,
    current_tab_ids: &[String],
) -> Result<(), sqlx::Error> {
    let mut replay_chunks_query = QueryBuilder::<Sqlite>::new(
        "DELETE FROM terminal_replay_chunks WHERE tab_id IN (SELECT tab_id FROM terminal_state WHERE worktree_id = ",
    );
    replay_chunks_query.push_bind(worktree_id.to_string());
    replay_chunks_query.push(" AND tab_id NOT IN (");
    let mut separated = replay_chunks_query.separated(", ");
    for id in current_tab_ids {
        separated.push_bind(id.clone());
    }
    separated.push_unseparated("))");
    replay_chunks_query.build().execute(&mut **tx).await?;

    let mut terminal_state_query =
        QueryBuilder::<Sqlite>::new("DELETE FROM terminal_state WHERE worktree_id = ");
    terminal_state_query.push_bind(worktree_id.to_string());
    terminal_state_query.push(" AND tab_id NOT IN (");
    let mut separated = terminal_state_query.separated(", ");
    for id in current_tab_ids {
        separated.push_bind(id.clone());
    }
    separated.push_unseparated(")");
    terminal_state_query.build().execute(&mut **tx).await?;

    let mut history_query = QueryBuilder::<Sqlite>::new(
        "DELETE FROM browser_history_entries WHERE tab_id IN (SELECT tab_id FROM tabs WHERE worktree_id = ",
    );
    history_query.push_bind(worktree_id.to_string());
    history_query.push(" AND tab_id NOT IN (");
    let mut separated = history_query.separated(", ");
    for id in current_tab_ids {
        separated.push_bind(id.clone());
    }
    separated.push_unseparated(")");
    history_query.push(")");
    history_query.build().execute(&mut **tx).await?;

    let mut tabs_query = QueryBuilder::<Sqlite>::new("DELETE FROM tabs WHERE worktree_id = ");
    tabs_query.push_bind(worktree_id.to_string());
    tabs_query.push(" AND tab_id NOT IN (");
    let mut separated = tabs_query.separated(", ");
    for id in current_tab_ids {
        separated.push_bind(id.clone());
    }
    separated.push_unseparated(")");
    tabs_query.build().execute(&mut **tx).await?;
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;
    use crate::tab::GitDiffScope;

    fn terminal_rebuild_state(
        size: TerminalSize,
        source_bytes_end: u64,
        replay_history: Vec<u8>,
    ) -> TerminalPersistedState {
        TerminalPersistedState {
            kind: TerminalPersistedStateKind::Rebuild {
                size,
                replay_budget_bytes: crate::pty::live_tab::DEFAULT_SCROLLBACK,
                replay_epoch: 0,
                source_bytes_end,
                replay_total_bytes: replay_history.len() as u64,
                replay_history,
            },
        }
    }

    fn make_snapshot() -> WorktreeSnapshot {
        WorktreeSnapshot {
            project_id: "project-1".to_string(),
            worktree_id: "worktree-1".to_string(),
            layout: Some(WorktreeTabLayout {
                root_id: "root".to_string(),
                nodes: vec![WorktreePaneNode::Leaf {
                    id: "root".to_string(),
                    pane_id: "pane-1".to_string(),
                }],
            }),
            tabs: vec![
                TabInfo::Terminal {
                    id: "terminal-1".to_string(),
                    session_id: "default".to_string(),
                    worktree_id: "worktree-1".to_string(),
                    pane_id: "pane-1".to_string(),
                    label: "Terminal 1".to_string(),
                    position: 1.0,
                    created_at: 1,
                    preview: false,
                    has_notification: true,
                    labels: TerminalTabLabels {
                        custom_label: Some("dev".to_string()),
                        smart_label: Some("bash".to_string()),
                        title_label: Some("shell".to_string()),
                    },
                },
                TabInfo::Browser {
                    id: "browser-1".to_string(),
                    session_id: "default".to_string(),
                    worktree_id: "worktree-1".to_string(),
                    pane_id: "pane-1".to_string(),
                    label: "example.com".to_string(),
                    position: 2.0,
                    created_at: 2,
                    preview: false,
                    url: "https://example.com".to_string(),
                    history: vec![
                        "https://example.com".to_string(),
                        "https://example.com/docs".to_string(),
                    ],
                    history_index: 1,
                },
                TabInfo::GitDiff {
                    id: "diff-1".to_string(),
                    session_id: "default".to_string(),
                    worktree_id: "worktree-1".to_string(),
                    pane_id: "pane-1".to_string(),
                    label: "README.md".to_string(),
                    position: 3.0,
                    created_at: 3,
                    preview: true,
                    path: "README.md".to_string(),
                    scope: GitDiffScope::Commit,
                    original_path: None,
                    commit_id: Some("deadbeef".to_string()),
                },
            ],
            restore_state: WorktreeRestoreState {
                active_tab_id: Some("terminal-1".to_string()),
                focused_pane_id: Some("pane-1".to_string()),
                pane_mru: vec!["pane-1".to_string()],
                tab_mru_by_pane: HashMap::from([(
                    "pane-1".to_string(),
                    vec![
                        "terminal-1".to_string(),
                        "browser-1".to_string(),
                        "diff-1".to_string(),
                    ],
                )]),
            },
            next_terminal_number: 4,
        }
    }

    #[tokio::test]
    async fn replace_and_load_round_trip() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.sqlite3");
        let mut conn = open_connection(&path).await.unwrap();
        let snapshot = make_snapshot();
        replace_worktree_state(&mut conn, &snapshot).await.unwrap();

        let loaded = load_existing_worktrees(
            &mut conn,
            vec![ExistingWorktree {
                project_id: "project-1".to_string(),
                worktree_id: "worktree-1".to_string(),
            }],
        )
        .await
        .unwrap();

        assert_eq!(loaded.worktrees.len(), 1);
        let worktree = &loaded.worktrees[0];
        assert_eq!(worktree.next_terminal_number, 4);
        assert_eq!(
            worktree.restore_state.active_tab_id.as_deref(),
            Some("terminal-1")
        );
        assert_eq!(worktree.restore_state.pane_mru, vec!["pane-1".to_string()]);
        assert_eq!(
            worktree.restore_state.tab_mru_by_pane.get("pane-1"),
            Some(&vec![
                "terminal-1".to_string(),
                "browser-1".to_string(),
                "diff-1".to_string(),
            ])
        );
        assert_eq!(worktree.tabs.len(), 3);
        let terminal = worktree
            .tabs
            .iter()
            .find(|tab| tab.id() == "terminal-1")
            .unwrap();
        assert_eq!(terminal.custom_label(), Some("dev"));
        assert_eq!(terminal.smart_label(), Some("bash"));
        assert_eq!(terminal.title_label(), None);

        let migration_count = sqlx::query_scalar!("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(migration_count, 12);
    }

    #[tokio::test]
    async fn fresh_db_bootstrap_runs_sqlx_migrations() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.sqlite3");
        let mut conn = open_connection(&path).await.unwrap();

        let migration_count = sqlx::query_scalar!("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(migration_count, 12);
    }

    #[tokio::test]
    async fn existing_sqlx_db_reopens_cleanly() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.sqlite3");
        let mut conn = open_connection(&path).await.unwrap();
        replace_worktree_state(&mut conn, &make_snapshot())
            .await
            .unwrap();
        drop(conn);

        let mut reopened = open_connection(&path).await.unwrap();
        let count = sqlx::query_scalar!("SELECT COUNT(*) FROM tabs")
            .fetch_one(&mut reopened)
            .await
            .unwrap();
        assert_eq!(count, 3);
    }

    #[tokio::test]
    async fn existing_unrecognized_db_fails_to_open() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.sqlite3");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE legacy_state (id TEXT PRIMARY KEY)")
            .execute(&mut conn)
            .await
            .unwrap();
        drop(conn);

        let error = open_connection(&path).await.unwrap_err();
        assert!(
            error
                .to_string()
                .contains("is not a valid sqlx-managed Hubris state DB")
        );
    }

    #[tokio::test]
    async fn terminal_flush_prunes_replay_history_budget() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.sqlite3");
        let mut conn = open_connection(&path).await.unwrap();

        let oversized_history = vec![b'x'; crate::pty::live_tab::DEFAULT_SCROLLBACK + 10];
        persist_terminal_flush(
            &mut conn,
            &TerminalFlush {
                project_id: "project-1".to_string(),
                worktree_id: "worktree-1".to_string(),
                tab_id: "terminal-1".to_string(),
                metadata: terminal_rebuild_state(
                    TerminalSize::default_pty(),
                    oversized_history.len() as u64,
                    oversized_history,
                ),
                flushed_at_ms: 1,
            },
        )
        .await
        .unwrap();

        let payload = load_terminal_restore_payload(
            &mut conn,
            "terminal-1",
            crate::pty::live_tab::DEFAULT_SCROLLBACK,
        )
        .await
        .unwrap();
        let persisted_total = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(SUM(length(data)), 0) FROM terminal_replay_chunks WHERE tab_id = 'terminal-1'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap() as usize;
        assert!(persisted_total > crate::pty::live_tab::DEFAULT_SCROLLBACK);
        assert!(payload.history.len() <= crate::pty::live_tab::DEFAULT_SCROLLBACK);
    }

    #[tokio::test]
    async fn delete_tab_state_removes_owned_rows_and_pending_flushes() {
        let tmp = TempDir::new().unwrap();
        let db_path = tmp.path().join("state.sqlite3");
        let service =
            std::sync::Arc::new(WorktreeStateService::new(db_path.clone()).await.unwrap());

        service.replace_worktree_state(make_snapshot());
        service.enqueue_terminal_flush(TerminalFlush {
            project_id: "project-1".to_string(),
            worktree_id: "worktree-1".to_string(),
            tab_id: "terminal-1".to_string(),
            metadata: terminal_rebuild_state(TerminalSize::default_pty(), 5, b"hello".to_vec()),
            flushed_at_ms: 1,
        });
        service.delete_tab_state("terminal-1".to_string(), "worktree-1".to_string());
        service.shutdown().await.unwrap();

        let mut conn = open_connection(&db_path).await.unwrap();
        let tab_count =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM tabs WHERE tab_id = 'terminal-1'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(tab_count, 0);

        let terminal_state_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM terminal_state WHERE tab_id = 'terminal-1'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(terminal_state_count, 0);

        let browser_history_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM browser_history_entries WHERE tab_id = 'browser-1'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(browser_history_count, 2);
    }

    #[tokio::test]
    async fn replace_worktree_state_is_coalesced_until_flushed() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.sqlite3");
        let mut conn = open_connection(&path).await.unwrap();
        let mut state = WriterState::default();

        let first = make_snapshot();
        let mut second = make_snapshot();
        second.restore_state.active_tab_id = Some("browser-1".to_string());

        handle_command(
            &mut conn,
            &mut state,
            Command::ReplaceWorktreeState { snapshot: first },
        )
        .await;
        handle_command(
            &mut conn,
            &mut state,
            Command::ReplaceWorktreeState { snapshot: second },
        )
        .await;

        assert_eq!(state.pending_worktree_snapshots.len(), 1);

        let tab_count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM tabs")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(tab_count, 0);

        flush_pending_worktree_snapshots(&mut conn, &mut state)
            .await
            .unwrap();

        let active_tab_id = sqlx::query_scalar::<_, Option<String>>(
            "SELECT active_tab_id FROM worktree_state WHERE worktree_id = 'worktree-1'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(active_tab_id.as_deref(), Some("browser-1"));
    }

    #[tokio::test]
    async fn update_restore_state_flushes_pending_snapshot_first() {
        let tmp = TempDir::new().unwrap();
        let db_path = tmp.path().join("state.sqlite3");
        let service =
            std::sync::Arc::new(WorktreeStateService::new(db_path.clone()).await.unwrap());

        let mut snapshot = make_snapshot();
        snapshot.restore_state.active_tab_id = Some("terminal-1".to_string());
        service.replace_worktree_state(snapshot);
        service.update_restore_state(
            "project-1".to_string(),
            "worktree-1".to_string(),
            WorktreeRestoreState {
                active_tab_id: Some("browser-1".to_string()),
                focused_pane_id: Some("pane-1".to_string()),
                pane_mru: vec!["pane-1".to_string()],
                tab_mru_by_pane: HashMap::from([(
                    "pane-1".to_string(),
                    vec!["browser-1".to_string(), "terminal-1".to_string()],
                )]),
            },
        );
        service.shutdown().await.unwrap();

        let mut conn = open_connection(&db_path).await.unwrap();
        let active_tab_id = sqlx::query_scalar::<_, Option<String>>(
            "SELECT active_tab_id FROM worktree_state WHERE worktree_id = 'worktree-1'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(active_tab_id.as_deref(), Some("browser-1"));
    }

    #[tokio::test]
    async fn update_terminal_labels_flushes_pending_snapshot_and_drops_titles() {
        let tmp = TempDir::new().unwrap();
        let db_path = tmp.path().join("state.sqlite3");
        let service =
            std::sync::Arc::new(WorktreeStateService::new(db_path.clone()).await.unwrap());

        let mut snapshot = make_snapshot();
        if let TabInfo::Terminal { labels, .. } = &mut snapshot.tabs[0] {
            labels.custom_label = Some("old".to_string());
            labels.smart_label = Some("old-smart".to_string());
            labels.title_label = Some("old-title".to_string());
        }
        service.replace_worktree_state(snapshot);
        service.update_terminal_labels(TerminalLabelsSnapshot {
            project_id: "project-1".to_string(),
            worktree_id: "worktree-1".to_string(),
            tab_id: "terminal-1".to_string(),
            custom_label: Some("new".to_string()),
            process_label: Some("nu".to_string()),
        });
        service.shutdown().await.unwrap();

        let mut conn = open_connection(&db_path).await.unwrap();
        let row = sqlx::query!(
            "
            SELECT custom_label, process_label, title_label
            FROM tabs
            WHERE tab_id = 'terminal-1'
            "
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();

        assert_eq!(row.custom_label.as_deref(), Some("new"));
        assert_eq!(row.process_label.as_deref(), Some("nu"));
        assert_eq!(row.title_label, None);
    }

    #[tokio::test]
    async fn replace_worktree_state_removes_missing_tab_owned_rows() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.sqlite3");
        let mut conn = open_connection(&path).await.unwrap();

        replace_worktree_state(&mut conn, &make_snapshot())
            .await
            .unwrap();
        persist_terminal_flush(
            &mut conn,
            &TerminalFlush {
                project_id: "project-1".to_string(),
                worktree_id: "worktree-1".to_string(),
                tab_id: "terminal-1".to_string(),
                metadata: terminal_rebuild_state(TerminalSize::default_pty(), 5, b"hello".to_vec()),
                flushed_at_ms: 1,
            },
        )
        .await
        .unwrap();

        let mut next_snapshot = make_snapshot();
        next_snapshot.tabs = vec![next_snapshot.tabs[2].clone()];
        replace_worktree_state(&mut conn, &next_snapshot)
            .await
            .unwrap();

        let terminal_tab_count =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM tabs WHERE tab_id = 'terminal-1'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(terminal_tab_count, 0);

        let terminal_state_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM terminal_state WHERE tab_id = 'terminal-1'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(terminal_state_count, 0);

        let browser_tab_count =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM tabs WHERE tab_id = 'browser-1'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(browser_tab_count, 0);

        let browser_history_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM browser_history_entries WHERE tab_id = 'browser-1'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(browser_history_count, 0);
    }

    #[tokio::test]
    async fn delete_worktree_rows_clears_chat_open_tab_ids() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.sqlite3");
        let mut conn = open_connection(&path).await.unwrap();

        replace_worktree_state(&mut conn, &make_snapshot())
            .await
            .unwrap();
        sqlx::query(
            "
            INSERT INTO chat_conversations (
                id, session_id, project_id, worktree_id, provider, title,
                created_at_ms, updated_at_ms, last_activity_at_ms, open_tab_id,
                last_run_state
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
        )
        .bind("chat-1")
        .bind("default")
        .bind("project-1")
        .bind("worktree-1")
        .bind("codex")
        .bind("Chat")
        .bind(1_i64)
        .bind(1_i64)
        .bind(1_i64)
        .bind("terminal-1")
        .bind("completed")
        .execute(&mut conn)
        .await
        .unwrap();

        delete_worktree_rows(&mut conn, "project-1", "worktree-1")
            .await
            .unwrap();

        let open_tab_id = sqlx::query_scalar::<_, Option<String>>(
            "SELECT open_tab_id FROM chat_conversations WHERE id = 'chat-1'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(open_tab_id, None);
    }

    #[tokio::test]
    async fn open_connection_cleans_orphaned_tab_rows() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.sqlite3");
        let mut conn = open_connection(&path).await.unwrap();

        sqlx::query(
            "
            INSERT INTO tabs (
                tab_id, project_id, worktree_id, session_id, tab_type, pane_id, label,
                position, created_at_ms, preview, browser_history_index
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
        )
        .bind("tab-live")
        .bind("project-1")
        .bind("worktree-1")
        .bind("default")
        .bind("browser")
        .bind("pane-1")
        .bind("Live")
        .bind(1.0_f64)
        .bind(1_i64)
        .bind(false)
        .bind(0_i64)
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "
            INSERT INTO browser_history_entries (tab_id, history_index, url)
            VALUES (?, ?, ?), (?, ?, ?)
            ",
        )
        .bind("tab-live")
        .bind(0_i64)
        .bind("https://example.com")
        .bind("tab-orphan")
        .bind(0_i64)
        .bind("https://orphan.example.com")
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "
            INSERT INTO terminal_state (
                tab_id, project_id, worktree_id, last_size_cols, last_size_rows,
                replay_total_bytes, source_bytes_end, replay_epoch, last_flush_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
        )
        .bind("tab-live")
        .bind("project-1")
        .bind("worktree-1")
        .bind(80_i64)
        .bind(24_i64)
        .bind(1_i64)
        .bind(1_i64)
        .bind(0_i64)
        .bind(1_i64)
        .bind(1_i64)
        .bind("tab-orphan")
        .bind("project-1")
        .bind("worktree-1")
        .bind(80_i64)
        .bind(24_i64)
        .bind(1_i64)
        .bind(1_i64)
        .bind(0_i64)
        .bind(1_i64)
        .bind(1_i64)
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "
            INSERT INTO terminal_replay_chunks (tab_id, replay_start_offset, data, created_at_ms)
            VALUES (?, ?, ?, ?), (?, ?, ?, ?)
            ",
        )
        .bind("tab-live")
        .bind(0_i64)
        .bind(vec![1_u8])
        .bind(1_i64)
        .bind("tab-orphan")
        .bind(0_i64)
        .bind(vec![2_u8])
        .bind(1_i64)
        .execute(&mut conn)
        .await
        .unwrap();
        drop(conn);

        let mut reopened = open_connection(&path).await.unwrap();
        let orphan_history_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM browser_history_entries WHERE tab_id = 'tab-orphan'",
        )
        .fetch_one(&mut reopened)
        .await
        .unwrap();
        assert_eq!(orphan_history_count, 0);

        let orphan_terminal_state_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM terminal_state WHERE tab_id = 'tab-orphan'",
        )
        .fetch_one(&mut reopened)
        .await
        .unwrap();
        assert_eq!(orphan_terminal_state_count, 0);

        let orphan_terminal_chunk_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM terminal_replay_chunks WHERE tab_id = 'tab-orphan'",
        )
        .fetch_one(&mut reopened)
        .await
        .unwrap();
        assert_eq!(orphan_terminal_chunk_count, 0);

        let live_history_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM browser_history_entries WHERE tab_id = 'tab-live'",
        )
        .fetch_one(&mut reopened)
        .await
        .unwrap();
        assert_eq!(live_history_count, 1);
    }

    #[test]
    fn normalize_restore_state_prunes_invalid_panes_and_tabs() {
        let snapshot = make_snapshot();
        let normalized = normalize_restore_state_for_snapshot(
            WorktreeRestoreState {
                active_tab_id: Some("missing-tab".to_string()),
                focused_pane_id: Some("missing-pane".to_string()),
                pane_mru: vec![
                    "missing-pane".to_string(),
                    "pane-1".to_string(),
                    "pane-1".to_string(),
                ],
                tab_mru_by_pane: HashMap::from([
                    (
                        "pane-1".to_string(),
                        vec![
                            "browser-1".to_string(),
                            "terminal-1".to_string(),
                            "missing-tab".to_string(),
                            "terminal-1".to_string(),
                        ],
                    ),
                    ("missing-pane".to_string(), vec!["terminal-1".to_string()]),
                ]),
            },
            &snapshot.tabs,
            snapshot.layout.as_ref(),
        );

        assert_eq!(normalized.active_tab_id, None);
        assert_eq!(normalized.focused_pane_id.as_deref(), Some("pane-1"));
        assert_eq!(normalized.pane_mru, vec!["pane-1".to_string()]);
        assert_eq!(
            normalized.tab_mru_by_pane.get("pane-1"),
            Some(&vec!["browser-1".to_string(), "terminal-1".to_string()])
        );
        assert!(!normalized.tab_mru_by_pane.contains_key("missing-pane"));
    }

    #[tokio::test]
    async fn update_restore_state_touches_only_worktree_row() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.sqlite3");
        let mut conn = open_connection(&path).await.unwrap();
        let snapshot = make_snapshot();
        replace_worktree_state(&mut conn, &snapshot).await.unwrap();

        update_restore_state(
            &mut conn,
            "project-1",
            "worktree-1",
            &WorktreeRestoreState {
                active_tab_id: Some("browser-1".to_string()),
                focused_pane_id: Some("pane-1".to_string()),
                pane_mru: vec!["pane-1".to_string()],
                tab_mru_by_pane: HashMap::from([(
                    "pane-1".to_string(),
                    vec!["browser-1".to_string(), "diff-1".to_string()],
                )]),
            },
        )
        .await
        .unwrap();

        let worktree = load_existing_worktrees(
            &mut conn,
            vec![ExistingWorktree {
                project_id: "project-1".to_string(),
                worktree_id: "worktree-1".to_string(),
            }],
        )
        .await
        .unwrap()
        .worktrees
        .pop()
        .unwrap();

        assert_eq!(
            worktree.restore_state.active_tab_id.as_deref(),
            Some("browser-1")
        );
        assert_eq!(worktree.restore_state.pane_mru, vec!["pane-1".to_string()]);
        assert_eq!(
            worktree.restore_state.tab_mru_by_pane.get("pane-1"),
            Some(&vec!["browser-1".to_string(), "diff-1".to_string()])
        );
        assert_eq!(worktree.tabs.len(), 3);
    }
}
