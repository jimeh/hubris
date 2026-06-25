CREATE TABLE chat_conversations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_thread_id TEXT,
    title TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    last_activity_at_ms INTEGER NOT NULL,
    last_message_at_ms INTEGER,
    open_tab_id TEXT,
    last_run_state TEXT NOT NULL,
    last_error TEXT,
    revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    provider_turn_id TEXT,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    content_text TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
);

CREATE TABLE chat_runs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    provider_turn_id TEXT,
    status TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    error_message TEXT,
    FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
);

CREATE INDEX idx_chat_conversations_scope
    ON chat_conversations (session_id, worktree_id, updated_at_ms DESC);

CREATE INDEX idx_chat_messages_conversation
    ON chat_messages (conversation_id, sequence);

CREATE INDEX idx_chat_runs_conversation
    ON chat_runs (conversation_id, started_at_ms DESC);
