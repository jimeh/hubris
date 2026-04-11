# Desktop (Electron) Gotchas

- **Electron owns the stable desktop origin**: the renderer always loads
  `https://desktop.internal.hubris.build/`, never raw loopback URLs. In dev,
  Electron proxies frontend asset requests to Vite and backend requests to the
  Rust dev server. In packaged mode, Electron serves bundled `apps/web/dist`
  files itself and proxies `/api` and `/_hubris` to the packaged Rust runtime on
  an ephemeral loopback port.
- **Packaged desktop auth is still backend-owned, but Electron redeems it**:
  Electron generates a fresh session token and bootstrap token, launches the
  Rust runtime with both, performs the one-time
  `/_hubris/desktop/bootstrap?token=...` request itself, and then seeds the
  `hubris_desktop_session` cookie into the
  `https://desktop.internal.hubris.build` session jar. Keep desktop auth out of
  frontend JS fetch/SSE/WS code.
- **Desktop dev still uses the shared dev-state handshake**:
  `mise run dev:desktop` still relies on `HUBRIS_DEV_ID` / `HUBRIS_DEV_TMP`.
  Electron waits for both `tmp/dev-<id>.frontend.json` and
  `tmp/dev-<id>.backend.json`, then proxies
  `https://desktop.internal.hubris.build/` to those live dev targets. The
  backend stays in `api_only` desktop mode in dev.
- **Electron browser storage lives in native app-data directories**: configure
  `userData` and `sessionData` before `app.whenReady()` so Chromium persists
  `localStorage`, IndexedDB, cookies, and cache in stable OS-native paths. Keep
  `sessionData` under the shared native `Hubris/sessionData` root so Chromium
  storage survives across builds, with dev/release still isolated by their
  separate `persist:` partition names.
- **Electron uses persistent, mode-specific partitions**: keep release and dev
  on separate `persist:` partitions so browser storage survives restarts while
  still isolating `mise run dev:desktop` from packaged builds. Keep permission
  requests, `window.open`, and cross-origin navigation denied.
- **Code-server needs the stable desktop origin too**: browser storage is
  origin-scoped, so code-server must also load under
  `https://desktop.internal.hubris.build/code/...`. Electron now proxies
  `/code/*` directly to the live code-server upstream after resolving it via the
  authenticated `/_hubris/code-server/connection` endpoint, so desktop no longer
  double-proxies code-server through Hubris’ Rust `/code` route.
- **Desktop WebSockets are Electron-bridged, not browser-visible loopback**: the
  preload script replaces same-origin `WebSocket` connections with a narrow
  main-process bridge. That bridge forwards cookies and the stable desktop
  `Origin` header to the real upstream target, and it is used for code-server,
  terminal WebSockets, and Vite HMR in dev.
- **The packaged Rust runtime is backend-only**: do not reintroduce frontend
  asset serving in `hubris-desktop-runtime`. In packaged desktop, Electron owns
  the Hubris frontend files; the Rust runtime only serves `/api` and `/_hubris`
  for desktop.
- **Desktop packaging depends on prebuilt resources**: `mise run build:desktop`
  must build `apps/web/dist` and the `hubris-desktop-runtime` release binary
  before running Electron Forge, because the packaged app copies both in as
  resources instead of rebuilding them at launch.
- **Cross-target packaging reads the runtime path from the environment**:
  `HUBRIS_DESKTOP_RUNTIME_PATH` overrides Forge's default
  `target/release/hubris-desktop-runtime` lookup. Use that for
  `mise run build:desktop:<platform>-<arch>` tasks so cross-built runtimes are
  copied into packaged apps without moving files around.
- **macOS desktop builds are the only packaged desktop targets**: the target-
  aware desktop tasks only build `darwin` zips now. Keep Linux packaging out of
  the desktop matrix until a reliable distributable path exists.
- **Non-macOS hosts need explicit Apple SDK/linker setup for macOS Rust
  binaries**: cross-building `*-apple-darwin` targets off macOS is only
  supported when `SDKROOT` and the matching `CARGO_TARGET_<TRIPLE>_LINKER`
  environment variable point at a valid macOS SDK toolchain. Keep macOS desktop
  release packaging on native macOS runners.
- **Closing the last desktop window does not exit Hubris**: the Electron app and
  packaged Rust runtime stay alive so background work can continue. Reopen the
  UI through the normal app relaunch path: Electron uses a single-instance lock
  and `second-instance`/`activate` handlers to show or recreate the main window
  instead of starting a duplicate app process.
