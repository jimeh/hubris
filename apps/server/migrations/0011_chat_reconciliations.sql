CREATE TABLE chat_reconciliations (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    provider_thread_id TEXT,
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    error_message TEXT,
    owner_generation INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

ALTER TABLE chat_turns
    ADD COLUMN reconciliation_status TEXT NOT NULL DEFAULT 'not_needed';

ALTER TABLE chat_turns
    ADD COLUMN reconciled_at_ms INTEGER;

ALTER TABLE chat_turns
    ADD COLUMN reconciliation_error TEXT;

ALTER TABLE chat_conversations
    ADD COLUMN last_reconciliation_state TEXT NOT NULL DEFAULT 'not_needed';

ALTER TABLE chat_conversations
    ADD COLUMN last_reconciliation_error TEXT;

CREATE INDEX idx_chat_reconciliations_conversation
    ON chat_reconciliations (conversation_id, updated_at_ms DESC);

CREATE INDEX idx_chat_reconciliations_status
    ON chat_reconciliations (status, updated_at_ms DESC);
