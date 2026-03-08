# Hubris

Terminal-based project manager: Rust/Axum backend with persistent PTY
sessions, Svelte 5 frontend with xterm.js.

## Build & Run

```sh
mise run setup     # install all deps
mise run dev       # backend + frontend dev servers
mise run check     # format check + lint + type check (all)
mise run format    # auto-format all code
mise run test      # vitest + cargo test
mise run generate  # run all code generators
```

Sub-tasks: `check:backend`, `check:frontend`, `format:backend`,
`format:frontend`. `lint` is an alias for `check`.

Tools: mise (see `mise.toml`). Packages: Cargo (backend), **bun** (frontend).

**IMPORTANT: Always run `mise run check` before committing or opening PRs.**
CI runs the same checks — format (`cargo fmt`, `prettier`), lint (`clippy`,
`eslint`), and type check (`svelte-check`, `tsc`).

**IMPORTANT: The frontend uses bun, NOT npm or pnpm.** All frontend commands
must use `bun` (e.g., `bun install`, `bun run test`, `bun run check`).
The `frontend/` directory has a `bun.lock` — there is no `package-lock.json`
or `pnpm-lock.yaml`. Using npm or pnpm will fail or create wrong lockfiles.

## Domain Concepts

- **Project** — user-registered git repository; path canonicalized
  to git local root on add. Persisted in JSON file.
- **Worktree** — git worktree within a project. The "local" worktree
  is the project's own directory; others are created via
  `git worktree add`. IDs are deterministic UUIDv5 from path.
- **Session** — logical tab grouping. Hardcoded "default" for now,
  designed for multi-session later.
- **Tab** — server-authoritative terminal within a worktree+session.
  CRUD via REST, state sync via SSE. Type field extensible.
- **LiveTab** — server-side persistent PTY. Survives WS disconnects.
  Killed only on explicit close or shell exit.

## Architecture

### Connection Model

One SSE stream (state sync) + N WebSocket connections (PTY I/O) per
browser. WS attaches to existing LiveTab; does NOT kill PTY on
disconnect. WS auto-reconnects with exponential backoff and resumable
byte-position tracking (`resume_from` query param). Input buffered
client-side while disconnected.

### State Sync

SSE snapshot on connect, incremental events for changes. EventSource
auto-reconnects; server re-snapshots on reconnect. No periodic
reconciliation — drift corrects on reconnect.

### Backend (Rust / Axum)

- State: grep for `AppState` — DashMap for tabs, EventBus for SSE
- Persistence: JSON file. Dev: `~/.hubris-dev/`, prod: `~/.hubris/`
- PTY: portable-pty, shell from `$SHELL` or `/bin/sh`
- WS protocol: binary (PTY output), JSON control (`type: "resize"`
  with `cols`/`rows`/`visible`, `type: "attached"` with
  `byte_offset`/`data_lost`/`cols`/`rows`, `type: "pty_resized"`
  with `cols`/`rows`)
- SSE events: snapshot, tab_created, tab_closed, tab_updated,
  project_added, project_removed, project_updated, projects_reordered,
  worktree_created, worktree_deleted, worktrees_reordered,
  project_worktrees_updated

### Frontend (Svelte 5 / Vite / Tailwind v4)

- Stores: rune-based singletons — grep `getProjectStore`,
  `getWorktreeStore`, `getTabStore`, `getThemeStore`,
  `getTerminalStore`, `getWorktreeSettingsStore`
- SSE client: singleton — grep `getEventClient`
- Tab store: REST mutations + SSE sync with optimistic updates.
  Active tab and per-worktree tab selection persisted to localStorage.
- Project store: SSE-driven (snapshot + incremental events), optimistic
  mutations. Drag-and-drop reorder via svelte-dnd-action. Projects are
  expandable/collapsible in sidebar; no project-level selection.
- Worktree store: SSE-driven, tracks worktrees per project and
  selected worktree. Selection persisted to localStorage
  (`hubris-selected-worktree`). Worktree CRUD via REST under
  `/api/projects/:id/worktrees`.
- UI primitives: shadcn-svelte (Bits UI) — grep `components/ui/`
  - Please see shadcn-svelte docs here: <https://www.shadcn-svelte.com/llms.txt>
- Sidebar decomposition: `AppSidebar.svelte` is a thin shell; sub-components
  live in `components/sidebar/` (ProjectList, ProjectItem, WorktreeList,
  WorktreeItem, LocalWorktreeItem, ProjectActionMenu, SidebarDialogs).
  Shared types/interfaces in `sidebar/types.ts`. Dialog state centralized
  in AppSidebar via `SidebarDialogState`, passed down as props.
