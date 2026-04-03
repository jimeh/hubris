# Hubris

Terminal-based project manager: Rust/Axum backend with a React/Vite
frontend and persistent PTY sessions.

## Build & Run

```sh
mise run setup     # install all deps
mise run dev       # backend + frontend dev servers
mise run dev:desktop  # Tauri desktop app in dev mode
mise run build:desktop  # Tauri desktop app bundle
mise run check     # format check + lint + type check (all)
mise run format    # auto-format all code
mise run test      # frontend tests + cargo test
mise run generate  # run all code generators
```

Sub-tasks: `check:backend`, `check:frontend`, `format:backend`,
`format:frontend`. `lint` is an alias for `check`.

Tools: mise (see `mise.toml`). Packages: Cargo (backend), **bun**
(frontend).

**IMPORTANT: Always run `mise run check` before committing or opening
PRs.** CI runs the same checks — format (`cargo fmt`, `prettier`),
lint (`clippy`, `eslint`), and type check (`tsc`).

**IMPORTANT: The frontend uses bun, NOT npm or pnpm.** All frontend
commands must use `bun` (`bun install`, `bun run test`, `bun run
check`). The `frontend/` directory has a `bun.lock`; there is no
`package-lock.json` or `pnpm-lock.yaml`.

## Domain Concepts

- **Project** — user-registered git repository; path canonicalized to
  git local root on add. Persisted in JSON file.
