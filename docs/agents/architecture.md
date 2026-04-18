# Architecture

## Connection Model

One SSE stream (state sync) + N WebSocket connections (PTY I/O) per browser. WS
attaches to existing `LiveTab`; it does **not** kill the PTY on disconnect. WS
auto-reconnects with exponential backoff and resumable byte-position tracking
(`resume_from` query param). Input is buffered client-side while disconnected.

## State Sync

SSE snapshot on connect, incremental events for changes. `EventSource`
auto-reconnects; the server re-snapshots on reconnect. No periodic
reconciliation — drift corrects on reconnect.

## Backend (Rust / Axum)

- State: grep for `AppState` — DashMap for tabs, EventBus for SSE
- Persistence: JSON project data + TOML settings. Dev: `~/.hubris-dev/`, prod:
  `~/.hubris/`
- PTY: portable-pty, shell from `$SHELL` or `/bin/sh`
- Tabs: server-authoritative across types. Terminal, file, git diff, and browser
  tabs all use the same REST + SSE lifecycle (`create`, `activate`, `reorder`,
  `close`, snapshot sync); only terminal byte I/O is special-cased onto
  WebSockets.
- Terminal tab naming keeps the stored `label` as the numbered fallback. Manual
  rename (`customLabel`) overrides everything, OSC titles (`titleLabel`) are a
  separate optional override, and server-computed smart labels (`smartLabel`)
  cover shell cwd / foreground process naming when enabled.
- WS protocol: binary (PTY output), JSON control (`type: "resize"`,
  `type: "attached"` with `byte_offset`/`data_lost`)
- SSE events: snapshot, tab_created, tab_closed, tab_updated, project_added,
  project_removed, project_updated, projects_reordered, worktree_created,
  worktree_deleted, worktrees_reordered, project_worktrees_updated
- Git status: `GET /api/projects/{id}/worktrees/{wt_id}/git-status` uses
  `git2`/libgit2 (not CLI) to read staged/unstaged/ahead-of-source info.
  `source_ref` on worktrees tracks the branch it was created from.

## Frontend (React / Vite / Tailwind v4)

- App location: `apps/web/`
- State: Zustand singletons — grep `useProjectStore`, `useWorktreeStore`,
  `useTabStore`, `useSettingsStore`, `useSystemStore`, `useThemeSettings`,
  `useTerminalSettings`, `useWorktreeSettings`, `useWorktreeRightSidebarStore`,
  `useWorktreeRightSidebarWidthStore`
- SSE bootstrap: `src/lib/bootstrap.ts`
- UI primitives: shadcn/ui React under `src/components/ui/`
- Sidebar decomposition: `AppSidebar.tsx` is a thin facade; feature code lives
  in `components/app-sidebar/`
- Settings decomposition: `SettingsDialog.tsx` is a thin facade; feature code
  lives in `components/settings-dialog/`
- Tab bar decomposition: `TabBar.tsx` is the shell; sortable behavior lives in
  `components/tab-bar/`
- Browser tabs: the shared server tab model persists URL/history/label, while
  runtime-only UI state (draft address, loading/error flags, iframe reload key)
  lives in `src/lib/stores/browserTabs.ts`. Web uses an `iframe`; desktop uses
  an Electron bridge-backed `WebContentsView`.
- Terminal connection state machine lives in
  `components/terminal/useTerminalConnection.ts`
- Theme engine: native Hubris theme definitions in `src/lib/theme/builtin.ts`,
  converted by `src/lib/theme/convert.ts`
- FOUC prevention: inline script in `index.html` reads `hubris-settings` to
  choose light/dark mode and `hubris-theme-cache` to apply cached CSS vars
  before first paint
- API contracts: Rust `generate_contracts` writes directly to
  `apps/web/src/lib/contracts/{openapi,sse,ws}.generated.*`; then
  `bun run --filter hubris-web generate:contracts:rest` produces
  `rest.generated.ts`
