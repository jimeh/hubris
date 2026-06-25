CREATE TABLE chat_turns (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    user_message_id TEXT NOT NULL,
    assistant_message_id TEXT,
    provider_turn_id TEXT,
    status TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER,
    error_message TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (run_id) REFERENCES chat_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (user_message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
    FOREIGN KEY (assistant_message_id) REFERENCES chat_messages(id) ON DELETE SET NULL
);

CREATE TABLE chat_items (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    turn_id TEXT,
    provider_turn_id TEXT,
    provider_item_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    role TEXT,
    sequence INTEGER NOT NULL,
    title TEXT,
    summary TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER,
    FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (turn_id) REFERENCES chat_turns(id) ON DELETE SET NULL
);

ALTER TABLE chat_messages
    ADD COLUMN turn_id TEXT;

ALTER TABLE chat_messages
    ADD COLUMN item_id TEXT;

ALTER TABLE chat_messages
    ADD COLUMN provider_item_id TEXT;

ALTER TABLE chat_runs
    ADD COLUMN turn_id TEXT;

CREATE INDEX idx_chat_turns_conversation
    ON chat_turns (conversation_id, started_at_ms DESC);

CREATE UNIQUE INDEX idx_chat_turns_provider_turn
    ON chat_turns (provider_turn_id)
    WHERE provider_turn_id IS NOT NULL;

CREATE INDEX idx_chat_items_conversation_sequence
    ON chat_items (conversation_id, sequence);

CREATE INDEX idx_chat_items_turn_sequence
    ON chat_items (turn_id, sequence);

CREATE UNIQUE INDEX idx_chat_items_provider_item
    ON chat_items (conversation_id, provider_item_id)
    WHERE provider_item_id IS NOT NULL;
