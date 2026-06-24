# Hubris

Terminal-based project manager: Rust/Axum backend with a React/Vite frontend and
persistent PTY sessions.

Use this file as the root map. Load the linked docs when a task touches that
area instead of treating this file as the whole project manual.

## Build & Run

```sh
mise run setup     # install all deps
mise run dev       # server + web dev processes via portless URL
mise run dev:raw   # server + web dev processes without portless
mise run dev:desktop  # Electron desktop app in dev mode
mise run build:desktop  # Electron desktop app bundle
mise run build:desktop:macos-arm64  # target-specific desktop bundle
mise run build:server:linux-x64  # target-specific standalone server binary
mise run check     # format check + lint + type check (all)
mise run format    # auto-format all code
mise run test      # web tests + cargo test
mise run generate  # run all code generators
mise run hooks:install  # install Husky-managed pre-commit checks
```

Sub-tasks: `check:server`, `check:web`, `format:server`, `format:web`. `lint` is
an alias for `check`.

Tools: mise (see `mise.toml`). Packages: Cargo (backend), **bun** (frontend).

**IMPORTANT: Always run `mise run check` before committing or opening PRs.** CI
runs the same checks — format (`cargo fmt`, `prettier`), lint (`clippy`,
`eslint`), and type check (`tsc`). `mise run setup` installs Husky-managed Git
hooks, and the pre-commit hook runs lint-staged checks against staged files. Use
`HUBRIS_PRECOMMIT_FULL=1 git commit ...` to force the full check lane from the
hook, or Git's `--no-verify` only when you have already run the relevant checks
manually.

**IMPORTANT: The frontend uses bun, NOT npm or pnpm.** All frontend commands
must use `bun`. Install dependencies from the repo root with `bun install`, and
run web scripts with `bun run --filter hubris-web ...`. The Bun workspace
manifest and `bun.lock` live at the repo root; there is no `package-lock.json`
or `pnpm-lock.yaml`.

**IMPORTANT: Desktop packaging currently avoids Node 24.16+.** With Node
24.16.0, Electron Packager 18.4.4 can exit successfully during Electron template
extraction before creating `dist/`. Node 24.15.0 has been verified for
`mise run build:desktop`; keep the mise Node pin there until the packaging
toolchain is upgraded and verified.

**IMPORTANT: Do not put `sources` on long-running dev tasks.** Current mise uses
`sources` as a run cache gate, so `mise run dev:server:raw` can print
`sources up-to-date, skipping` instead of launching the server. Put file watch
filters on the watcher task instead.

**IMPORTANT: The backend SQLite state DB uses `sqlx` offline metadata.** After
changing backend SQL queries or `apps/server/migrations/`, run
`mise run sqlx:prepare` and commit the resulting `.sqlx/` metadata. Backend
checks enforce this through `mise run check:server`.

## Domain Concepts

- **Project** — user-registered git repository; path canonicalized to git local
  root on add. Persisted in JSON file.
- **Worktree** — git worktree within a project. The "local" worktree is the
  project's own directory; others are created via `git worktree add`. IDs are
  deterministic UUIDv5 from path.
- **Session** — logical tab grouping. Hardcoded "default" for now, designed for
  multi-session later.
- **Tab** — server-authoritative terminal within a worktree+session. CRUD via
  REST, state sync via SSE. Type field extensible.
- **LiveTab** — server-side persistent PTY. Survives WS disconnects. Killed only
  on explicit close or shell exit.

## Conventions

- Conventional commits (`feat:`, `fix:`, `refactor:`)
- Frontend: PascalCase `.tsx`
- Tests colocated (`.test.ts` / `.test.tsx`), `tests/` for Rust
- Rust edition 2024, `style_edition = "2024"` in `rustfmt.toml`
- React app imports should use `@/lib/...`, `@/components/...`, and
  `@/hooks/...`; do not introduce `$lib/...`
- **Avoid `useEffect` unless it is clearly necessary**: prefer deriving UI
  directly from Zustand or React state instead of using effects for
  orchestration, prop syncing, or data flow. Valid exceptions are: unavoidable
  external synchronization, timer/debounced presentation logic, or
  performance-sensitive imperative paths where state-driven rerenders cause
  visible lag (for example sidebar resize width writes).

## Architecture Highlights

- **Frontend/backend comms use four main surfaces**: REST for command/query APIs
  under `/api/...`, one global SSE stream at `/api/events` for app-wide state
  sync, PTY WebSockets for terminal I/O, and the `/code` reverse proxy for the
  shared VS Code surface.
- **State sync uses one global SSE stream**: server state is modeled as
  snapshot-on-connect plus incremental events. Prefer extending the existing
  `/api/events` snapshot/event model for new app-wide state instead of adding
  polling loops or section-local refresh logic.
