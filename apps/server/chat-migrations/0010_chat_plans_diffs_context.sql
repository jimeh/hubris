CREATE TABLE chat_plans (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    turn_id TEXT,
    item_id TEXT,
    provider_turn_id TEXT,
    provider_item_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    content_text TEXT NOT NULL DEFAULT '',
    steps_json TEXT NOT NULL DEFAULT '[]',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    owner_generation INTEGER NOT NULL DEFAULT 0,
    sequence INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER
);

CREATE INDEX idx_chat_plans_conversation_sequence
    ON chat_plans (conversation_id, sequence);

CREATE UNIQUE INDEX idx_chat_plans_active_turn
    ON chat_plans (conversation_id, turn_id, kind)
    WHERE turn_id IS NOT NULL AND kind = 'active_task';

CREATE UNIQUE INDEX idx_chat_plans_provider_item
    ON chat_plans (conversation_id, provider_item_id)
    WHERE provider_item_id IS NOT NULL;

CREATE TABLE chat_diff_summaries (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    turn_id TEXT,
    provider_turn_id TEXT,
    changed_file_count INTEGER NOT NULL DEFAULT 0,
    additions INTEGER,
    deletions INTEGER,
    files_json TEXT NOT NULL DEFAULT '[]',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    owner_generation INTEGER NOT NULL DEFAULT 0,
    sequence INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_chat_diff_summaries_conversation_sequence
    ON chat_diff_summaries (conversation_id, sequence);

CREATE UNIQUE INDEX idx_chat_diff_summaries_turn
    ON chat_diff_summaries (conversation_id, turn_id)
    WHERE turn_id IS NOT NULL;

CREATE TABLE chat_context_usage (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    provider_thread_id TEXT,
    used_tokens INTEGER,
    max_tokens INTEGER,
    percent_used REAL,
    total_processed_tokens INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_chat_context_usage_conversation
    ON chat_context_usage (conversation_id);
