# Plan: Persistent Terminal Sessions

## Context

Terminal sessions are fully ephemeral — WS disconnect kills the PTY.
This means browser reload, closing the tab, or switching projects
destroys all terminal state. We need PTYs to outlive WS connections
so users can reconnect and resume where they left off.

Additionally, project switching currently resets all tabs
(`tabStore.reset()`). Tabs should survive project switches — each
tab is associated with a project, and switching just changes which
tabs are displayed.

Session management is designed for future multi-session support: each
tab carries a `session_id` field (always `"default"` for now), but no
session switching UI is exposed.

## Architecture Change

```
Before: WS connect → spawn PTY → relay I/O → WS close → kill PTY
After:  POST /api/tabs → spawn PTY (lives in DashMap)
        WS connect → attach to existing PTY → replay scrollback → relay
        WS close → detach (PTY stays alive)
        DELETE /api/tabs/{id} → kill PTY
```

Key pieces:
- **LiveTab** — server-side struct holding a persistent PTY, a
  scrollback buffer, and a broadcast channel for output fan-out
- **Tab REST API** — CRUD endpoints that spawn/kill PTYs
- **WS attach handler** — replaces the current spawn-on-connect model
- **API-backed tab store** — frontend fetches tabs from server

## Step 1: Backend — LiveTab struct

**Create** `crates/server/src/pty/live_tab.rs`

Core struct holding a persistent PTY + scrollback + broadcast:

```rust
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{Child, MasterPty};
use serde::Serialize;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

const MAX_SCROLLBACK: usize = 128 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct TabInfo {
    pub id: String,
    pub session_id: String,
    pub project_id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub tab_type: String,
}

pub struct LiveTab {
    pub info: TabInfo,
    pub pty_master: Mutex<Box<dyn MasterPty + Send>>,
    pub pty_writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    pub scrollback: Arc<Mutex<VecDeque<u8>>>,
    pub output_tx: broadcast::Sender<Vec<u8>>,
    _reader_handle: JoinHandle<()>,
}
```

Methods:

- `spawn(info, master, child) -> Self` — Takes ownership of the PTY
  master/child. Extracts reader + writer from master. Starts a
  background `spawn_blocking` task that reads from PTY in a loop,
  appends to scrollback (bounded, drops oldest bytes), and broadcasts
  to `output_tx`. Returns the constructed `LiveTab`.

- `attach(&self) -> (Vec<u8>, broadcast::Receiver<Vec<u8>>)` — Lock
  scrollback, subscribe to broadcast, clone scrollback contents,
  unlock. This ordering guarantees no missed or duplicated output.
  Returns (scrollback_snapshot, live_output_receiver).

- `kill(&self)` — Lock child, call `child.kill()` + `child.wait()`.
  Reader task ends naturally when PTY fd closes.

- `Drop` impl — calls `kill()` + aborts `_reader_handle`.

**Scrollback buffer**: `VecDeque<u8>` capped at 128KB. On append, pop
front bytes when at capacity. Simple and correct.

**Broadcast channel**: capacity 64. If a slow WS client falls behind,
`recv()` returns `Lagged(n)` — log a warning and continue. The
scrollback buffer is the safety net for reconnection.

## Step 2: Backend — Update AppState

**Modify** `crates/server/src/state.rs`

```rust
pub type TabId = String;

pub struct AppState {
    pub tabs: Arc<DashMap<TabId, Arc<LiveTab>>>,
    pub next_tab_num: Arc<AtomicU32>,
    pub data_dir: PathBuf,
}
```

Changes:
- `sessions: DashMap<SessionId, PtySession>` → `tabs: DashMap<TabId, Arc<LiveTab>>`
- Add `next_tab_num: Arc<AtomicU32>` for monotonic tab labels
- `Arc<LiveTab>` in DashMap so WS handlers can clone the Arc and hold
  it without keeping the DashMap shard locked across await points

Also move `load_projects` helper here as `AppState::load_projects()`
to eliminate duplication across `projects.rs`, `terminal.rs`, `tabs.rs`.

**Modify** `crates/server/src/pty/mod.rs` — add `pub mod live_tab;`

**Delete** `crates/server/src/pty/session.rs` — fully replaced.

## Step 3: Backend — Tab REST API

**Create** `crates/server/src/api/tabs.rs`

Three handlers following the pattern from `projects.rs`:

`GET /api/tabs` → `list_tabs` — Iterate DashMap, collect
`TabInfo` clones, return as JSON array.

`POST /api/tabs` → `create_tab` — Body: `{ project_id: String }`.
Validate project exists via `state.load_projects()`. Open PTY
(24×80), spawn `$SHELL` in project dir with `TERM=xterm-256color`.
Call `LiveTab::spawn()`. Insert `Arc<LiveTab>` into DashMap. Return
201 with TabInfo JSON. Label from `next_tab_num.fetch_add(1)`.

