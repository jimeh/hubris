# Hubris

Terminal-based project manager: Rust/Axum backend with a React/Vite frontend and
persistent PTY sessions.

## Build & Run

```sh
mise run setup     # install all deps
mise run dev       # backend + web dev servers
mise run dev:desktop  # Electron desktop app in dev mode
mise run build:desktop  # Electron desktop app bundle
mise run build:desktop:macos-arm64  # target-specific desktop bundle
mise run build:server:linux-x64  # target-specific standalone server binary
mise run check     # format check + lint + type check (all)
mise run format    # auto-format all code
mise run test      # web tests + cargo test
mise run generate  # run all code generators
```

Sub-tasks: `check:backend`, `check:web`, `format:backend`, `format:web`. `lint`
is an alias for `check`.

Tools: mise (see `mise.toml`). Packages: Cargo (backend), **bun** (frontend).

**IMPORTANT: Always run `mise run check` before committing or opening PRs.** CI
runs the same checks — format (`cargo fmt`, `prettier`), lint (`clippy`,
`eslint`), and type check (`tsc`).

**IMPORTANT: The frontend uses bun, NOT npm or pnpm.** All frontend commands
must use `bun`. Install dependencies from the repo root with `bun install`, and
run web scripts with `bun run --filter hubris-web ...`. The Bun workspace
manifest and `bun.lock` live at the repo root; there is no `package-lock.json`
or `pnpm-lock.yaml`.

**IMPORTANT: The backend SQLite state DB uses `sqlx` offline metadata.** After
changing backend SQL queries or `apps/server/migrations/`, run
`mise run sqlx:prepare` and commit the resulting `.sqlx/` metadata. Backend
checks enforce this through `mise run check:backend`.

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

## Discoveries

- Keep TypeScript pinned to 5.9.x for now. The workspace shares one TypeScript
  version across `apps/web` and `apps/desktop`, and `openapi-typescript@7.13.0`
  still declares a `^5.x` TypeScript peer.
- `code-server` release handling needs two HTTP client modes: `/releases/latest`
  must disable redirects so version parsing can read the `Location` header, but
  release asset downloads must follow redirects or the extractor will read
  GitHub's redirect response instead of the tarball.
- In Unix process-management tests, shell redirection can create a PID/ready
  file before the shell writes content. Poll for non-empty file contents rather
  than mere file existence to avoid CI flakes.
- `docker:test` should install only the tools it actually needs in image layers:
  global `bun` via `mise` and a prebuilt `sccache` binary, with the base Rust
  image providing `cargo`/`rustc`. Using `mise` for `sccache` hits GitHub API
  rate limits in Docker builds. Persist project dependency state in named Docker
  volumes for `CARGO_HOME`, `CARGO_TARGET_DIR`, `SCCACHE_DIR`, Bun cache, and
  root `node_modules`.
- Run `docker:test` containers as the host UID/GID after bootstrapping cache
  volume ownership. Running the Linux test suite as `root` hides permission
  failures and can invalidate filesystem-behavior tests.
- Trust the Docker workspace by adding `/work` to `mise` `trusted_config_paths`;
  that removes the need for per-run `mise trust` commands in the container
  entrypoint.
- Keep the Docker entrypoint minimal. For `docker:test`, it only needs cache
  ownership bootstrap plus a plain `bun install --frozen-lockfile` before the
  default `mise run test` command so a fresh root `node_modules` volume is
  populated.
- `apps/server/tests/terminal_ws.rs` needs a deterministic shell wrapper under a
  shared test mutex. Real interactive shells can emit prompt/redraw bytes on
  attach or resize, which makes PTY snapshot assertions flaky on Linux and
  inside Docker.
- Electron desktop packaging writes host-platform bundles to the repo-root
  `dist/` directory via Forge `outDir`, while transient desktop build artifacts
  under `apps/desktop/` (`node_modules`, `.vite`) stay ignored locally.
- Electron desktop browser storage only survives restarts when the window uses a
  `persist:` partition and `app.setPath("userData"/"sessionData", ...)` is set
  before `app.whenReady()`. Keep `sessionData` under the shared native
  `Hubris/sessionData` root and isolate dev/release with separate `persist:`
  partition names.
- Packaged Electron must keep a stable renderer origin without relying on a
  fixed loopback port. Hubris now uses a handled
  `https://desktop.internal.hubris.build` origin: Electron serves bundled
  frontend assets on that origin, proxies `/api` and `/_hubris` to the loopback
  Rust backend, redeems the one-time desktop bootstrap token itself, and seeds
  cookies into the `https://desktop.internal.hubris.build` session jar.
