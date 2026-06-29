CREATE TABLE chat_item_outputs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    stream_kind TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    content_text TEXT NOT NULL,
    byte_count INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (item_id) REFERENCES chat_items(id) ON DELETE CASCADE
);

CREATE INDEX idx_chat_item_outputs_item_sequence
    ON chat_item_outputs (conversation_id, item_id, sequence);

CREATE UNIQUE INDEX idx_chat_item_outputs_item_stream_sequence
    ON chat_item_outputs (conversation_id, item_id, stream_kind, sequence);
