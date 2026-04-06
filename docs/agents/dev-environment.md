# Dev Environment Gotchas

- **Dev task wrapper sets shared instance env only**: `.mise/tasks/dev`
  generates random `HUBRIS_DEV_ID`, sets `HUBRIS_DEV_TMP`, and runs
  backend/frontend tasks in parallel.
- **Backend hot reload uses random socket activation port**: `dev:server` runs
  `systemfd --no-pid -s http::0 -- mise watch --restart dev:server:raw`.
- **Backend watch sources live on hidden raw task**: `dev:server:raw` is hidden
  and owns Rust file `sources` globs used by `mise watch`.
- **Stable-port reload requires socket activation in backend**: server startup
  must check inherited fd0 via `listenfd` before using dev fallback port
  binding.
- **`rustfmt` style_edition 2024**: Formats more aggressively than default
  (collapses single-line signatures, method chains). Always run `cargo fmt`
  after edits.
