# Worktree State Persistence

Hubris currently keeps worktree UI state only in server memory. If the server
restarts, open tabs, file state, and terminal sessions are lost, including
terminal scrollback. I want Hubris to start persisting that state to disk so a
worktree can be restored instead of coming back empty.

## Goal

Persist server-authoritative worktree state so Hubris can restore a user's
working context after a server restart.

## Scope

- Focus on persisted worktree state owned by the Rust backend.
- Include terminals and their scrollback history as part of the restored state.
- Include the broader question of whether the current state model should remain
  file-backed or evolve toward a database-backed design.
- Keep implementation planning and migration details for the executing agent to
  decide.

## Desired Outcome

- Open worktree state survives Hubris server restarts.
- Reopening a project/worktree can restore previously open tabs and files.
- Terminal tabs can be restored with meaningful prior scrollback/history.
- The persistence model fits Hubris's current architecture while leaving room
  for future growth.
- The work results in a practical evaluation of storage options instead of
  assuming the answer upfront.

## Requirements

- Preserve Hubris's server-authoritative model for tabs and worktrees.
- Treat persisted state as backend state, not as a frontend-only cache.
- Keep restore behavior coherent across current tab types, even if some tab
  kinds can only be partially reconstructed.
- Be explicit about what should be durably stored versus what can be rebuilt at
  runtime.
- Evaluate storage approaches pragmatically, including improved file-based
  persistence and database-backed options.

## Relevant Existing Code

- `apps/server/src/tab.rs`
- `apps/server/src/api/tabs.rs`
- `apps/server/src/api/terminal.rs`
- `apps/server/src/pty/live_tab.rs`
- `apps/web/src/lib/stores/tabs.ts`
- `apps/web/src/lib/stores/terminal.ts`
- `docs/agents/architecture.md`

## Design Guidance

- Start from the user-facing outcome: reopening Hubris should feel like
  returning to the same worktree state, not starting over.
- Keep the solution practical for Hubris's current scale. This does not need to
  commit the project to a heavyweight database unless that is clearly justified.
- Prefer a design that makes future persistence of additional worktree/session
  state easier rather than special-casing only terminal scrollback.
