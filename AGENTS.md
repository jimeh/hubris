# Hubris

Terminal-based project manager: Rust/Axum backend with a React/Vite
frontend and persistent PTY sessions.

## Build & Run

```sh
mise run setup     # install all deps
mise run dev       # backend + frontend dev servers
mise run check     # format check + lint + type check (all)
mise run format    # auto-format all code
mise run test      # frontend tests + cargo test
mise run generate  # run all code generators
```

Sub-tasks: `check:backend`, `check:frontend`, `format:backend`,
`format:frontend`. `lint` is an alias for `check`.

Tools: mise (see `mise.toml`). Packages: Cargo (backend), **bun**
(frontend).

**IMPORTANT: Always run `mise run check` before committing or opening
PRs.** CI runs the same checks — format (`cargo fmt`, `prettier`),
lint (`clippy`, `eslint`), and type check (`tsc`).

**IMPORTANT: The frontend uses bun, NOT npm or pnpm.** All frontend
commands must use `bun` (`bun install`, `bun run test`, `bun run
check`). The `frontend/` directory has a `bun.lock`; there is no
`package-lock.json` or `pnpm-lock.yaml`.

## Domain Concepts

- **Project** — user-registered git repository; path canonicalized to
  git local root on add. Persisted in JSON file.
- **Worktree** — git worktree within a project. The "local" worktree
  is the project's own directory; others are created via `git worktree
  add`. IDs are deterministic UUIDv5 from path.
- **Session** — logical tab grouping. Hardcoded "default" for now,
  designed for multi-session later.
- **Tab** — server-authoritative terminal within a worktree+session.
  CRUD via REST, state sync via SSE. Type field extensible.
- **LiveTab** — server-side persistent PTY. Survives WS disconnects.
  Killed only on explicit close or shell exit.

## Architecture

### Connection Model

One SSE stream (state sync) + N WebSocket connections (PTY I/O) per
browser. WS attaches to existing `LiveTab`; it does **not** kill the
PTY on disconnect. WS auto-reconnects with exponential backoff and
resumable byte-position tracking (`resume_from` query param). Input is
buffered client-side while disconnected.

### State Sync

SSE snapshot on connect, incremental events for changes.
`EventSource` auto-reconnects; the server re-snapshots on reconnect.
No periodic reconciliation — drift corrects on reconnect.

### Backend (Rust / Axum)

- State: grep for `AppState` — DashMap for tabs, EventBus for SSE
- Persistence: JSON file. Dev: `~/.hubris-dev/`, prod: `~/.hubris/`
- PTY: portable-pty, shell from `$SHELL` or `/bin/sh`
- WS protocol: binary (PTY output), JSON control (`type: "resize"`,
  `type: "attached"` with `byte_offset`/`data_lost`)
- SSE events: snapshot, tab_created, tab_closed, tab_updated,
  project_added, project_removed, project_updated, projects_reordered,
  worktree_created, worktree_deleted, worktrees_reordered,
  project_worktrees_updated

### Frontend (React / Vite / Tailwind v4)

- App location: `frontend/`
- State: Zustand singletons — grep `useProjectStore`,
  `useWorktreeStore`, `useTabStore`, `useThemeStore`,
  `useTerminalStore`, `useWorktreeSettingsStore`
- SSE bootstrap: `src/lib/bootstrap.ts`
- UI primitives: shadcn/ui React under `src/components/ui/`
- Sidebar decomposition: `AppSidebar.tsx` is a thin façade;
  feature code lives in `components/app-sidebar/`
- Settings decomposition: `SettingsDialog.tsx` is a thin façade;
  feature code lives in `components/settings-dialog/`
- Tab bar decomposition: `TabBar.tsx` is the shell; sortable behavior
  lives in `components/tab-bar/`
- Terminal connection state machine lives in
  `components/terminal/useTerminalConnection.ts`
- Theme engine: native Hubris theme definitions in
  `src/lib/theme/builtin.ts`, converted by `src/lib/theme/convert.ts`
- FOUC prevention: inline script in `index.html` reads localStorage
  (`hubris-theme-cache`) and applies CSS vars before first paint
- API contracts: Rust `generate_contracts` writes directly to
  `frontend/src/lib/contracts/{openapi,sse,ws}.generated.*`; then
  `bun run generate:contracts:rest` produces `rest.generated.ts`
- Dev proxy: port 3001 proxies `/api` → backend 3101

## Conventions

- Conventional commits (`feat:`, `fix:`, `refactor:`)
- Frontend: PascalCase `.tsx`
- Tests colocated (`.test.ts` / `.test.tsx`), `tests/` for Rust
- Rust edition 2024, `style_edition = "2024"` in `rustfmt.toml`
- React app imports should use `@/lib/...`, `@/components/...`, and
  `@/hooks/...`; do not introduce `$lib/...`

## Gotchas

- **Do NOT modify shadcn components**: Files under
  `frontend/src/components/ui/` are managed vendor code. Editing them
  makes future shadcn updates painful. Put customizations in wrapper
  components or app-level code instead.

- **SSE init ordering**: All store handlers must be registered before
  `EventClient.connect()` — the snapshot fires immediately on connect.
  In React bootstrap, initialize project/worktree/tab stores before
  calling `events.connect()`.
- **rustfmt style_edition 2024**: Formats more aggressively than
  default (collapses single-line signatures, method chains). Always
  run `cargo fmt` after edits.
- **Tab position**: `f64` for fractional ordering (midpoint insertion).
- **Project reorder**: Bulk `PUT /api/projects/reorder` with ordered
  IDs. Backend resequences all positions as clean integers and emits a
  single `projects_reordered` SSE event. Do NOT use PATCH to set
  individual positions.
- **Sidebar resize ownership**: Keep sidebar resize customization in
  app-level files instead of `components/ui/sidebar.tsx` so shadcn
  sidebar upgrades remain copy-merge operations.
- **Sidebar width updates are imperative during drag**:
  `frontend/src/App.tsx` subscribes to sidebar width store changes and
  writes `--sidebar-width` directly to the rendered sidebar wrapper.
  Keep `isResizing` reactive, but avoid reintroducing a full React
  subscription to width or resize drags will rerender the app tree.
- **deleteTab tolerates 404**: Tab may already be gone (shell exit,
  other browser).
- **deleteProject tolerates 404**: Project may already be gone (other
  browser removed it).
- **Settings sync**: No SSE event for settings changes yet. Multiple
  open browsers will not see each other's settings changes until
  reload.
- **Settings save is serialized read-modify-write**: `saveSettings` in
  `api.ts` GETs current settings before PUTting merged data, and React
  queues concurrent saves client-side. This prevents appearance,
  terminal, and worktree settings writes from clobbering each other.
- **Appearance settings still store per-mode theme IDs**:
  `lightTheme`/`darkTheme` remain in settings even though only built-in
  Hubris themes are selectable right now.
- **Bundled fonts**: 16 woff2 files live in `frontend/public/fonts/`,
  downloaded via `mise run download:fonts`. Fonts are loaded on-demand
  via dynamic `@font-face` when the user selects a bundled font.
- **Project paths are canonicalized to Git local root**:
  `POST /api/projects` resolves input paths through Git and stores the
  canonical local root. On macOS this often normalizes `/tmp/...` to
  `/private/tmp/...`.
- **Project removal defaults to remove-only**:
  `DELETE /api/projects/:id` removes the project without deleting
  worktrees unless `?delete_managed_worktrees=true` is supplied. Only
  Hubris-managed non-local worktrees are deleted on that path. Dirty or
  busy conflicts (`409`) only apply on the managed-delete path and can
  be overridden with `?force=true`.
- **Terminal WS stale cleanup uses server ping/pong**: terminal
  attachments are expired by server-driven websocket pings. Hidden tabs
  stay connected and should still answer pings, but only `visible:true`
  attachments participate in PTY size aggregation.
- **Terminal component unmount only detaches the browser attachment**:
  React terminal cleanup closes the current websocket connection, but
  the backend keeps the `LiveTab` PTY alive for reconnect. Only
  explicit tab deletion or shell exit destroys the server-side PTY.
- **StrictMode is enabled**: terminal remount/cleanup is
  generation-guarded. Keep websocket, reconnect timer, and post-open
  `requestAnimationFrame` handlers scoped to the active connection so
  stale callbacks from a previous mount cannot schedule extra sockets or
  duplicate terminal I/O.
- **Radix Select tests need extra jsdom shims**: the React settings
  dialog uses Radix Select, which expects pointer capture and
  `scrollIntoView()`. In Vitest/jsdom, stub `hasPointerCapture`,
  `setPointerCapture`, `releasePointerCapture`, and `scrollIntoView` in
  `src/test/setup.ts`.
- **Popover lists inside React dialogs may need a dialog-local
  portal**: `frontend/src/components/AddWorktreeDialog.tsx` mounts the
  start-point `Popover` into a container inside the dialog instead of
  the default body portal. Portalling that popover outside the dialog
  breaks wheel/trackpad scrolling on `CommandList` content.
- **Raised settings menus do not need a custom wrapper**: the settings
  dialog now relies on the mobile sidebar panel being lowered (`z-40`)
  rather than special select-content wrappers. Prefer the shared
  `SelectContent` unless a future dialog introduces a real layering
  conflict.
- **Rust integration tests should disable Git commit signing**:
  local/global Git config may enforce GPG signing and break ephemeral
  test-repo commits. In test helpers that run `git commit`, pass
  `-c commit.gpgsign=false`.
- **`ts-rs` warns on some serde field attributes**: with `ts-rs` +
  `serde-compat`, attributes like
  `skip_serializing_if = "Option::is_none"` may emit warnings during
  `cargo check`/`clippy`. Generated types still build.
- **`ts-rs` v12 changed codegen API**:
  `TS::export_to_string()` now requires a `ts_rs::Config` argument.
- **Dev task wrapper sets shared instance env only**:
  `.mise/tasks/dev` generates random `HUBRIS_DEV_ID`, sets
  `HUBRIS_DEV_TMP`, and runs backend/frontend tasks in parallel.
- **Backend hot reload uses random socket activation port**:
  `dev:server` runs `systemfd --no-pid -s http::0 -- mise watch
  --restart dev:server:raw`.
- **Interrupting `mise run dev` still reports task failure on shutdown**:
  stopping the parallel dev wrapper with `Ctrl-C` surfaces `task failed`
  from `mise` while child processes unwind. Treat that as expected
  shutdown noise unless one of the child processes was already failing
  before the interrupt.
- **Backend watch sources live on hidden raw task**:
  `dev:server:raw` is hidden and owns Rust file `sources` globs used by
  `mise watch`.
- **Stable-port reload requires socket activation in backend**:
  server startup must check inherited fd0 via `listenfd` before using
  dev fallback port binding.