- Desktop no longer routes `/code` through Hubris’ Rust reverse proxy. Electron
  resolves the live code-server upstream via the authenticated
  `/_hubris/code-server/connection` endpoint, proxies `/code/*` directly, and
  bridges same-origin WebSockets for code-server, terminal I/O, and Vite HMR in
  preload/main-process code instead of rewriting browser-visible loopback URLs.
- Electron desktop startup should only register the macOS `activate` handler
  after the initial `whenReady()` bootstrap finishes, or guard window creation
  with a single-flight helper. Registering `activate` too early can race the
  first async window/runtime startup and spawn duplicate packaged runtimes.
- Electron desktop now stays alive after the last window closes on all
  platforms. Keep shutdown tied to explicit app quit paths, and use the
  single-instance `second-instance` flow plus macOS `activate` to reopen or
  recreate the main window without reinitializing backend/protocol state.
- Desktop browser tabs must keep their `WebContentsView` lifecycle keyed to the
  Hubris tab ID, not the current URL. Recreating the view on every URL/state
  sync wipes browser history and defeats fast tab switching.
- Desktop browser tabs should only destroy their `WebContentsView` on explicit
  browser-tab close or full app quit. Renderer reloads and main-window
  close/reopen need to detach and later reattach the existing views so Chromium
  history survives within the running app session.
- Web-mode browser tabs are direct iframes only. Do not add same-origin proxy
  routing for localhost previews; that path breaks dev/release frontend behavior
  and still cannot make arbitrary external sites embeddable.
- Browser-tab iframe `onLoad` handlers should only clear loading/error state
  when Hubris is actively waiting on a navigation. The initial `about:blank`
  load can otherwise race and wipe renderer-owned validation errors.
- Linux-only Rust paths still compile in CI even when local macOS checks look
  clean. Keep `#[cfg(target_os = "linux")]` helpers self-contained with their
  Linux-only imports and concrete type paths, especially around
  `tokio::process::Command` and `CommandExt`.
- Cross-target Rust builds now use `cargo zigbuild` for Linux targets and plain
  `cargo build --target` for macOS targets. Off-macOS `*-apple-darwin` builds
  still require `SDKROOT` plus the matching `CARGO_TARGET_<TRIPLE>_LINKER`
  environment variable, while desktop packaging consumes explicit cross-built
  runtimes through `HUBRIS_DESKTOP_RUNTIME_PATH`.
- Linux desktop packaging is intentionally disabled for now. Keep cross-platform
  desktop work focused on macOS zip builds, while `hubris-server` continues to
  support Linux and macOS cross-build targets.
- Sidebar row components used with Radix `asChild` wrappers must forward generic
  HTML props like `className` and `onContextMenu` to their root DOM node.
  Otherwise `SidebarMenuButton`/`ContextMenuTrigger` props stop at the custom
  component boundary and row-level context menus never open.
- The official VS Code CLI install path uses the same managed-process stop
  semantics as `code-server`: once the runtime state is set to `Installing`, the
  install task must not call a stop helper that waits for installs to finish, or
  it deadlocks itself and the UI sits forever at the initial 5% preparing state.
- `code serve-web` can reject stale `vscode-tkn` cookies with a plain
  `403 Forbidden` after the runtime restarts and rotates its connection token.
  In Hubris proxies, only treat a cookie/query token as valid when it matches
  the current runtime token; otherwise upsert the current `?tkn=` so the browser
  can mint a fresh cookie.
- Electron/Node `fetch()` ignores a custom `Host` header. Desktop VS Code
  runtime hosts therefore cannot proxy directly to the loopback runtime if the
  upstream must see the public runtime host/origin; send desktop runtime traffic
  through Hubris' Rust `/code/<runtime>` proxy and pass the public runtime
  identity in explicit override headers instead.
- Electron desktop dev should refresh backend/frontend loopback targets from the
  shared `tmp/dev-<id>.*.json` files instead of assuming the first discovered
  ports stay valid for the whole app session. Retrying proxied desktop dev
  fetches once after refreshing those targets smooths over backend/frontend
  restarts and avoids raw `fetch failed` noise in Electron.
- Electron emits `will-frame-navigate` at runtime, but the current desktop
  TypeScript typings do not expose that event on `WebContents`. Keep subframe
  navigation guards behind a narrow typed cast instead of assuming the event is
  unavailable.
