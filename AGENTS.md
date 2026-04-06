# Hubris

Terminal-based project manager: Rust/Axum backend with a React/Vite frontend and
persistent PTY sessions.

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

Tools: mise (see `mise.toml`). Packages: Cargo (backend), **bun** (frontend).

**IMPORTANT: Always run `mise run check` before committing or opening PRs.** CI
runs the same checks — format (`cargo fmt`, `prettier`), lint (`clippy`,
`eslint`), and type check (`tsc`).

**IMPORTANT: The frontend uses bun, NOT npm or pnpm.** All frontend commands
must use `bun` (`bun install`, `bun run test`, `bun run check`). The `frontend/`
directory has a `bun.lock`; there is no `package-lock.json` or `pnpm-lock.yaml`.

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

## Detail Docs

- [Architecture](docs/agents/architecture.md) — connection model, state sync,
  backend/frontend overview
- [Backend](docs/agents/backend.md) — async rules, settings TOML, git2, PTY,
  worktree ops, file watchers
- [Frontend](docs/agents/frontend.md) — React/Zustand, shadcn, sidebar, settings
  store, terminal, Monaco, explorer
- [Testing](docs/agents/testing.md) — Vitest/jsdom, mock patterns, test
  organization, Rust tests
- [Desktop](docs/agents/desktop.md) — Tauri build, dev workflow, auth
- [Dev Environment](docs/agents/dev-environment.md) — mise tasks, hot reload,
  socket activation

<!-- gitnexus:start -->

# GitNexus — Code Intelligence

This project is indexed by GitNexus as **hubris** (3032 symbols, 9204
relationships, 252 execution flows). Use the GitNexus MCP tools to understand
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
