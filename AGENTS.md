# Hubris

Terminal-based project manager: Rust/Axum backend with PTY sessions,
Svelte 5 frontend with xterm.js.

## Build & Check

```sh
make build          # frontend + server (release)
make check          # cargo check + svelte-check + tsc
cd frontend && bun run test   # vitest
cd crates/server && cargo test  # integration tests
```

Package managers: Cargo (backend), bun (frontend).

## Domain Concepts

- **Project** — a directory the user registers; stored in a JSON file.
- **Tab** — a terminal session within a project view. Type field is
  extensible but currently only "terminal".
- **PTY session** — ephemeral, spawned on WebSocket connect, dies on
  disconnect. Not persisted.

## Backend (Rust / Axum)

- State: `AppState` with DashMap for sessions, PathBuf for data dir.
- Data persistence: JSON file. Dev: `./data/`, prod: `~/.hubris/`.
- WebSocket protocol: binary output (PTY → client), JSON control
  messages (client → server, e.g. `type: "resize"`).
- PTY spawning: portable-pty, shell from `$SHELL` or `/bin/sh`.
- Server port: 3001.

## Frontend (Svelte 5 / Vite / Tailwind v4)

- State: Svelte runes (`$state`, `$effect`), store factory pattern
  — grep for `getProjectStore`, `getTabStore`.
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