`DELETE /api/tabs/{id}` → `delete_tab` — Remove from DashMap. The
`Arc<LiveTab>` drop calls `kill()`. Return 204 or 404.

**Modify** `crates/server/src/api/mod.rs` — add `pub mod tabs;`

**Modify** `crates/server/src/lib.rs` — wire routes:
```rust
.route("/tabs", get(list_tabs).post(create_tab))
.route("/tabs/{id}", delete(delete_tab))
```

## Step 4: Backend — WS Attach Handler

**Rewrite** `crates/server/src/api/terminal.rs`

Query param changes from `project_id` to `tab_id`.

`ws_handler`: Check `state.tabs.contains_key(&tab_id)`, return 404
if missing, then upgrade.

`handle_attach(socket, tab_id, state)`:
1. Clone `Arc<LiveTab>` from DashMap (drops the shard guard).
2. Call `tab.attach()` → get `(scrollback, output_rx)`.
3. Split socket into sender + receiver.
4. Send scrollback as one binary message.
5. Spawn relay task: `output_rx` → WS sender (with existing adaptive
   batching — <128 bytes immediate, ≥128 bytes batch 4ms).
6. Main loop: WS receiver → PTY writer (binary input) + resize (JSON).
   Same `ControlMessage` enum as today.
7. On WS close: abort relay task. **Do not kill PTY.**

The `Arc<LiveTab>` lives for the WS connection duration. Mutex
fields accessed per-message — brief locks, no contention concern.

Handle `broadcast::error::RecvError::Lagged(n)` by logging and
continuing (client sees a gap but stays connected).

## Step 5: Backend — Tab cleanup on project delete

**Modify** `crates/server/src/api/projects.rs`

In `delete_project`, after removing the project from the JSON file,
also remove all tabs belonging to that project:

```rust
let tab_ids: Vec<String> = state.tabs.iter()
    .filter(|e| e.value().info.project_id == id)
    .map(|e| e.key().clone())
    .collect();
for tid in tab_ids {
    state.tabs.remove(&tid);
    // Arc<LiveTab> drop triggers kill()
}
```

`delete_project` handler needs to take `State(state)` (currently it
does via `load_projects`/`save_projects` — just needs the DashMap
access added).

## Step 6: Frontend — Types + API

**Modify** `frontend/src/lib/types.ts`

```typescript
export interface Tab {
  id: string;
  session_id: string;
  project_id: string;
  label: string;
  type: 'terminal';
}
```

Add `session_id` and `project_id` fields.

**Modify** `frontend/src/lib/api.ts`

Add tab CRUD functions:
```typescript
export async function listTabs(): Promise<Tab[]> { ... }
export async function createTab(projectId: string): Promise<Tab> { ... }
export async function deleteTab(id: string): Promise<void> { ... }
```

Change `terminalWsUrl` param from `projectId` to `tabId`, query
param from `project_id` to `tab_id`.

## Step 7: Frontend — Tab Store Rewrite

**Rewrite** `frontend/src/lib/stores/tabs.svelte.ts`

Changes from current:
- All CRUD goes through REST API (not local-only)
- Store holds ALL tabs across all projects
- Exposes `tabsForProject(projectId)` for filtered view
- Tracks `activeTabByProject: Record<string, string>` so switching
  projects remembers which tab was last active
- `switchToProject(id)` sets `activeTabId` to the remembered tab
  (or first available, or null)
- `addTerminal(projectId)` calls `createTab` API, appends to local
  array, sets as active
- `close(id)` calls `deleteTab` API, removes from local array
- `refresh()` fetches all tabs from server
- **`reset()` is removed** — project switch no longer destroys tabs

## Step 8: Frontend — Component Changes

**Modify** `frontend/src/lib/components/TerminalTab.svelte`

- Prop changes: `projectId` → `tabId`
- WS URL: `terminalWsUrl(tabId)` instead of `terminalWsUrl(projectId)`
- `onclose` handler: don't show `[Connection closed]` — PTY is still
  alive. Could show nothing, or `[Disconnected]` if we want feedback.
- `onDestroy`: still calls `ws?.close()` + `terminal?.dispose()` —
  this detaches but doesn't kill the PTY.

Everything else (xterm setup, resize handling, input relay) unchanged.

**Modify** `frontend/src/lib/components/ProjectView.svelte`

- Remove `$effect` that calls `tabStore.reset()` on project change
- Add `onMount` calling `tabStore.refresh()`
- Add `$effect` calling `tabStore.switchToProject(project.id)`
- Use `$derived` for `projectTabs = tabStore.tabsForProject(project.id)`
- Tab bar iterates `projectTabs` instead of `tabStore.tabs`
- `addTerminal` button calls `tabStore.addTerminal(project.id)`
- `TerminalTab` receives `tabId={tab.id}` instead of `projectId={project.id}`

