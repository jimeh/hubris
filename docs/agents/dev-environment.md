# Dev Environment Gotchas

- **Git hooks are Husky-managed**: `mise run setup` runs `hooks:install`, which
  delegates to the root `prepare` script. The pre-commit hook runs lint-staged,
  which checks staged whitespace, syntax-checks staged shell scripts, and
  selects `check:server`, `check:web`, `check:desktop`, and/or `check:markdown`
  from staged paths. Use `HUBRIS_PRECOMMIT_FULL=1` to force `mise run check`
  from the hook, or Git's `--no-verify` after manually running relevant checks.
  Hook installation is skipped when `CI=true`, `NODE_ENV=production`, or
  `HUSKY=0`.
- **Dev task wrapper defaults to portless web**: `.mise/tasks/dev` generates
  random `HUBRIS_DEV_ID`, sets `HUBRIS_DEV_TMP`, and runs backend plus
  `dev:web:portless` in parallel. Use `mise run dev:raw` for the old full-stack
  loopback behavior.
- **Backend hot reload uses random socket activation port**: `dev:server` runs
  `systemfd --no-pid -s http::0 -- mise watch --restart dev:server:raw`.
- **Portless wraps only Vite**: backend still uses socket activation and Vite
  still reads the backend dev-state file for `/api` and `/code` proxying.
  `dev:web:portless` defaults `PORTLESS_PORT` to `1355` when unset, while
  portless still owns project/worktree hostname inference.
- **Portless needs Vite on IPv4 loopback**: keep passing portless'
  `HOST=127.0.0.1` through to Vite `server.host`, because portless proxies
  upstreams to `127.0.0.1:<app-port>`.
- **Backend watch sources live on hidden raw task**: `dev:server:raw` is hidden
  and owns Rust file `sources` globs used by `mise watch`.
- **Stable-port reload requires socket activation in backend**: server startup
  must check inherited fd0 via `listenfd` before using dev fallback port
  binding.
- **`rustfmt` style_edition 2024**: Formats more aggressively than default
  (collapses single-line signatures, method chains). Always run `cargo fmt`
  after edits.
