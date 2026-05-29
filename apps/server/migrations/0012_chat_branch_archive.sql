ALTER TABLE chat_conversations
    ADD COLUMN branch_name TEXT;

ALTER TABLE chat_conversations
    ADD COLUMN archived_at_ms INTEGER;

CREATE INDEX idx_chat_conversations_scope_branch_archive
    ON chat_conversations (
        session_id,
        project_id,
        branch_name,
        archived_at_ms,
        updated_at_ms DESC
    );

CREATE INDEX idx_chat_conversations_project_archive
    ON chat_conversations (
        session_id,
        project_id,
        archived_at_ms,
        updated_at_ms DESC
    );