**Note on project switching**: `App.svelte` uses `{#if store.selected}`
which remounts `ProjectView` on project change. This unmounts/remounts
`TerminalTab` components, closing and reopening WS connections. The
scrollback replay ensures no output is lost. Acceptable for v1.

## Files Summary

### Create
- `crates/server/src/pty/live_tab.rs` — LiveTab struct
- `crates/server/src/api/tabs.rs` — Tab REST handlers
- `crates/server/tests/api_tabs.rs` — Tab API tests

### Modify
- `crates/server/src/state.rs` — AppState with tabs DashMap
- `crates/server/src/pty/mod.rs` — add live_tab module
- `crates/server/src/api/mod.rs` — add tabs module
- `crates/server/src/lib.rs` — add tab routes
- `crates/server/src/api/terminal.rs` — rewrite as attach handler
- `crates/server/src/api/projects.rs` — tab cleanup on project delete,
  use `state.load_projects()`
- `frontend/src/lib/types.ts` — Tab type gains fields
- `frontend/src/lib/api.ts` — tab CRUD + WS URL change
- `frontend/src/lib/stores/tabs.svelte.ts` — API-backed store
- `frontend/src/lib/components/TerminalTab.svelte` — tabId prop
- `frontend/src/lib/components/ProjectView.svelte` — project-filtered tabs
- `frontend/src/lib/api.test.ts` — update/add tab API tests

### Delete
- `crates/server/src/pty/session.rs` — replaced by LiveTab

## Testing

### Backend (`crates/server/tests/api_tabs.rs`)

Follow existing `api_projects.rs` pattern (start_test_server helper):
- List tabs empty
- Create tab (valid project) → 201 with TabInfo
- Create tab (invalid project) → 404
- List after create → correct count
- Delete tab → 204
- Delete nonexistent → 404
- Tab labels increment monotonically

WS integration tests (add `tokio-tungstenite` to dev-deps):
- Connect to valid tab → receive data
- Send command → see output
- Disconnect + reconnect → scrollback replayed
- Connect to nonexistent tab → 404 (upgrade rejected)

### Frontend (`frontend/src/lib/api.test.ts`)

Add tests for `listTabs`, `createTab`, `deleteTab` following the
existing mock-fetch pattern. Update `terminalWsUrl` test to use
`tab_id` param.

### Manual E2E Verification

1. Start dev servers (`mise run dev`)
2. Add a project, open a terminal, run a command
3. Reload the page → terminal should reconnect with output preserved
4. Open a second browser tab → same terminals visible
5. Switch to different project → switch back → terminals restored
6. Close a tab → PTY killed, tab gone
7. Delete a project → its tabs are also removed

## Tasks

### Phase 1: Backend — LiveTab + State

- [x] Create `crates/server/src/pty/live_tab.rs`
  - [x] Define `TabInfo` struct with serde (id, session_id,
        project_id, label, tab_type with `#[serde(rename)]`)
  - [x] Define `LiveTab` struct (pty_master, pty_writer, child,
        scrollback, output_tx, _reader_handle)
  - [x] Implement `LiveTab::spawn()` — extract reader/writer from
        master, start `spawn_blocking` PTY reader loop, wire
        scrollback append + broadcast send
  - [x] Implement `LiveTab::attach()` — lock scrollback, subscribe
        broadcast, clone scrollback, unlock, return tuple
  - [x] Implement `LiveTab::kill()` — lock child, kill + wait
  - [x] Implement `Drop` for `LiveTab` — kill + abort reader handle
- [x] Update `crates/server/src/pty/mod.rs` — add `pub mod live_tab`
- [x] Delete `crates/server/src/pty/session.rs`
- [x] Update `crates/server/src/state.rs`
  - [x] Replace `sessions: Arc<DashMap<SessionId, PtySession>>` with
        `tabs: Arc<DashMap<TabId, Arc<LiveTab>>>`
  - [x] Add `next_tab_num: Arc<AtomicU32>`
  - [x] Update `AppState::new()` to initialize new fields
  - [x] Move `load_projects()` here as `AppState::load_projects()`
- [x] Verify `cargo check` passes

### Phase 2: Backend — Tab REST API

- [x] Create `crates/server/src/api/tabs.rs`
  - [x] Define `CreateTabRequest { project_id: String }`
  - [x] Implement `list_tabs` handler (GET /api/tabs)
  - [x] Implement `create_tab` handler (POST /api/tabs) — validate
        project, open PTY, spawn shell, call `LiveTab::spawn()`,
        insert into DashMap, return 201 + TabInfo
  - [x] Implement `delete_tab` handler (DELETE /api/tabs/{id}) —
        remove from DashMap, return 204 or 404