- App layout: `Sidebar.Provider` > `AppSidebar` + `SidebarResizeHandle` +
  `Sidebar.Inset` (header bar with `Sidebar.Trigger` + breadcrumbs + content).
- Project expand/collapse: uses Collapsible (bits-ui) with `data-state`
  attribute for CSS-based icon toggling (`group/collapsible` pattern).
- Project action menu: uses shadcn DropdownMenu (not hand-rolled dropdown).
- Terminal: adapter pattern — grep `TerminalAdapter`, `XtermAdapter`.
  Font registry in `terminal/fonts.ts` (bundled Nerd Fonts, dynamic
  @font-face injection). Terminal settings store manages font source
  (default/system/bundled), font family, and font size.
- Theme engine: native Hubris theme definitions authored as explicit
  shadcn-style tokens in `theme/builtin.ts` and applied by
  `theme/convert.ts`. Built-ins currently ship as `hubris-light` and
  `hubris-dark` only; theme selection is persisted via `/api/settings`.
  There is no active `/api/themes` import/storage flow right now.
- Project store: expanded/collapsed state persisted to localStorage
  (`hubris-expanded-projects`), restored on page load.
- FOUC prevention: inline script in `index.html` reads localStorage
  (`hubris-theme-cache`) and applies full CSS vars before first paint.
- Codegen: `defaults.generated.css` generated from builtin themes via
  `mise run generate`. Committed to git; CI verifies via `git diff`.
- API contracts: OpenAPI spec (utoipa) + TypeScript types (ts-rs) generated
  from Rust structs. `cargo run --bin generate_contracts` writes
  `frontend/src/lib/contracts/{openapi,sse,ws}.generated.*`. Then
  `bun run generate:contracts:rest` runs openapi-typescript to produce
  `rest.generated.ts`. Frontend imports generated types from
  `$lib/contracts/` for request/response bodies and WS/SSE messages.
- Dev proxy: port 3001 proxies `/api` → backend 3101

## Conventions

- Conventional commits (`feat:`, `fix:`, `refactor:`)
- Frontend: PascalCase `.svelte`, camelCase `.svelte.ts` stores
- Tests colocated (`.test.ts` alongside `.ts`, `tests/` for Rust)
- Rust edition 2024, `style_edition = "2024"` in rustfmt.toml

## Gotchas

- **Do NOT modify shadcn components**: Files under
  `frontend/src/lib/components/ui/` are installed by shadcn-svelte and
  should be treated as managed vendor code. Editing them makes future
  `npx shadcn-svelte@latest update` runs painful (manual conflict
  resolution). Put customizations in wrapper components or app-level
  code instead.

- **SSE init ordering**: All store handlers must be registered before
  `EventClient.connect()` — snapshot fires immediately on connect.
  In App.svelte: call `getProjectStore()`, `getWorktreeStore()`, and
  `getTabStore()` before `events.connect()`.
- **rustfmt style_edition 2024**: Formats more aggressively than
  default (collapses single-line signatures, method chains). Always
  run `cargo fmt` after edits.
- **Tab position**: f64 for fractional ordering (midpoint insertion).
- **Project reorder**: Bulk `PUT /api/projects/reorder` with ordered
  IDs. Backend resequences all positions as clean integers (1, 2, 3, …)
  and emits a single `projects_reordered` SSE event. Do NOT use PATCH
  to set individual project positions.
- **svelte-dnd-action + button elements**: The library's mousedown
  guard rejects nested elements with a `value` property (buttons,
  inputs). Use the `child` snippet on `Sidebar.MenuButton` to render
  a `<div>` instead of `<button>` inside draggable containers.
- **deleteTab tolerates 404**: Tab may already be gone (shell exit,
  other browser).
- **deleteProject tolerates 404**: Project may already be gone (other
  browser removed it). Matches deleteTab pattern.
- **shadcn-svelte Select wrapper**: The default `select.svelte` from
  shadcn-svelte destructures `value`/`open` with `$bindable` and
  re-passes via `bind:`. This breaks the bits-ui `type` discriminant
  (single vs multiple), causing string values to be iterated as char
  arrays. The workaround is a simple passthrough: `{...restProps}`.
  If reinstalling shadcn components, reapply this fix.
- **Settings sync**: No SSE event for settings changes yet. Multiple
  open browsers won't see each other's settings changes (theme,
  terminal font) until reload.