- **Use REST for actions, SSE for ongoing shared state**: start with REST for
  discrete mutations and fetches; if the frontend needs live status after that,
  feed it through the existing SSE snapshot + event model instead of polling.
- **Frontend stores must be ready before SSE connects**: initialize all Zustand
  stores and event handlers in `apps/web/src/lib/bootstrap.ts` before calling
  `EventClient.connect()`. The snapshot is delivered immediately on connect.
- **Use Zustand singletons for shared frontend state**: app-wide state should
  live in a dedicated store under `apps/web/src/lib/stores/`, seeded from SSE
  snapshot data and updated by incremental events.
- **Terminal transport is special-case WebSocket I/O**: terminal bytes and
  resize/control messages do not go through REST or SSE. Reuse the existing PTY
  WS model for terminal behavior instead of inventing parallel channels.
- **Contracts are generated, not handwritten**: backend API/SSE/WS schema
  changes should flow through `mise run generate` so frontend contract files in
  `apps/web/src/lib/contracts/` stay authoritative.
- **Keep settings UI thin**: `SettingsDialog` is a shell. Feature logic belongs
  in focused components under `apps/web/src/components/settings-dialog/`, with
  backend-authoritative state coming from stores/contracts rather than ad hoc
  local orchestration.
- **Codex chat is protocol-normalized before UI rendering**: when changing Codex
  chat/app-server behavior, use
  `docs/agents/codex-app-server-GUI-best-practices.md` as the protocol and UI
  normalization reference. Do not render raw JSON-RPC events directly into the
  timeline.
- **Codex chat history is branch-scoped**: conversations are retained by
  `session_id + project_id + branch_name`, not by a single worktree. Worktree
  deletion must preserve chats; project deletion hard-deletes project chat data.
  Archived chats are read-only until unarchived.

## Detail Docs

- [Architecture](docs/agents/architecture.md) — connection model, state sync,
  backend/frontend overview
- [Backend](docs/agents/backend.md) — async rules, settings TOML, git2, PTY,
  worktree ops, file watchers
- [Frontend](docs/agents/frontend.md) — React/Zustand, shadcn, sidebar, settings
  store, terminal, Monaco, explorer
- [Testing](docs/agents/testing.md) — Vitest/jsdom, mock patterns, test
  organization, Rust tests
- [Desktop](docs/agents/desktop.md) — Electron build, dev workflow, auth
- [Dev Environment](docs/agents/dev-environment.md) — mise tasks, hot reload,
  socket activation
- [Codex App Server GUI Best Practices](docs/agents/codex-app-server-GUI-best-practices.md)
  — Codex `app-server` JSON-RPC normalization, chat UI state, server requests,
  tool activity, reasoning, and replay guidance
- [Codex App Server Lifecycle Best Practices](docs/agents/codex-app-server-lifecycle-best-practices.md)
  — host-scoped app-server lifecycle, thread unsubscribe/resume, stream
  ownership, and crash/restart behavior
- [Codex Chat GUI Implementation Plan](docs/agents/codex-chat-gui-implementation-plan.md)
  — phased roadmap for closing current Codex chat gaps across backend
  normalization, persistence, SSE, frontend stores, and timeline UI
- [Discoveries](docs/agents/discoveries.md) — accumulated project gotchas and
  non-obvious findings

<!-- gitnexus:start -->

# GitNexus — Code Intelligence

This project is indexed by GitNexus as **hubris**. Use the GitNexus MCP tools to
understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it
> auto-selects an available runner. No `.gitnexus/run.cjs` yet?
> `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a
  function, class, or method, run
  `impact({target: "symbolName", direction: "upstream"})` and report the blast
  radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only
  affect expected symbols and execution flows. For regression review, compare
  against the default branch:
  `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before
  proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find
  execution flows instead of grepping. It returns process-grouped results ranked
  by relevance.
- When you need full context on a specific symbol — callers, callees, which
  execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings
  (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands
  the call graph.
- NEVER commit changes without running `detect_changes()` to check affected
  scope.

## Resources

| Resource                                | Use for                                  |
| --------------------------------------- | ---------------------------------------- |
| `gitnexus://repo/hubris/context`        | Codebase overview, check index freshness |
| `gitnexus://repo/hubris/clusters`       | All functional areas                     |
| `gitnexus://repo/hubris/processes`      | All execution flows                      |
| `gitnexus://repo/hubris/process/{name}` | Step-by-step execution trace             |

## CLI

| Task                                         | Read this skill file                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md`       |
| Blast radius / "What breaks if I change X?"  | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?"             | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md`       |
| Rename / extract / split / refactor          | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md`     |
| Tools, resources, schema reference           | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md`           |
| Index, status, clean, wiki CLI commands      | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md`             |

<!-- gitnexus:end -->
