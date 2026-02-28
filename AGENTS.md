# Hubris

Terminal-based project manager: Rust/Axum backend with PTY sessions,
Svelte 5 frontend with xterm.js.

## Build & Check

```sh
mise run setup          # install all dependencies
mise run dev            # backend + frontend dev servers (parallel)
mise run build          # frontend + server (release)
mise run check          # cargo check + svelte-check + tsc
mise run test           # all tests (vitest + cargo test)
```

Tool versions managed by mise (see `mise.toml`).
Package managers: Cargo (backend), bun (frontend).

## Domain Concepts

- **Project** — a directory the user registers; stored in a JSON file.
- **Session** — logical grouping of tabs. Currently hardcoded to
  "default"; designed for future multi-session support.
- **Tab** — a terminal session within a project, scoped to a session.
  Server-authoritative (CRUD via REST). Type field is extensible but
  currently only "terminal".
- **LiveTab** — server-side persistent PTY container. Survives WS
  disconnects. Has 128KB scrollback ring buffer and broadcast channel
  for output fan-out. Killed only on explicit tab close or shell exit.

## Backend (Rust / Axum)

- State: `AppState` with `DashMap<TabId, Arc<LiveTab>>` for tabs,
  `Arc<EventBus>` for SSE, PathBuf for data dir.
- Data persistence: JSON file. Dev: `./data/`, prod: `~/.hubris/`.
- WebSocket protocol: binary output (PTY → client), JSON control
  messages (client → server, e.g. `type: "resize"`). WS attaches to
  existing LiveTab; does NOT kill PTY on disconnect.
- PTY spawning: portable-pty, shell from `$SHELL` or `/bin/sh`.
- SSE state sync: `GET /api/events?session_id=...` sends snapshot on
  connect, then incremental tab_created/tab_closed/tab_updated events.
  EventBus uses `tokio::sync::broadcast` (capacity 256).
- Tab CRUD: `GET/POST /api/tabs`, `DELETE/PATCH /api/tabs/{id}`.
  Tab positions use f64 for fractional ordering.
- Server port: 3001.

## Frontend (Svelte 5 / Vite / Tailwind v4)

- State: Svelte runes (`$state`, `$effect`), store factory pattern
  — grep for `getProjectStore`, `getTabStore`.
- SSE client: `EventClient` singleton — grep for `getEventClient`,
  `events.ts`. Handlers must be registered before `connect()` is
  called (snapshot fires immediately on connect).
- Tab store is server-backed: REST for mutations, SSE for sync.
  Optimistic updates with SSE dedup guards.
- UI primitives: shadcn-svelte (Bits UI) — grep for `components/ui/`.
- Terminal: `TerminalAdapter` interface with xterm.js impl — grep
  for `TerminalAdapter`, `XtermAdapter`.
- API client: centralized fetch wrapper — grep for `api.ts`.
- Theme: Catppuccin colors via Tailwind, defined in `app.css`.
- Dev server: port 5173, proxies `/api` to backend.

## Conventions

- Conventional commits (`feat:`, `fix:`, `refactor:`).
- Frontend components: PascalCase `.svelte` files.
- Frontend stores: camelCase `.svelte.ts` files using runes.
- Tests colocated with source (`.test.ts` alongside `.ts`).
