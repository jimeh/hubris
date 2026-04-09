# Desktop (Tauri) Gotchas

- **Desktop app serves bundled frontend files from Tauri resources**: the Tauri
  shell still loads Hubris over loopback HTTP. Production desktop builds bundle
  `apps/web/dist` as Tauri resources and the embedded server reads those files
  at runtime instead of using `embed-frontend`. Keep
  `apps/desktop-tauri/build.rs` creating a placeholder
  `apps/web/dist/index.html` for clean-checkout `cargo check`, but rely on
  `bun run --filter hubris-web build` to produce the real frontend before
  desktop release builds.
- **Desktop Tauri hooks run from the repo root in this setup**:
  `apps/desktop-tauri/tauri.conf.json` build hooks should use root-relative
  workspace commands like `bun run --filter hubris-web build`, not paths
  relative to `apps/desktop-tauri/`.
- **Desktop dev dynamically overrides `devUrl` from the frontend state file**:
  `.mise/tasks/dev-desktop` reuses the shared `HUBRIS_DEV_ID` / `HUBRIS_DEV_TMP`
  mechanism, waits for `tmp/dev-<id>.frontend.json`, then launches
  `cargo tauri dev --config` with the actual Vite port. Keep that wrapper in
  sync with the Vite `devInstancePlugin()` output shape, and keep
  `apps/desktop-tauri/src/main.rs` reading `app.config().build.dev_url` in debug
  mode instead of hardcoding a localhost port.
- **Desktop loopback auth uses a one-time bootstrap plus an `HttpOnly` cookie**:
  packaged desktop hits `/_hubris/desktop/bootstrap?token=...` on the embedded
  server, while `mise run dev:desktop` hits the same path on the Vite dev
  server. The backend trusts only the `hubris_desktop_session` cookie in desktop
  mode, so keep desktop auth out of frontend JS fetch/SSE/WS code.
