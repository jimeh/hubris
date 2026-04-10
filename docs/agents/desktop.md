# Desktop (Electron) Gotchas

- **Desktop still loads Hubris over loopback HTTP**: Electron is only the shell.
  In packaged mode it spawns the Rust `hubris-desktop-runtime`, which serves
  bundled `apps/web/dist` assets from the filesystem and exposes the existing
  Axum API/SSE/WS surfaces on `127.0.0.1`.
- **Packaged desktop auth is backend-owned**: Electron generates a fresh session
  token and bootstrap token, launches the Rust runtime with both, then loads
  `/_hubris/desktop/bootstrap?token=...`. The backend redeems that bootstrap
  token once and sets only the `hubris_desktop_session` `HttpOnly` cookie. Keep
  desktop auth out of frontend JS fetch/SSE/WS code.
- **Desktop dev keeps the split Vite + backend model**: `mise run dev:desktop`
  still uses the shared `HUBRIS_DEV_ID` / `HUBRIS_DEV_TMP` state files. Electron
  waits for `tmp/dev-<id>.frontend.json`, then loads the Vite bootstrap URL
  while the backend uses `HUBRIS_DESKTOP_SESSION_TOKEN` in api-only desktop
  mode.
- **Electron uses an in-memory session partition**: the desktop auth cookie must
  stay scoped to the Hubris app window instead of leaking into a persistent
  browser profile. Keep the window partition non-persistent and deny permission
  requests, `window.open`, and cross-origin navigation.
- **Desktop packaging depends on prebuilt resources**: `mise run build:desktop`
  must build `apps/web/dist` and the `hubris-desktop-runtime` release binary
  before running Electron Forge, because the packaged app copies both in as
  resources instead of rebuilding them at launch.
