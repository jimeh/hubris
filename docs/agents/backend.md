# Backend Gotchas

## Async

- **Async request paths must avoid blocking fs/process work**: request-time
  filesystem access should use `tokio::fs`, not `std::fs`, and any unavoidable
  sync-only filesystem or process call should be wrapped in
  `tokio::task::spawn_blocking` instead of running on the async executor.

## Settings Persistence

- **Settings live in `settings.toml`**: the backend keeps an in-memory snapshot
  plus a parsed `toml_edit` document so user comments and unknown keys survive
  PATCH/PUT writes.
- **TOML merges preserve inline tables**: top-level sections like
  `appearance = { ... }` should stay inline when PATCH or PUT updates them. Use
  `toml_edit` table-like APIs rather than forcing them into bracket tables, or
  inline-table keys/comments will be lost.
- **Settings writes are atomic temp-file renames**: the server writes
  `settings.toml` to a sibling temp file, syncs it, renames it into place, and
  syncs the parent directory to reduce crash-window corruption risk.
- **Settings sync uses SSE generations plus server status**: snapshot events
  include `settings`, `settings_generation`, and `settings_status`; incremental
  `settings_updated` events carry the same `SettingsState` payload. The frontend
  ignores older generations but still applies equal-generation status changes so
  invalid-file recovery can unblock queued writes.
- **Invalid settings files block writes until fixed**: malformed `settings.toml`
  at startup or during runtime no longer crashes Hubris; the backend keeps the
  last known/default in-memory settings, returns `409` from settings
  `PUT`/`PATCH`, emits invalid-file status over SSE, and unblocks once the file
  becomes valid again.

## Git Operations (git2)

- **Prefer `git2` for runtime git operations**: repository inspection like
  status, refs, branch/default-start-point lookup, commit history/details,
  worktree enumeration/lifecycle, root resolution, and git/common-dir discovery
  should stay on `git2`. Keep the git CLI in test fixtures or unsupported edge
  cases only.
- **Staged git status uses `git2` diff + find-similar**: staged sidebar/API data
  comes from a `HEAD -> index` diff with rename/copy detection enabled. Keep
  `include_unmodified(true)` plus `copies_from_unmodified(true)` or staged
  copies can regress back to plain adds without source context.
- **Commit-details diffs should stay rename-only**: copy-harder detection is
  useful for staged status but too aggressive for the commit-details API.
  Enabling copy detection there can mislabel a simple added file as `copied`.
- **Commit diff gitlinks should be treated as unsupported, not internal
  errors**: submodule changes show up in commit trees as gitlink entries, not
  blobs. Return an unsupported diff reason instead of `500`.
- **`git2` status omits already-empty untracked directories**: discard flows
  cannot rely on `repo.statuses(...)` alone for an explicitly requested empty
  directory. If the path still exists on disk and is a directory, remove it
  directly before treating the discard as a no-op.
- **Manual rewrite staging must include both source and destination paths**: for
  plain filesystem renames, `git add -- <old> <new>` is what collapses the
  tracked delete+add into a staged rename. Staging only the destination leaves
  the source side as an unstaged delete.
- **Discarding unstaged git changes must restore from the index, not `HEAD`**:
  restore worktree paths from the index so mixed staged+unstaged files keep
  their staged content intact. Resetting from `HEAD` is too destructive for `MM`
  and can fail for staged-added files.

## Worktree Operations

- **`git2` worktree add names must be safe internal IDs**: do not pass raw
  branch shorthands like `feature/foo` into `repo.worktree(...)`. Use a
  filesystem-safe name derived from the target path; keep the branch/ref
  selection separate in the worktree add options.
- **Linked worktree local-root resolution must prefer `repo.workdir()`**: when
  deriving a git local root with `git2`, check `workdir()` before the shared
  `commondir()` parent or linked worktrees collapse to the main repo root
  instead of their own checkout path.
- **Worktree rename conflict protection is only atomic on macOS/Linux**:
  `worktree_files` uses no-replace OS rename calls there to avoid TOCTOU
  overwrite races. Other targets still fall back to an existence check plus
  rename.
- **Project paths are canonicalized to Git local root**: `POST /api/projects`
  resolves input paths through Git and stores the canonical local root. On macOS
  this often normalizes `/tmp/...` to `/private/tmp/...`.
- **Project removal defaults to remove-only**: `DELETE /api/projects/:id`
  removes the project without deleting worktrees unless
  `?delete_managed_worktrees=true` is supplied. Only Hubris-managed non-local
  worktrees are deleted on that path. Dirty or busy conflicts (`409`) only apply
  on the managed-delete path and can be overridden with `?force=true`.
- **Project reorder**: Bulk `PUT /api/projects/reorder` with ordered IDs.
  Backend resequences all positions as clean integers and emits a single
  `projects_reordered` SSE event. Do NOT use PATCH to set individual positions.

## File Watchers