- **Terminal WS stale cleanup uses server ping/pong**:
  terminal attachments are expired by server-driven websocket pings.
  Hidden tabs stay connected and should still answer pings, but only
  `visible:true` attachments participate in PTY size aggregation.
- **Settings save is read-modify-write**: `saveSettings` in `api.ts`
  GETs current settings before PUTting merged result. This prevents
  theme and terminal stores from clobbering each other's sections.
- **Appearance settings still store per-mode theme IDs**:
  `lightTheme`/`darkTheme` remain in settings even though only built-in
  Hubris themes are selectable right now. Theme store init coerces
  legacy or unknown IDs back to `hubris-light` / `hubris-dark` and
  persists that correction when the server is reachable.
- **Bundled fonts**: 16 woff2 files in `frontend/public/fonts/`,
  downloaded via `mise run download:fonts`. Committed to git. Fonts
  are loaded on-demand via dynamic @font-face when user selects a
  bundled font.
- **Project paths are canonicalized to Git local root**: `POST /api/projects`
  resolves input paths through Git and stores the canonical local root.
  On macOS this often normalizes `/tmp/...` to `/private/tmp/...`.
- **Removing a project is now destructive for linked worktrees**:
  `DELETE /api/projects/:id` deletes all non-local worktrees first.
  If any worktree is dirty/busy, the request returns `409` unless
  `?force=true` is supplied.
- **Git remote HEAD aliases with `%(refname:short)` are lossy**:
  `refs/remotes/origin/HEAD` becomes `origin` when formatted as short.
  To reliably filter remote HEAD aliases, inspect full refname
  (`%(refname)`) and only use short names for display.
- **Rust integration tests should disable Git commit signing**:
  local/global Git config may enforce GPG signing and break ephemeral
  test-repo commits (for example with `Cannot allocate memory` from gpg).
  In test helpers that run `git commit`, pass
  `-c commit.gpgsign=false`.
- **Sidebar component tests pull in theme store transitively**:
  importing `AppSidebar.svelte` transitively imports `SidebarDialogs` →
  `AddWorktreeDialog`, which imports theme stores that read
  `window.matchMedia` at module eval time. In jsdom tests, either mock
  `matchMedia` before importing sidebar components or test lower-level
  stores/state instead.
- **Terminal tabs stay websocket-attached while hidden**:
  `WorktreeView.svelte` keeps inactive `TerminalTab` components mounted and
  just toggles `hidden`, so terminal/PTY sizing logic must explicitly ignore
  hidden tabs instead of assuming one visible tab equals one connected client.
- **Sidebar resize ownership**: Keep sidebar resize customization in
  app-level files (store/handle/CSS) instead of `components/ui/sidebar/*`
  so shadcn sidebar upgrades remain mostly copy-merge operations.
- **`ts-rs` warns on some serde field attributes**:
  with `ts-rs` + `serde-compat`, attributes like
  `skip_serializing_if = "Option::is_none"` may emit warnings during
  `cargo check`/`clippy`. The generated types still build; warnings are
  expected unless those fields are modeled with `#[ts(optional)]` or
  custom TS field types.
- **`ts-rs` v12 changed codegen API**:
  `TS::export_to_string()` now requires a `ts_rs::Config` argument
  (for example `TS::export_to_string(&Config::from_env())`), so
  `generate_contracts`-style binaries must pass config explicitly.
- **Dev task wrapper sets shared instance env only**:
  `.mise/tasks/dev` generates random `HUBRIS_DEV_ID`, sets
  `HUBRIS_DEV_TMP`, and runs backend/frontend tasks in parallel.
- **Backend hot reload uses random socket activation port**:
  `dev:server` runs `systemfd --no-pid -s http::0 -- mise watch --restart
  dev:server:raw`.
- **Backend watch sources live on hidden raw task**:
  `dev:server:raw` is hidden and owns Rust file `sources` globs used by
  `mise watch`.
- **`systemfd` tool source is GitHub backend in mise**:
  use `"github:mitsuhiko/systemfd" = "latest"` in `[tools]`.
- **Stable-port reload requires socket activation in backend**:
  server startup must check inherited fd0 via `listenfd` before using
  dev fallback port binding.
- **Rust lockfile updates may require targeted `--precise` bumps**:
  `cargo update --workspace` can leave some crates behind even when newer
  compatible versions exist. Use `cargo update -p <crate>@<old> --precise <new>`
  for targeted bumps. Some transitive crates (for example `matchit` via `axum`
  and `generic-array` via `crypto-common`) may be hard-pinned upstream and
  therefore non-upgradable until parent deps move.
