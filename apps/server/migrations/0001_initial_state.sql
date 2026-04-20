CREATE TABLE worktree_state (
    project_id TEXT NOT NULL,
    worktree_id TEXT PRIMARY KEY,
    active_tab_id TEXT,
    focused_pane_id TEXT,
    layout_root_id TEXT,
    next_terminal_number INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE layout_nodes (
    worktree_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    node_type TEXT NOT NULL,
    pane_id TEXT,
    axis TEXT,
    ratio REAL,
    first_id TEXT,
    second_id TEXT,
    PRIMARY KEY (worktree_id, node_id)
);

CREATE TABLE tabs (
    tab_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tab_type TEXT NOT NULL,
    pane_id TEXT NOT NULL,
    label TEXT NOT NULL,
    position REAL NOT NULL,
    created_at_ms INTEGER NOT NULL,
    preview INTEGER NOT NULL,
    custom_label TEXT,
    process_label TEXT,
    title_label TEXT,
    path TEXT,
    scope TEXT,
    original_path TEXT,
    commit_id TEXT,
    url TEXT,
    browser_history_index INTEGER
);

CREATE TABLE browser_history_entries (
    tab_id TEXT NOT NULL,
    history_index INTEGER NOT NULL,
    url TEXT NOT NULL,
    PRIMARY KEY (tab_id, history_index)
);

CREATE TABLE terminal_state (
    tab_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    last_size_cols INTEGER NOT NULL,
    last_size_rows INTEGER NOT NULL,
    replay_total_bytes INTEGER NOT NULL DEFAULT 0,
    source_bytes_end INTEGER NOT NULL DEFAULT 0,
    replay_epoch INTEGER NOT NULL DEFAULT 0,
    last_flush_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE terminal_replay_chunks (
    tab_id TEXT NOT NULL,
    replay_start_offset INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (tab_id, replay_start_offset)
);

CREATE INDEX idx_tabs_worktree_id ON tabs (worktree_id);
