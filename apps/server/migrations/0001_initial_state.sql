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
    total_bytes INTEGER NOT NULL DEFAULT 0,
    last_snapshot BLOB NOT NULL,
    last_flush_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE terminal_chunks (
    tab_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    data BLOB NOT NULL,
    byte_len INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (tab_id, seq)
);

CREATE INDEX idx_tabs_worktree_id ON tabs (worktree_id);
CREATE INDEX idx_terminal_chunks_tab_seq ON terminal_chunks (tab_id, seq);
CREATE INDEX idx_browser_history_tab_index
    ON browser_history_entries (tab_id, history_index);
