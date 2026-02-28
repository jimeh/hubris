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
- **Tab** — a persistent terminal attached to a project. Type field is
  extensible but currently only "terminal". Each tab carries a
  `session_id` (always `"default"` for now) for future multi-session
  support.
- **LiveTab** — server-side PTY that outlives WebSocket connections.
  Holds a scrollback buffer, broadcast channel for output fan-out, and
  an internal `close_tx` channel for shell-exit detection. PTY is
  killed on explicit tab deletion, project deletion, or shell process
  exit.
- **StateEvent** — global event enum (`TabCreated`, `TabClosed`)
  broadcast via `events_tx` on `AppState`. All state mutations emit
  events; SSE endpoint streams them to all connected browsers.

## Backend (Rust / Axum)

- State: `AppState` with `DashMap<TabId, Arc<LiveTab>>` for persistent
  PTY tabs, `AtomicU32` for tab label numbering, PathBuf for data dir,
  and `events_tx: broadcast::Sender<StateEvent>` for SSE fan-out.
- `load_projects()` lives on `AppState` (single source of truth).
- Data persistence: JSON file. Dev: `./data/`, prod: `~/.hubris/`.
- Tab REST API: `POST /api/tabs` spawns PTY, `DELETE /api/tabs/{id}`
  kills PTY, `GET /api/tabs` lists all tabs.
- SSE endpoint: `GET /api/events` streams `StateEvent` JSON to all
  connected browsers. Events: `tab_created` (with `TabInfo`),
  `tab_closed` (with `{id}`). Uses `tokio-stream` `BroadcastStream`.
- WebSocket protocol: `GET /api/terminal/ws?tab_id=<id>` attaches to
  an existing tab. Binary output (PTY → client), JSON control messages
  (client → server, e.g. `type: "resize"`). WS disconnect = detach
  only, PTY stays alive. Reconnection replays scrollback buffer.
  Tab lifecycle events (create/close) are handled via SSE, not WS.
- PTY spawning: portable-pty, shell from `$SHELL` or `/bin/sh`.
- Arc<LiveTab> pattern: clone Arc from DashMap before await points to
  avoid holding shard locks across async boundaries.
- Server port: 3001.

## Frontend (Svelte 5 / Vite / Tailwind v4)

- State: Svelte runes (`$state`, `$derived`, `$effect`), store factory
  pattern — grep for `getProjectStore`, `getTabStore`.
- Tab store is API-backed: fetches tabs from server, tracks
  `activeTabByProject` for per-project tab memory on project switch.
  Subscribes to SSE via `EventSource` for real-time cross-browser
  sync (`connectEvents`/`disconnectEvents`).
- UI primitives: shadcn-svelte (Bits UI) — grep for `components/ui/`.
- Terminal: `TerminalAdapter` interface with xterm.js impl — grep
  for `TerminalAdapter`, `XtermAdapter`.
- API client: centralized fetch wrapper — grep for `apiClient` or
  `api.ts`.
- Theme: Catppuccin colors via Tailwind, defined in `app.css`.
- Dev server: port 5173, proxies `/api` to backend.

## Conventions

- Conventional commits (`feat:`, `fix:`, `refactor:`).
- Frontend components: PascalCase `.svelte` files.
- Frontend stores: camelCase `.svelte.ts` files using runes.
- Tests colocated with source (`.test.ts` alongside `.ts`).
