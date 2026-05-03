CREATE TABLE chat_pending_requests (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    turn_id TEXT,
    item_id TEXT,
    provider_request_id TEXT NOT NULL,
    provider_turn_id TEXT,
    provider_item_id TEXT,
    method TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    decision TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    response_json TEXT,
    error_message TEXT,
    owner_generation INTEGER NOT NULL DEFAULT 0,
    sequence INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    resolved_at_ms INTEGER
);

CREATE INDEX idx_chat_pending_requests_conversation_sequence
    ON chat_pending_requests (conversation_id, sequence);

CREATE INDEX idx_chat_pending_requests_conversation_status
    ON chat_pending_requests (conversation_id, status, updated_at_ms DESC);

CREATE UNIQUE INDEX idx_chat_pending_requests_provider_request
    ON chat_pending_requests (conversation_id, provider_request_id)
    WHERE provider_request_id IS NOT NULL;
