# Discoveries

Non-obvious findings discovered during implementation and debugging. Add here
when a detail is stable enough to help future agents avoid repeated mistakes,
but too specific for the root `AGENTS.md` map.

- Keep TypeScript pinned to 5.9.x for now. The workspace shares one TypeScript
  version across `apps/web` and `apps/desktop`, and `openapi-typescript@7.13.0`
  still declares a `^5.x` TypeScript peer.
- Keep `eslint-plugin-react-hooks` pinned to `7.0.1` until existing frontend
  patterns are cleaned up. `7.1.1` enables stricter ref/effect rules that fail
  current web lint in unrelated components.
- Keep `material-icon-theme` pinned at `5.33.1` until its dependency graph is
  reviewed. Updating to `5.35.0` pulls old `biome`/`request` transitives and
  adds critical Bun audit findings.
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
- Desktop no longer routes `/code` through Hubris' Rust reverse proxy. Electron
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
- Codex chat UI work should start from
  `docs/agents/codex-app-server-GUI-best-practices.md`. Keep Hubris-owned
  conversation state separate from raw app-server JSON-RPC messages, normalize
  protocol events into app events first, and treat server requests as pending UI
  actions that must receive exactly one response.
- Codex app-server should be host-scoped, not chat-scoped. Use
  `docs/agents/codex-app-server-lifecycle-best-practices.md` before changing
  runtime lifecycle: keep one initialized app-server process alive for the host
  session, manage idle chats with `thread/unsubscribe`, and resume them with
  `thread/resume`.
- Zustand selectors used through `useSyncExternalStore` consumers must return
  stable references. Derive filtered/sorted chat sidebar lists outside the
  selector or memoize them, or React can hit the "getSnapshot should be cached"
  infinite-update failure.
- The assistant-ui chat tab viewport must be a flex column with the transcript
  scroller using `min-h-0 flex-1`. Letting the scroll area claim full height
  pushes the composer off-screen inside Hubris tab panes.
- Codex `app-server` `turn/start` expects `input` to be an array of input items,
  not a single object. Sending a lone map produces
  `invalid type: map, expected a sequence`.
- Codex `app-server` uses different sandbox shapes for thread and turn APIs.
  `thread/start` and `thread/resume` take `sandbox: "danger-full-access"` style
  string enums, while `turn/start` takes object-shaped `sandboxPolicy` values
  like `{ type: "dangerFullAccess" }`.
- Codex `app-server` server-initiated JSON-RPC requests carry both `id` and
  `method`. Do not classify every message with `id` as a response, or Hubris
  will drop approval/input requests and leave turns in confusing failed states.
- A plain `cargo build`/`cargo test` overwrites `target/debug/hubris-server`
  WITHOUT the `embed-frontend` feature, silently breaking
  `HUBRIS_E2E_SKIP_BUILD=1 mise run test:e2e:real` reuse. The e2e globalSetup
  fails fast with a rebuild hint when it detects this; rebuild with
  `cargo build --bin hubris-server --features embed-frontend`.
- Sandboxed agent runs can poison the shared sccache daemon: a client that
  cannot reach the server auto-spawns a sandboxed daemon on port 4226 that
  cannot exec rustc, and every later build fails with
  `sccache: error: Operation not permitted`. Fix: `pkill -9 sccache`, then start
  one clean daemon from an unsandboxed shell
  (`SCCACHE_IDLE_TIMEOUT=0 sccache --start-server`); or bypass per-command with
  `RUSTC_WRAPPER=""`.
- Tokio tests with exactly one `Notify` waiter should use `notify_one()`, which
  retains a permit if the waiter has not registered yet. `notify_waiters()` can
  lose the wake during queued event-dispatch scheduling and make the test time
  out after its observable pre-wait state has already been published.
- `EventBus::subscribe()` attaches to the broadcast side, but events already in
  its MPSC input queue may still arrive afterward. Tests that need a clean event
  boundary should enqueue and consume a non-delta barrier after subscribing.
- An interrupted `bun install` (killed mid-run) can leave the workspace's `.bun`
  store partially linked: `bun run --filter hubris-web build` then fails at
  bundle time with `Rolldown failed to resolve import "vfile" from "unified"`
  (or similar deep-dependency resolution errors) while dev servers and unit
  tests still pass. Heal it by removing every `node_modules` in the affected
  checkout (`rm -rf node_modules apps/*/node_modules`) and re-running
  `bun install` to completion.
- React Compiler was evaluated (2026-07-12, refactor task 6.4) and NOT adopted.
  With `babel-plugin-react-compiler@1.0` wired into the vite react() plugin, all
  713 web unit tests, the smoke lane, the production build, and the real-server
  e2e lane pass, and `eslint-plugin-react-compiler` reports only 7 rule-of-react
  violations app-wide — but they sit on the exact hot paths the compiler was
  meant to help (`WorktreeView.tsx`, `App.tsx`, `CopilotKitAgentChatTab.tsx`,
  `WorktreeAllFilesPanel.tsx`, `ui/sidebar.tsx`, `App.test.tsx`: hooks passed as
  values, writes to variables defined outside the component, and two
  rule-disable skips), so the compiler skips those components and the
  hand-memoization stays load-bearing there. Re-evaluate after fixing those
  violations in the polish phase; the babel pass also slows vitest transforms
  noticeably.
