ALTER TABLE worktree_state
    ADD COLUMN pane_mru_json TEXT;

ALTER TABLE worktree_state
    ADD COLUMN tab_mru_by_pane_json TEXT;
