# Hubris

Terminal-based project manager: Rust/Axum backend with persistent PTY
sessions, Svelte 5 frontend with xterm.js.

## Build & Run

```sh
mise run setup    # install all deps
mise run dev      # backend (3001) + frontend (5173) dev servers
mise run check    # cargo check + clippy + svelte-check + tsc
mise run test     # vitest + cargo test
```

Tools: mise (see `mise.toml`). Packages: Cargo (backend), bun (frontend).

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
disconnect.

### State Sync
SSE snapshot on connect, incremental events for changes. EventSource
auto-reconnects; server re-snapshots on reconnect. No periodic
reconciliation — drift corrects on reconnect.

### Backend (Rust / Axum)
- State: grep for `AppState` — DashMap for tabs, EventBus for SSE
- Persistence: JSON file. Dev: `./data/`, prod: `~/.hubris/`
- PTY: portable-pty, shell from `$SHELL` or `/bin/sh`
- WS protocol: binary (PTY output), JSON control (`type: "resize"`)
- SSE events: snapshot, tab_created, tab_closed, tab_updated

### Frontend (Svelte 5 / Vite / Tailwind v4)
- Stores: rune-based singletons — grep `getProjectStore`, `getTabStore`
- SSE client: singleton — grep `getEventClient`
- Tab store: REST mutations + SSE sync with optimistic updates
- UI primitives: shadcn-svelte (Bits UI) — grep `components/ui/`
- Terminal: adapter pattern — grep `TerminalAdapter`, `XtermAdapter`
- Theme: Catppuccin via Tailwind, defined in `app.css`
- Dev proxy: port 5173 proxies `/api` → backend 3001

## Conventions

- Conventional commits (`feat:`, `fix:`, `refactor:`)
- Frontend: PascalCase `.svelte`, camelCase `.svelte.ts` stores
- Tests colocated (`.test.ts` alongside `.ts`, `tests/` for Rust)
- Rust edition 2024, `style_edition = "2024"` in rustfmt.toml

## Gotchas

- **SSE init ordering**: Tab store handlers must be registered before
  `EventClient.connect()` — snapshot fires immediately on connect.
  In App.svelte: call `getTabStore()` before `events.connect()`.
- **rustfmt style_edition 2024**: Formats more aggressively than
  default (collapses single-line signatures, method chains). Always
  run `cargo fmt` after edits.
- **Tab position**: f64 for fractional ordering (midpoint insertion).
- **deleteTab tolerates 404**: Tab may already be gone (shell exit,
  other browser).