- **Worktree** — git worktree within a project. The "local" worktree
  is the project's own directory; others are created via `git worktree
  add`. IDs are deterministic UUIDv5 from path.
- **Session** — logical tab grouping. Hardcoded "default" for now,
  designed for multi-session later.
- **Tab** — server-authoritative terminal within a worktree+session.
  CRUD via REST, state sync via SSE. Type field extensible.
- **LiveTab** — server-side persistent PTY. Survives WS disconnects.
  Killed only on explicit close or shell exit.

## Architecture

### Connection Model

One SSE stream (state sync) + N WebSocket connections (PTY I/O) per
browser. WS attaches to existing `LiveTab`; it does **not** kill the
PTY on disconnect. WS auto-reconnects with exponential backoff and
resumable byte-position tracking (`resume_from` query param). Input is
buffered client-side while disconnected.

### State Sync

SSE snapshot on connect, incremental events for changes.
`EventSource` auto-reconnects; the server re-snapshots on reconnect.
No periodic reconciliation — drift corrects on reconnect.

### Backend (Rust / Axum)

- State: grep for `AppState` — DashMap for tabs, EventBus for SSE
- Persistence: JSON project data + TOML settings. Dev: `~/.hubris-dev/`,
  prod: `~/.hubris/`
- PTY: portable-pty, shell from `$SHELL` or `/bin/sh`
- WS protocol: binary (PTY output), JSON control (`type: "resize"`,
  `type: "attached"` with `byte_offset`/`data_lost`)
- SSE events: snapshot, tab_created, tab_closed, tab_updated,
  project_added, project_removed, project_updated, projects_reordered,
  worktree_created, worktree_deleted, worktrees_reordered,
  project_worktrees_updated
- Git status: `GET /api/projects/{id}/worktrees/{wt_id}/git-status`
  uses `git2`/libgit2 (not CLI) to read staged/unstaged/ahead-of-source info.
  `source_ref` on worktrees tracks the branch it was created from.

### Frontend (React / Vite / Tailwind v4)

- App location: `frontend/`
- State: Zustand singletons — grep `useProjectStore`,
  `useWorktreeStore`, `useTabStore`, `useSettingsStore`,
  `useThemeSettings`, `useTerminalSettings`, `useWorktreeSettings`,
  `useWorktreeRightSidebarStore`,
  `useWorktreeRightSidebarWidthStore`
- SSE bootstrap: `src/lib/bootstrap.ts`
- UI primitives: shadcn/ui React under `src/components/ui/`
- Sidebar decomposition: `AppSidebar.tsx` is a thin façade;
  feature code lives in `components/app-sidebar/`
- Settings decomposition: `SettingsDialog.tsx` is a thin façade;
  feature code lives in `components/settings-dialog/`
- Tab bar decomposition: `TabBar.tsx` is the shell; sortable behavior
  lives in `components/tab-bar/`
- Terminal connection state machine lives in
  `components/terminal/useTerminalConnection.ts`
- Theme engine: native Hubris theme definitions in
  `src/lib/theme/builtin.ts`, converted by `src/lib/theme/convert.ts`
- FOUC prevention: inline script in `index.html` reads
  `hubris-settings` to choose light/dark mode and
  `hubris-theme-cache` to apply cached CSS vars before first paint
- API contracts: Rust `generate_contracts` writes directly to
  `frontend/src/lib/contracts/{openapi,sse,ws}.generated.*`; then
  `bun run generate:contracts:rest` produces `rest.generated.ts`
- Dev proxy: port 3001 proxies `/api` → backend 3101

## Conventions

- Conventional commits (`feat:`, `fix:`, `refactor:`)
- Frontend: PascalCase `.tsx`
- Tests colocated (`.test.ts` / `.test.tsx`), `tests/` for Rust
- Rust edition 2024, `style_edition = "2024"` in `rustfmt.toml`
- React app imports should use `@/lib/...`, `@/components/...`, and
  `@/hooks/...`; do not introduce `$lib/...`
- **Avoid `useEffect` unless it is clearly necessary**:
  prefer deriving UI directly from Zustand or React state instead of using
  effects for orchestration, prop syncing, or data flow. Valid exceptions are:
  unavoidable external synchronization, timer/debounced presentation logic, or
  performance-sensitive imperative paths where state-driven rerenders cause
  visible lag (for example sidebar resize width writes).

## Gotchas

- **Do NOT modify shadcn components**: Files under
  `frontend/src/components/ui/` are managed vendor code. Editing them
  makes future shadcn updates painful. Put customizations in wrapper
  components or app-level code instead.
- **SSE init ordering**: All store handlers must be registered before
  `EventClient.connect()` — the snapshot fires immediately on connect.
  In React bootstrap, initialize project/worktree/tab stores before
  calling `events.connect()`.
- **rustfmt style_edition 2024**: Formats more aggressively than
  default (collapses single-line signatures, method chains). Always
  run `cargo fmt` after edits.
- **Async request paths must avoid blocking fs/process work**:
  request-time filesystem access should use `tokio::fs`, not `std::fs`,
  and any unavoidable sync-only filesystem or process call should be
  wrapped in `tokio::task::spawn_blocking` instead of running on the
  async executor.
- **Tab position**: `f64` for fractional ordering (midpoint insertion).
- **Project reorder**: Bulk `PUT /api/projects/reorder` with ordered
  IDs. Backend resequences all positions as clean integers and emits a
  single `projects_reordered` SSE event. Do NOT use PATCH to set
  individual positions.
- **Sidebar resize ownership**: Keep sidebar resize customization in
  app-level files instead of `components/ui/sidebar.tsx` so shadcn
  sidebar upgrades remain copy-merge operations.
- **Sidebar menu primitives require provider context**:
  `SidebarMenuButton` and related `SidebarMenu*` primitives call
  `useSidebar()`. When reusing them outside a full `Sidebar`, wrap the
  render tree in `SidebarProvider` in app code/tests.
- **Sidebar width updates are imperative during drag**:
  `frontend/src/App.tsx` subscribes to sidebar width store changes and
  writes `--sidebar-width` directly to the rendered sidebar wrapper.
  Keep `isResizing` reactive, but avoid reintroducing a full React
  subscription to width or resize drags will rerender the app tree.
- **deleteTab tolerates 404**: Tab may already be gone (shell exit,
  other browser).
- **deleteProject tolerates 404**: Project may already be gone (other
  browser removed it).
- **Settings live in `settings.toml` now**: server settings persistence
  is TOML, not JSON. The backend keeps an in-memory snapshot plus a
  parsed `toml_edit` document so user comments and unknown keys survive
  PATCH/PUT writes.
- **Settings TOML merges preserve inline tables too**: top-level
  sections like `appearance = { ... }` should stay inline when PATCH or
  PUT updates them. Use `toml_edit` table-like APIs rather than forcing
  them into bracket tables, or inline-table keys/comments will be lost.
- **Settings writes are atomic temp-file renames again**: the server
  writes `settings.toml` to a sibling temp file, syncs it, renames it
  into place, and syncs the parent directory to reduce crash-window
  corruption risk. Editors that keep hard file handles may treat the
  file as replaced rather than modified in place.
- **Worktree rename conflict protection is only atomic on macOS/Linux**:
  `worktree_files` uses no-replace OS rename calls there to avoid
  TOCTOU overwrite races. Other targets still fall back to an
  existence check plus rename.
- **Settings sync uses SSE generations plus server status**: snapshot
  events now include `settings`, `settings_generation`, and
  `settings_status`; incremental `settings_updated` events carry the
  same `SettingsState` payload. The frontend ignores older generations
  but still applies equal-generation status changes so invalid-file
  recovery can unblock queued writes.
- **Frontend settings saves are optimistic but backend-authoritative**:
  the browser applies local changes immediately, sends discrete
  `PATCH /api/settings` writes right away, and debounces typed terminal
  inputs (`systemFontFamily`, typed `fontSize`). Server responses and
  SSE are canonical: the store accepts newer generations, still applies
  equal-generation status changes, and on latest-request failures shows
  a toast then refetches `/api/settings` instead of retrying or
  rebasing unsaved local diffs.
- **Invalid settings files block writes until fixed**: malformed
  `settings.toml` at startup or during runtime no longer crashes
  Hubris; the backend keeps the last known/default in-memory settings,
  returns `409` from settings `PUT`/`PATCH`, emits invalid-file status
  over SSE, and unblocks once the file becomes valid again.
- **Settings store adapters must use stable Zustand snapshots**:
  adapter hooks like `useThemeSettings`, `useTerminalSettings`, and
  `useWorktreeSettings` are selector hooks over the real
  `useSettingsStore`, not standalone Zustand stores. They cannot build
  fresh wrapper objects inside the selector passed to `useSettingsStore`.
  Select a shallow slice first, then run any caller selector against
  that slice, or React will hit `getSnapshot` and maximum update depth
  errors.
- **Appearance settings still store per-mode theme IDs**:
  `lightTheme`/`darkTheme` remain in settings even though only built-in
  Hubris themes are selectable right now.
- **Bundled fonts**: 16 woff2 files live in `frontend/public/fonts/`,
  downloaded via `mise run download:fonts`. Fonts are loaded on-demand
  via dynamic `@font-face` when the user selects a bundled font.
- **Project paths are canonicalized to Git local root**:
  `POST /api/projects` resolves input paths through Git and stores the
  canonical local root. On macOS this often normalizes `/tmp/...` to
  `/private/tmp/...`.
- **Project removal defaults to remove-only**:
  `DELETE /api/projects/:id` removes the project without deleting
  worktrees unless `?delete_managed_worktrees=true` is supplied. Only
  Hubris-managed non-local worktrees are deleted on that path. Dirty or
  busy conflicts (`409`) only apply on the managed-delete path and can
  be overridden with `?force=true`.
- **Terminal WS stale cleanup uses server ping/pong**: terminal
  attachments are expired by server-driven websocket pings. Hidden tabs
  stay connected and should still answer pings, but only `visible:true`
  attachments participate in PTY size aggregation.
- **Terminal component unmount only detaches the browser attachment**:
  React terminal cleanup closes the current websocket connection, but
  the backend keeps the `LiveTab` PTY alive for reconnect. Only
  explicit tab deletion or shell exit destroys the server-side PTY.
- **Fresh terminal attaches need a full state snapshot**: resumable raw
  byte replay is only safe when reconnecting the same mounted xterm
  instance. Reloads/new browser attachments must use the server-side
  terminal snapshot path to restore alternate-screen and mouse/input
  modes for TUIs like `htop`.
- **StrictMode is enabled**: terminal remount/cleanup is
  generation-guarded. Keep websocket, reconnect timer, and post-open
  `requestAnimationFrame` handlers scoped to the active connection so
  stale callbacks from a previous mount cannot schedule extra sockets or
  duplicate terminal I/O.
- **Radix Select tests need extra jsdom shims**: the React settings
  dialog uses Radix Select, which expects pointer capture and
  `scrollIntoView()`. In Vitest/jsdom, stub `hasPointerCapture`,
  `setPointerCapture`, `releasePointerCapture`, and `scrollIntoView` in
  `src/test/setup.ts`.
- **Settings store tests must clean up `matchMedia` listeners**:
  `frontend/src/lib/stores/settings.ts` binds a singleton
  `prefers-color-scheme` listener on initialize. Tests that reset and
  reinitialize the store need `resetSettingsStoreForTests()` to remove
  that listener and clear its bound flag or later cases will reuse a
  stale callback.
- **Popover lists inside React dialogs may need a dialog-local
  portal**: `frontend/src/components/AddWorktreeDialog.tsx` mounts the
  start-point `Popover` into a container inside the dialog instead of
  the default body portal. Portalling that popover outside the dialog
  breaks wheel/trackpad scrolling on `CommandList` content.
- **Raised settings menus do not need a custom wrapper**: the settings
  dialog now relies on the mobile sidebar panel being lowered (`z-40`)
  rather than special select-content wrappers. Prefer the shared
  `SelectContent` unless a future dialog introduces a real layering
  conflict.
- **`bunx shadcn` can fail with `EEXIST` in this repo/worktree setup**:
  for inspection-only tasks like checking component docs, use
  `npx shadcn@latest docs ...` as a fallback instead of assuming
  `bunx shadcn@latest ...` will work.
- **Rust integration tests should disable Git commit signing**:
  local/global Git config may enforce GPG signing and break ephemeral
  test-repo commits. In test helpers that run `git commit`, pass
  `-c commit.gpgsign=false`.
- **`ts-rs` warns on some serde field attributes**: with `ts-rs` +
  `serde-compat`, attributes like
  `skip_serializing_if = "Option::is_none"` may emit warnings during
  `cargo check`/`clippy`. Generated types still build.
- **`ts-rs` v12 changed codegen API**:
  `TS::export_to_string()` now requires a `ts_rs::Config` argument.
- **`material-icon-theme` manifest is not a complete browser file-type resolver**:
  `generateManifest()` follows the VS Code icon-theme manifest model, which may
  omit some generic language extensions (for example plain `.ts`) because VS
  Code can also use language IDs. Browser file explorers that only have paths
  should not assume the generated manifest alone reproduces full VS Code parity.
- **`material-icon-theme` browser resolution must include `languageIds` too**:
  plain path-based resolution for files like `.html` and `.yml` can miss custom
  icons if it only consults `fileNames` and `fileExtensions`. The generated
  manifest and browser resolver should carry `languageIds`, with a minimal alias
  layer such as `yml -> yaml` where the file extension and VS Code language ID
  differ.
- **Explorer refresh UI should be stale-while-revalidate**:
  watcher-driven refreshes for already-loaded directories should keep cached
  children visible and use a refresh-specific status/indicator. Reusing the
  initial-load placeholder state makes subtree renames/removals flash.
- **`worktree_files_updated` separates exact changes from listing refreshes**:
  `changed_paths` are the exact watcher-reported paths; `listing_paths` are the
  directories whose immediate child list may have changed. Frontend explorer
  invalidation should refresh exact matching loaded directories and exact parent
  listings, not recursively stale whole descendant subtrees from parent listing
  changes alone.
- **Linux `notify` watcher batches can include ancestor directories**:
  nested file writes may arrive as a batch containing the file plus one or more
  parent directories. Backend watcher normalization must collapse strict
  ancestors out of `changed_paths` and emit any concurrent git invalidation even
  when the same batch also produces file invalidation.
- **Git index mutations need explicit worktree-file cache invalidation**:
  stage/unstage operations may not trigger the worktree watcher, especially for
  linked worktrees where `.git` points outside the watched root. Backend git
  action handlers must invalidate `worktree_files` caches and emit
  `worktree_files_updated` instead of relying on filesystem events alone.
- **Discarding unstaged git changes must restore from the index, not `HEAD`**:
  restore worktree paths from the index so mixed staged+unstaged files keep
  their staged content intact. Resetting from `HEAD` is too destructive for
  `MM` and can fail for staged-added files.
- **Worktree file watchers coalesce overload to root+git invalidation**:
  the watcher queue is intentionally bounded. When it overflows, Hubris falls
  back to broad root file invalidation plus git refresh rather than risking
  dropped fs events.
- **Overflow `Notify` permits can outlive the overflow flag**:
  the watcher overflow path must ignore stale `Notify` wakes after
  `take_overflow_watch_event()` already consumed the atomic flag, or the
  watcher task can misread that stale permit as stream termination and exit.
- **Linked worktree git metadata lives outside the worktree root**:
  watching `worktree.path` recursively is not enough to catch external commits,
  ref updates, or index changes for linked worktrees. Git-status freshness needs
  separate watches on the resolved absolute git dir and git common dir, and
  git-only invalidation should not stale file listings.
- **Linked worktree local-root resolution must prefer `repo.workdir()`**:
  when deriving a git local root with `git2`, check `workdir()` before the
  shared `commondir()` parent or linked worktrees collapse to the main repo
  root instead of their own checkout path.
- **File editor/diff symlinks may target only the worktree or repo root**:
  working-tree file reads/writes follow symlinks only when the final canonical
  target stays under the canonical worktree root or the canonical project
  local root (`resolved.local_root`). This is what allows linked-worktree
  symlinks like `.env.local` back into the repo root without permitting
  arbitrary filesystem escapes. Explorer listing should use the same allowlist
  and mark symlink entries via `is_symlink`.
- **`git2` worktree add names must be safe internal IDs**:
  do not pass raw branch shorthands like `feature/foo` into
  `repo.worktree(...)`. Use a filesystem-safe name derived from the target
  path; keep the branch/ref selection separate in the worktree add options.
- **`code serve-web` cold start is not immediately ready**:
  a fresh server can return `202 Accepted` with a download/startup page before
  the workbench is usable, and the readiness probe must use authenticated
  `GET /code`, not `HEAD`, because ready instances can reject `HEAD`. Hubris'
  reverse proxy should inject the `vscode-tkn` auth cookie upstream and accept
  browser `vscode-tkn` cookies on proxied `/code` requests. Stripping the
  upstream `Set-Cookie: vscode-tkn=...` breaks the stable websocket handshake:
  the browser-side workbench needs that token to send the initial `auth`
  control message that `code serve-web` validates before the connection opens.
- **Prefer `git2` for runtime git operations**:
  repository inspection like status, refs, branch/default-start-point lookup,
  commit history/details, worktree enumeration/lifecycle, root resolution,
  and git/common-dir discovery should stay on `git2`. Keep the git CLI in
  test fixtures or unsupported edge cases only.
- **Staged git status uses `git2` diff + find-similar**:
  staged sidebar/API data comes from a `HEAD -> index` diff with rename/copy
  detection enabled. Keep `include_unmodified(true)` plus
  `copies_from_unmodified(true)` or staged copies can regress back to plain
  adds without source context.
- **Commit-details diffs should stay rename-only**:
  copy-harder detection is useful for staged status but too aggressive for the
  commit-details API. Enabling copy detection there can mislabel a simple added
  file as `copied`.
- **`git2` status omits already-empty untracked directories**:
  discard flows cannot rely on `repo.statuses(...)` alone for an explicitly
  requested empty directory. If the path still exists on disk and is a
  directory, remove it directly before treating the discard as a no-op.
- **Manual rewrite staging must include both source and destination paths**:
  for plain filesystem renames, `git add -- <old> <new>` is what collapses the
  tracked delete+add into a staged rename. Staging only the destination leaves
  the source side as an unstaged delete.
- **Sidebar passive loads must not use `refreshVisiblePaths()`**:
  `refreshVisiblePaths()` is the invalidation path and force-refreshes git
  status. The right-sidebar visibility coordinator should use
  `loadDirectory("")`, `preloadVisibleDirectories()`, and `loadGitStatus()`
  for normal tab-open hydration, or it can spin on already-fresh state.
- **Monaco theme/model ownership must stay global, not per-tab**:
  file/diff tabs should not each call `defineTheme`/`setTheme` from mount
  effects. Reordering tabs under React StrictMode can overlap Monaco cleanup
  with those global theme mutations and crash disposed editors. Apply theme
  idempotently from app-level code, and keep Monaco models alive across tab
  reorder churn with explicit cleanup only when tabs actually close.
- **Monaco file associations are not all under `basic-languages`**:
  Monaco `0.54.0` keeps JSON registration metadata in
  `esm/vs/language/json/monaco.contribution.js`, not
  `esm/vs/basic-languages/`. Any generator that mirrors Monaco file-extension
  coverage must scan both roots or `.json` files will fall back to
  `plaintext`.
- **Monaco contribution files can register multiple languages**:
  `cpp.contribution.js` registers both `c` and `cpp` from one file. The Monaco
  registry generator must parse every `registerLanguage(...)` or
  `languages.register(...)` block in a contribution file, not assume one
  language id per file.
- **Monaco `0.55.x` package-root import restores basic syntax highlighting**:
  `monaco-editor/esm/vs/basic-languages/_.contribution.js` no longer aggregates
  the basic-language registrations. For runtime editor bootstrap, import
  `monaco-editor` and keep only the Vite worker deep imports; otherwise many
  basic languages such as Rust and Markdown fall back to plaintext.
- **Dev task wrapper sets shared instance env only**:
  `.mise/tasks/dev` generates random `HUBRIS_DEV_ID`, sets
  `HUBRIS_DEV_TMP`, and runs backend/frontend tasks in parallel.
- **Backend hot reload uses random socket activation port**:
  `dev:server` runs `systemfd --no-pid -s http::0 -- mise watch
  --restart dev:server:raw`.
- **Interrupting `mise run dev` still reports task failure on shutdown**:
  stopping the parallel dev wrapper with `Ctrl-C` surfaces `task failed`
  from `mise` while child processes unwind. Treat that as expected
  shutdown noise unless one of the child processes was already failing
  before the interrupt.
- **Backend watch sources live on hidden raw task**:
  `dev:server:raw` is hidden and owns Rust file `sources` globs used by
  `mise watch`.
- **Stable-port reload requires socket activation in backend**:
  server startup must check inherited fd0 via `listenfd` before using
  dev fallback port binding.

## EDD (Eval-Driven Development)

- Feature specs live in `docs/features/NNN-slug/`; check there before
  implementing a feature request
- Reference EDD feature numbers in commits: `feat(edd-NNN): ...`
- Never modify `evals.md` once feature status is Evals Ready or later
- When writing specs from evals, use your own language — don't just
  reformat the eval criteria

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **terminal-notification-dot** (2681 symbols, 8416 relationships, 222 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/terminal-notification-dot/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/terminal-notification-dot/context` | Codebase overview, check index freshness |
| `gitnexus://repo/terminal-notification-dot/clusters` | All functional areas |
| `gitnexus://repo/terminal-notification-dot/processes` | All execution flows |
| `gitnexus://repo/terminal-notification-dot/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

- **GitNexus repo names can map to a different worktree than the one you are editing**:
  on Codex worktrees, `gitnexus_detect_changes()` may report stale or unrelated
  files if the indexed `hubris` repo path points at another checkout. Confirm the
  indexed path from `gitnexus_list_repos()` before trusting change-scope output.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
- **Desktop app serves bundled frontend files from Tauri resources**:
  the Tauri shell still loads Hubris over loopback HTTP. Production
  desktop builds bundle `frontend/dist` as Tauri resources and the
  embedded server reads those files at runtime instead of using
  `embed-frontend`. Keep `desktop/build.rs` creating a placeholder
  `frontend/dist/index.html` for clean-checkout `cargo check`, but
  rely on `bun run build` to produce the real frontend before desktop
  release builds.
- **Desktop Tauri hooks run from the repo root in this setup**:
  `desktop/tauri.conf.json` build hooks should use root-relative paths
  like `cd frontend && bun run build`, not paths relative to
  `desktop/`.
- **Desktop dev dynamically overrides `devUrl` from the frontend state
  file**: `.mise/tasks/dev-desktop` reuses the shared `HUBRIS_DEV_ID`
  / `HUBRIS_DEV_TMP` mechanism, waits for
  `tmp/dev-<id>.frontend.json`, then launches `cargo tauri dev
  --config` with the actual Vite port. Keep that wrapper in sync with
  the Vite `devInstancePlugin()` output shape, and keep
  `desktop/src/main.rs` reading `app.config().build.dev_url` in debug
  mode instead of hardcoding a localhost port.
- **Desktop loopback auth uses a one-time bootstrap plus an `HttpOnly`
  cookie**: packaged desktop hits
  `/_hubris/desktop/bootstrap?token=...` on the embedded server, while
  `mise run dev:desktop` hits the same path on the Vite dev server.
  The backend trusts only the `hubris_desktop_session` cookie in
  desktop mode, so keep desktop auth out of frontend JS fetch/SSE/WS
  code.