- [x] Update `crates/server/src/api/mod.rs` — add `pub mod tabs`
- [x] Update `crates/server/src/lib.rs` — wire tab routes
- [x] Update `crates/server/src/api/projects.rs`
  - [x] Switch to `state.load_projects()`, remove local
        `load_projects` fn
  - [x] Add tab cleanup to `delete_project` — remove all tabs
        belonging to the deleted project from DashMap
- [x] Verify `cargo check` passes

### Phase 3: Backend — WS Attach Handler

- [x] Rewrite `crates/server/src/api/terminal.rs`
  - [x] Change `TerminalParams` from `project_id` to `tab_id`
  - [x] Rewrite `ws_handler` — look up tab in DashMap, 404 if
        missing, upgrade
  - [x] Implement `handle_attach` — clone `Arc<LiveTab>`, call
        `attach()`, send scrollback, spawn relay task with adaptive
        batching, main receive loop for input + resize
  - [x] Handle `broadcast::error::RecvError::Lagged` — log + continue
  - [x] On WS close: abort relay task only, do NOT kill PTY
  - [x] Remove old `handle_terminal`, `load_projects` from this file
- [x] Verify `cargo check` passes
- [x] Verify `cargo test` passes (existing project tests still work)

### Phase 4: Frontend — Types + API

- [x] Update `frontend/src/lib/types.ts` — add `session_id` and
      `project_id` fields to `Tab` interface
- [x] Update `frontend/src/lib/api.ts`
  - [x] Add `listTabs()` function
  - [x] Add `createTab(projectId)` function
  - [x] Add `deleteTab(id)` function
  - [x] Change `terminalWsUrl` — param from `projectId` to `tabId`,
        query param from `project_id` to `tab_id`

### Phase 5: Frontend — Tab Store Rewrite

- [x] Rewrite `frontend/src/lib/stores/tabs.svelte.ts`
  - [x] Add `activeTabByProject: Record<string, string>` state
  - [x] Implement `refresh()` — fetch all tabs from server
  - [x] Implement `addTerminal(projectId)` — call `createTab` API,
        update local state, set active
  - [x] Implement `close(id)` — call `deleteTab` API, update local
        state, fall back active tab
  - [x] Implement `activate(id)` — set activeTabId, update
        activeTabByProject
  - [x] Implement `tabsForProject(projectId)` — filter by project
  - [x] Implement `switchToProject(projectId)` — restore remembered
        active tab or default to first
  - [x] Remove `reset()` method

### Phase 6: Frontend — Component Changes

- [x] Update `frontend/src/lib/components/TerminalTab.svelte`
  - [x] Change prop from `projectId` to `tabId`
  - [x] Update WS URL to use `terminalWsUrl(tabId)`
  - [x] Update `onclose` — remove `[Connection closed]` message
        (PTY still alive)
- [x] Update `frontend/src/lib/components/ProjectView.svelte`
  - [x] Remove `$effect` calling `tabStore.reset()`
  - [x] Add `onMount` calling `tabStore.refresh()`
  - [x] Add `$effect` calling `tabStore.switchToProject(project.id)`
  - [x] Add `$derived` for `projectTabs` filtered by project
  - [x] Update tab bar to iterate `projectTabs`
  - [x] Update add button to call `tabStore.addTerminal(project.id)`
  - [x] Update `TerminalTab` to pass `tabId={tab.id}`

### Phase 7: Tests

- [x] Update `frontend/src/lib/api.test.ts`
  - [x] Add tests for `listTabs`
  - [x] Add tests for `createTab`
  - [x] Add tests for `deleteTab`
  - [x] Update `terminalWsUrl` test for `tab_id` param
- [x] Create `crates/server/tests/api_tabs.rs`
  - [x] Test list tabs empty
  - [x] Test create tab with valid project → 201
  - [x] Test create tab with invalid project → 404
  - [x] Test list after create → correct count
  - [x] Test delete tab → 204
  - [x] Test delete nonexistent tab → 404
  - [x] Test tab labels increment monotonically
- [x] Verify all tests pass: `cargo test` + `bun test`
- [x] Verify `cargo check` + `bun run check` clean

### Phase 8: Manual E2E Verification

- [x] `mise run dev` — both servers start
- [x] Add a project, open terminal, run a command (API verified)
- [ ] Reload page → terminal reconnects with output preserved (needs browser)
- [ ] Open second browser tab → same terminals visible (needs browser)
- [ ] Switch project → switch back → terminals restored (needs browser)
- [x] Close a tab → PTY killed, tab gone from list
- [x] Delete a project → its tabs are also removed