- **`worktree_files_updated` separates exact changes from listing refreshes**:
  `changed_paths` are the exact watcher-reported paths; `listing_paths` are the
  directories whose immediate child list may have changed. Frontend explorer
  invalidation should refresh exact matching loaded directories and exact parent
  listings, not recursively stale whole descendant subtrees from parent listing
  changes alone.
- **Linux `notify` watcher batches can include ancestor directories**: nested
  file writes may arrive as a batch containing the file plus one or more parent
  directories. Backend watcher normalization must collapse strict ancestors out
  of `changed_paths` and emit any concurrent git invalidation even when the same
  batch also produces file invalidation.
- **Git index mutations need explicit worktree-file cache invalidation**:
  stage/unstage operations may not trigger the worktree watcher, especially for
  linked worktrees where `.git` points outside the watched root. Backend git
  action handlers must invalidate `worktree_files` caches and emit
  `worktree_files_updated` instead of relying on filesystem events alone.
- **Worktree file watchers coalesce overload to root+git invalidation**: the
  watcher queue is intentionally bounded. When it overflows, Hubris falls back
  to broad root file invalidation plus git refresh rather than risking dropped
  fs events.
- **Overflow `Notify` permits can outlive the overflow flag**: the watcher
  overflow path must ignore stale `Notify` wakes after
  `take_overflow_watch_event()` already consumed the atomic flag, or the watcher
  task can misread that stale permit as stream termination and exit.
- **Linked worktree git metadata lives outside the worktree root**: watching
  `worktree.path` recursively is not enough to catch external commits, ref
  updates, or index changes for linked worktrees. Git-status freshness needs
  separate watches on the resolved absolute git dir and git common dir, and
  git-only invalidation should not stale file listings.

## PTY / Terminal Server

- **Terminal WS stale cleanup uses server ping/pong**: terminal attachments are
  expired by server-driven websocket pings. Hidden tabs stay connected and
  should still answer pings, but only `visible:true` attachments participate in
  PTY size aggregation.
- **Terminal component unmount only detaches the browser attachment**: React
  terminal cleanup closes the current websocket connection, but the backend
  keeps the `LiveTab` PTY alive for reconnect. Only explicit tab deletion or
  shell exit destroys the server-side PTY.
- **Fresh terminal attaches need a full state snapshot**: resumable raw byte
  replay is only safe when reconnecting the same mounted xterm instance.
  Reloads/new browser attachments must use the server-side terminal snapshot
  path to restore alternate-screen and mouse/input modes for TUIs like `htop`.
- **deleteTab tolerates 404**: Tab may already be gone (shell exit, other
  browser).
- **deleteProject tolerates 404**: Project may already be gone (other browser
  removed it).

## Codex Chat Runtime

- **App-server lifecycle is host-scoped, thread streams are
  conversation-scoped**: do not spawn one `codex app-server` child process per
  chat. Keep one initialized app-server process for the Hubris host session,
  multiplex provider threads through it, and release idle conversations with
  `thread/unsubscribe` instead of process shutdown. Use
  `docs/agents/codex-app-server-lifecycle-best-practices.md` as the reference
  for start/stop, resume, unsubscribe, and crash behavior.
- **Normalize app-server protocol before persistence or SSE**:
  `codex app-server` JSON-RPC is a transport protocol, not a Hubris UI model.
  Route raw client responses, server requests, server notifications, and errors
  through a small normalization layer before mutating chat messages, activities,
  runs, or runtime state. Use
  `docs/agents/codex-app-server-GUI-best-practices.md` as the reference for
  method classification and UI responsibility.
- **Server requests are not responses**: app-server can send messages with both
  `id` and `method`. Those are server-initiated requests that need exactly one
  JSON-RPC response, not replies to Hubris client requests. Keep them as pending
  request state until resolved or explicitly declined.
- **Do not treat tool output as assistant prose**: command/file/tool output
  deltas belong to work/activity rows or debug output, while
  `item/agentMessage/delta` is the assistant answer stream. Reasoning streams
  belong in reasoning/progress state and must stay separate from answer text.
- **Preserve partial content on failure**: provider errors, app-server process
  exits, and turn failures should finalize run/error state without deleting
  already-streamed assistant text, reasoning summaries, or tool activity.

## Symlinks

- **File editor/diff symlinks may target only the worktree or repo root**:
  working-tree file reads/writes follow symlinks only when the final canonical
  target stays under the canonical worktree root or the canonical project local
  root (`resolved.local_root`). Explorer listing should use the same allowlist
  and mark symlink entries via `is_symlink`.

## VS Code Server

- **`code serve-web` cold start is not immediately ready**: a fresh server can
  return `202 Accepted` with a download/startup page before the workbench is
  usable, and the readiness probe must use authenticated `GET /code`, not
  `HEAD`. Hubris' reverse proxy should inject the `vscode-tkn` auth cookie
  upstream and accept browser `vscode-tkn` cookies on proxied `/code` requests.
  Stripping the upstream `Set-Cookie: vscode-tkn=...` breaks the stable
  websocket handshake.
