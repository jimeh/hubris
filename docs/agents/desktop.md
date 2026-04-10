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
- **Electron browser storage lives in native app-data directories**: configure
  `userData` and `sessionData` before `app.whenReady()` so Chromium persists
  `localStorage`, IndexedDB, cookies, and cache in stable OS-native paths. Use
  separate profiles for release (`Hubris`) and dev (`Hubris Dev`) so code-server
  state survives restarts without mixing dev and packaged data.
- **Electron uses persistent, mode-specific partitions**: keep release and dev
  on separate `persist:` partitions so browser storage survives restarts while
  still isolating `mise run dev:desktop` from packaged builds. Keep permission
  requests, `window.open`, and cross-origin navigation denied.
- **Desktop packaging depends on prebuilt resources**: `mise run build:desktop`
  must build `apps/web/dist` and the `hubris-desktop-runtime` release binary
  before running Electron Forge, because the packaged app copies both in as
  resources instead of rebuilding them at launch.
