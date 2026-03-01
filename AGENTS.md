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

- **Project** — user-registered directory; persisted in JSON file.
- **Session** — logical tab grouping. Hardcoded "default" for now,
  designed for multi-session later.
- **Tab** — server-authoritative terminal within a project+session.
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
- WS protocol: binary (PTY output), JSON control (`type: "resize"`,
  `type: "attached"` with `byte_offset`/`data_lost`)
- SSE events: snapshot, tab_created, tab_closed, tab_updated,
  project_added, project_removed, project_updated

### Frontend (Svelte 5 / Vite / Tailwind v4)
- Stores: rune-based singletons — grep `getProjectStore`, `getTabStore`,
  `getThemeStore`, `getTerminalStore`
- SSE client: singleton — grep `getEventClient`
- Tab store: REST mutations + SSE sync with optimistic updates.
  Active tab and per-project tab selection persisted to localStorage.
- Project store: SSE-driven (snapshot + incremental events), optimistic
  mutations. Drag-and-drop reorder via svelte-dnd-action.
- UI primitives: shadcn-svelte (Bits UI) — grep `components/ui/`
- Terminal: adapter pattern — grep `TerminalAdapter`, `XtermAdapter`.
  Font registry in `terminal/fonts.ts` (bundled Nerd Fonts, dynamic
  @font-face injection). Terminal settings store manages font source
  (default/system/bundled), font family, and font size.
- Theme engine: VS Code color theme format, culori hex→OKLCH conversion.
  Built-in Catppuccin themes in `theme/builtin.ts`, converter in
  `theme/convert.ts`, parser in `theme/parse.ts`. Settings + user themes
  persisted via REST (`/api/settings`, `/api/themes`).
  `GET /api/themes` returns metadata only; full theme fetched lazily via
  `GET /api/themes/:id` on selection.
- Project store: selected project persisted to localStorage
  (`hubris-selected-project`), restored on page load.
- FOUC prevention: inline script in `index.html` reads localStorage
  (`hubris-theme-cache`) and applies full CSS vars before first paint.
- Codegen: `defaults.generated.css` generated from builtin themes via
  `mise run generate`. Committed to git; CI verifies via `git diff`.
- Dev proxy: port 3001 proxies `/api` → backend 3101

## Conventions

- Conventional commits (`feat:`, `fix:`, `refactor:`)
- Frontend: PascalCase `.svelte`, camelCase `.svelte.ts` stores
- Tests colocated (`.test.ts` alongside `.ts`, `tests/` for Rust)
- Rust edition 2024, `style_edition = "2024"` in rustfmt.toml

## Gotchas

- **SSE init ordering**: All store handlers must be registered before
  `EventClient.connect()` — snapshot fires immediately on connect.
  In App.svelte: call `getProjectStore()` and `getTabStore()` before
  `events.connect()`.
- **rustfmt style_edition 2024**: Formats more aggressively than
  default (collapses single-line signatures, method chains). Always
  run `cargo fmt` after edits.
- **Position fields**: Both Tab and Project use f64 for fractional
  ordering (midpoint insertion between neighbors).
- **svelte-dnd-action + button elements**: The library's mousedown
  guard rejects nested elements with a `value` property (buttons,
  inputs). Use the `child` snippet on `Sidebar.MenuButton` to render
  a `<div>` instead of `<button>` inside draggable containers.
- **deleteTab tolerates 404**: Tab may already be gone (shell exit,
  other browser).
- **shadcn-svelte Select wrapper**: The default `select.svelte` from
  shadcn-svelte destructures `value`/`open` with `$bindable` and
  re-passes via `bind:`. This breaks the bits-ui `type` discriminant
  (single vs multiple), causing string values to be iterated as char
  arrays. The workaround is a simple passthrough: `{...restProps}`.
  If reinstalling shadcn components, reapply this fix.
- **Settings sync**: No SSE event for settings changes yet. Multiple
  open browsers won't see each other's settings changes (theme,
  terminal font) until reload.
- **Settings save is read-modify-write**: `saveSettings` in `api.ts`
  GETs current settings before PUTting merged result. This prevents
  theme and terminal stores from clobbering each other's sections.
- **Bundled fonts**: 16 woff2 files in `frontend/public/fonts/`,
  downloaded via `mise run download:fonts`. Committed to git. Fonts
  are loaded on-demand via dynamic @font-face when user selects a
  bundled font.