- Electron navigation events (`will-navigate`, `will-frame-navigate`,
  `will-redirect`) must call `details.preventDefault()` on the original event
  object. Destructuring `preventDefault` and invoking it unbound can crash the
  desktop main process with `TypeError: Illegal invocation`.
- Desktop VS Code worktrees now run in their own `WebContentsView` with a
  dedicated preload that installs the WebSocket bridge in the page world. Keep
  the VS Code proxy HTML pass-through; do not reintroduce VS Code-specific HTML
  rewriting in `apps/desktop/src/protocol.ts`.
- The main Hubris desktop window no longer relies on protocol HTML injection
  either. Desktop runtime config and websocket patching now come from preload
  `executeInMainWorld(...)` bootstrap, so frontend HTML should pass through
  unchanged in both dev and packaged desktop modes.
- Task-backed VS Code install APIs snapshot status immediately after enqueueing
  work. In fast tests or CI, that snapshot can still be `Stopped` or already be
  terminal even though install progress events were emitted correctly; assert on
  the event stream or eventual state instead of assuming an intermediate
  `Installing` snapshot.
- Worktree split panes must keep terminal, browser, and Monaco-backed tab scenes
  mounted in a worktree-level host. Reparenting those heavy tabs inside pane
  subtrees causes terminal websocket reconnects, browser view churn, and blank
  split panes during layout transitions.
- The split-pane scene host should keep heavy tab scenes in a stable host order
  independent of tab-strip reorders. Reordering Monaco-backed scenes in the DOM
  can trigger editor lifecycle crashes during drag/drop even when tab identity
  is otherwise stable.
- Git status views should not key rows by bare `path` alone. The same path can
  appear more than once in a rendered section/tree, so React keys need section
  or index context to avoid duplicate-key crashes.

<!-- gitnexus:start -->

# GitNexus — Code Intelligence

This project is indexed by GitNexus as **hubris** (7422 symbols, 16951
relationships, 300 execution flows). Use the GitNexus MCP tools to understand
code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in
> terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a
  function, class, or method, run
  `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report
  the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your
  changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before
  proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to
  find execution flows instead of grepping. It returns process-grouped results
  ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which
  execution flows it participates in — use
  `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows
   related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees,
   and process participation
3. `READ gitnexus://repo/hubris/process/{processName}` — trace the full
   execution flow step by step
4. For regressions:
   `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what
   your branch changed

## When Refactoring

- **Renaming**: MUST use
  `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first.
  Review the preview — graph edits are safe, text_search edits need manual
  review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see
  all incoming/outgoing refs, then
  `gitnexus_impact({target: "target", direction: "upstream"})` to find all
  external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify
  only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running
  `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which
  understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check
  affected scope.

## Tools Quick Reference

| Tool             | When to use                   | Command                                                                 |
| ---------------- | ----------------------------- | ----------------------------------------------------------------------- |
| `query`          | Find code by concept          | `gitnexus_query({query: "auth validation"})`                            |
| `context`        | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})`                              |
| `impact`         | Blast radius before editing   | `gitnexus_impact({target: "X", direction: "upstream"})`                 |
| `detect_changes` | Pre-commit scope check        | `gitnexus_detect_changes({scope: "staged"})`                            |
| `rename`         | Safe multi-file rename        | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher`         | Custom graph queries          | `gitnexus_cypher({query: "MATCH ..."})`                                 |

## Impact Risk Levels

| Depth | Meaning                               | Action                |
| ----- | ------------------------------------- | --------------------- |
| d=1   | WILL BREAK — direct callers/importers | MUST update these     |
| d=2   | LIKELY AFFECTED — indirect deps       | Should test           |
| d=3   | MAY NEED TESTING — transitive         | Test if critical path |

## Resources

| Resource                                | Use for                                  |
| --------------------------------------- | ---------------------------------------- |
| `gitnexus://repo/hubris/context`        | Codebase overview, check index freshness |
| `gitnexus://repo/hubris/clusters`       | All functional areas                     |
| `gitnexus://repo/hubris/processes`      | All execution flows                      |
| `gitnexus://repo/hubris/process/{name}` | Step-by-step execution trace             |

## Self-Check Before Finishing

Before completing any code modification task, verify:

1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze
to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding
`--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the
`stats.embeddings` field shows the count (0 means no embeddings). **Running
analyze without `--embeddings` will delete any previously generated
embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after
> `git commit` and `git merge`.

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
