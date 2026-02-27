# Research: Rust Desktop+Web Dual-Mode Application Approaches

## Context

Researching approaches for building a Rust application that:

- Runs as a **desktop app** with native window chrome
- Runs as a **web app** served from a remote server via browser
- Embeds web content (VS Code web) in both modes
- Renders a local terminal (PTY) in both modes

Focus is on generic pros/cons of different frameworks and architecture
patterns, not the specifics of the final application.

---

## 1. Framework Overview

### 1.1 Tauri (v2)

**What it is:** Desktop app framework. Rust backend + web frontend rendered in
the OS-native webview. Not a UI framework itself — you bring your own frontend
(React, Svelte, Solid, Leptos, etc.).

**Webview engines per platform:**

| Platform | Engine           | Notes                            |
|----------|------------------|----------------------------------|
| macOS    | WKWebView        | Safari/WebKit. Tied to OS ver.   |
| Linux    | WebKitGTK        | Version varies wildly by distro. |
| Windows  | WebView2         | Chromium-based. Evergreen.       |
| iOS      | WKWebView        | Same as macOS.                   |
| Android  | System WebView   | Chromium-based via Play Store.   |

**IPC:** `invoke("command", { args })` sends JSON to Rust
`#[tauri::command]` functions. ~0.5ms baseline latency. Also has event
pub/sub and a `Channel` API for streaming. All data serialized as JSON
(MessagePack possible for binary).

**Key stats:**

- Bundle size: ~2.5-10 MB (vs Electron ~80-120 MB)
- RAM: ~30-40 MB (vs Electron ~100+ MB)
- 90k+ GitHub stars, 2000+ contributors, backed by CrabNebula
- v2 stable since Oct 2024, independently security-audited

**Pros:**

- Tiny bundles, low resource usage
- Mature plugin ecosystem (fs, dialog, clipboard, shell, http, updater, etc.)
- Strong security model (compile-time capability ACL)
- Use any JS/TS framework for the frontend
- Mobile support (iOS, Android) in v2
- Multiwebview support (unstable flag) — multiple webviews per window

**Cons:**

- **WebKitGTK on Linux is the weakest link.** Version varies by distro,
  rendering inconsistencies, WebRTC broken, community reports increasing
  instability. No clear fix timeline.
- Three different rendering engines = cross-platform testing burden
- No Node.js runtime (unlike Electron)
- IPC overhead for large/frequent data (JSON serialization)
- Doesn't natively serve UI over HTTP (needs plugin or custom server)

**Dual-mode (desktop + web):**

- Not built-in. Achievable via:
  - `tauri-plugin-localhost`: Serves bundled assets over HTTP on a local port.
    Security warning in docs.
  - Embed Axum/Actix as a side thread serving the same frontend
  - `tauri-invoke-http`: Bridges IPC over HTTP for browser access
- The frontend must feature-detect its environment
  (`window.__TAURI_INTERNALS__` vs browser) and switch between Tauri IPC and
  HTTP API calls.

**Webview embedding (iframes):**

- iframes with external content work but require CSP configuration
  (`frame-src` in security config)
- **Linux/Android caveat:** Cannot distinguish iframe requests from main
  window requests — security gap
- Multiwebview API (unstable) allows child webviews loading external URLs

**Terminal integration:**

- Well-established pattern: xterm.js frontend + portable-pty Rust backend
- `tauri-plugin-pty` exists as a ready-made Tauri 2 plugin
- Production examples: Terminon, TUICommander

---

### 1.2 Dioxus (v0.7)

**What it is:** A cross-platform Rust UI framework inspired by React. Write UI
in Rust with RSX macros, deploy to web (WASM), desktop (webview or native GPU),
mobile, SSR, and fullstack from one codebase.

**Architecture:**

- VirtualDom core with block-dom-inspired templates for efficient diffing
- Signal-based reactivity (`Signal<T>`)
- Renderer-agnostic core — platform renderers interpret mutations
- Unified `launch()` dispatches to correct renderer based on Cargo features

**Desktop rendering options:**

1. **Webview mode** (default): Uses Wry + Tao (same as Tauri). Assets served
   via custom `dioxus://` protocol. Same per-platform webview engines as Tauri.
2. **Native/Blitz mode** (0.7+, experimental): WGPU-based HTML/CSS renderer.
   GPU-rendered, no webview. Self-contained macOS apps under 6MB. NOT
   production-ready; targeting 2026.

**Web mode:** Compiles to WASM, renders to browser DOM. ~50kb hello world.

**Fullstack mode:** Single Cargo project compiles both server binary and WASM
client. `#[server]` functions become RPC endpoints automatically. Integrates
with Axum. Supports SSR, hydration, streaming HTML, SSG/ISR.

**Pros:**

- True write-once Rust codebase for web + desktop + mobile
- Hot-patching in 0.7 — edit Rust code, see changes without losing state
- Fullstack mode with server functions eliminates manual API definitions
- Component model, hooks, routing all platform-agnostic
- ~15k GitHub stars, active development (4 releases in 0.7.x within 3 months)

**Cons:**

- Pre-1.0; breaking changes between minor versions (0.5→0.6→0.7 all broke)
- Blitz/native renderer is experimental, not production-ready
- Ecosystem smaller than React/Tauri — fewer third-party component libraries
- Desktop webview mode has same cross-platform quirks as Tauri
- **Blitz renderer cannot embed iframes or run JS** — significant limitation
  for apps needing web content embedding

**Webview embedding:**

- In webview mode: `iframe` element works in RSX, `dangerous_inner_html` for
  raw HTML, `document::eval` for JS execution
- In Blitz/native mode: **No iframes, no JS interop.** This mode is
  incompatible with embedding web content.

**Terminal integration:**

- In webview mode: Same approach as Tauri — xterm.js via `document::eval`
  or `dangerous_inner_html`, PTY from Rust side
- In Blitz mode: Would need a pure-Rust terminal widget — significant work
- TUI renderer (Rink/dioxus-tui) exists but is **unmaintained** and
  incompatible with 0.6+

---

### 1.3 Leptos (v0.8)

**What it is:** Full-stack Rust web framework with fine-grained reactivity.
Components are setup functions that run once, creating reactive graphs. No
virtual DOM — signal changes update specific DOM nodes directly.

**Rendering targets:** CSR, SSR, hydration, islands architecture.

**Server functions:** `#[server]` async functions run on server, callable from
client. Uses `server_fn` crate (shared with Dioxus). Type-safe, auto-serialized.

**Desktop support:** Via Tauri only (official template in `create-tauri-app`).
**Important architectural mismatch:** Tauri doesn't run a server, so SSR and
`#[server]` functions don't work. Must use CSR mode + Tauri commands instead.
Shared component code works; backend communication layer differs.

**Pros:**

- Excellent performance (fine-grained reactivity, beats React/Vue in benchmarks)
- WASM code-splitting and lazy-loading (`#[lazy]`, `#[lazy_route]`)
- Islands architecture minimizes client-side WASM
- 17.7k stars, very active development (0.8.16 as of early 2026)

**Cons:**

- Pre-1.0, fast-moving API
- Desktop requires Tauri wrapper with different backend layer
- No native desktop renderer — web-only framework needing Tauri for desktop

**Dual-mode:** Good, with caveats. CSR for Tauri desktop, SSR/islands for web.
Shared components, but different backend communication.

---

### 1.4 Yew (v0.22)

**What it is:** Component-based Rust WASM framework modeled after React. Virtual
DOM architecture.

**Current status:** 30.5k stars (highest of Rust frontend frameworks) but
**development has slowed significantly.** Momentum has shifted to Leptos and
Dioxus. Virtual DOM is less performant than fine-grained reactivity. Experimental
SSR less mature than Leptos.

**Assessment:** Not recommended for new projects. Leptos and Dioxus are better
choices in every dimension.

---

### 1.5 Iced (v0.14)

**What it is:** Pure Rust, cross-platform GUI library following The Elm
Architecture (TEA). Retained-mode. GPU-accelerated via wgpu or CPU via
tiny_skia.

**Web support:** Compiles to WASM, renders to `<canvas>`. Web is a secondary
target — less polished than desktop.

**Webview embedding:** Not native. `iced_webview` community crate exists
(experimental, uses Ultralight/WebKit). Not first-class.

**Assessment:** Strong for pure-Rust native desktop GUIs. Poor fit for this use
case — no webview embedding, no SSR, canvas-only web, no terminal integration.

---

### 1.6 egui/eframe (v0.31)

**What it is:** Immediate-mode Rust GUI. Every frame, code emits UI commands.
Platform-agnostic — produces 2D shapes tessellated into triangles. eframe wraps
it for native (OpenGL/wgpu) and web (WASM canvas).

**Web support:** Same code compiles to both native and WASM. Renders to
`<canvas>`.

**Webview embedding:** Cannot natively embed webviews. `hframe` crate overlays
HTML elements as a hack. Not true embedding.

**Notable:** `egui_ratatui` crate renders ratatui TUI apps inside egui widgets.
Works on both desktop and WASM — unique terminal rendering capability.

**Assessment:** Used in production (Rerun Viewer). Good for tool UIs but
canvas-only rendering makes it unsuitable for embedding web content. The
`egui_ratatui` integration is interesting but insufficient for a full terminal
- web embedding use case.

---

### 1.7 Slint (v1.14)

**What it is:** Declarative Rust UI with a custom `.slint` DSL. Compile-time
code generation. Renderers: FemtoVG (OpenGL), Skia, software, WebGL.

**Key distinction:** Only framework in this comparison at 1.x. Stable API,
company-backed (SixtyFPS GmbH), professional tooling (LSP, Figma plugin).

**Web support:** WASM + WebGL to `<canvas>`. Positioned for demos/prototyping,
not production web apps.

**Webview embedding:** Cannot embed webviews. Renders to its own surface.

**Assessment:** Best maturity of any Rust GUI framework. Poor fit for this use
case — no webview embedding, web is a secondary concern, no terminal integration.

---

### 1.8 Plain Web Stack (Rust Backend + JS/TS Frontend + Tauri)

**What it is:** Axum/Actix backend + React/Svelte/Solid/Vue frontend + Tauri
wrapper for desktop. Two languages, maximum ecosystem maturity.

**Pros:**

- Every component is production-grade and battle-tested
- Largest talent pool (JS/TS developers)
- Richest tooling and component libraries
- iframe/webview embedding is trivial — it IS web
- Terminal: xterm.js is the standard, extensively documented
- SSR via Next.js/SvelteKit/Nuxt
- Tauri desktop: ~600KB-2MB bundles

**Cons:**

- Two languages (Rust + JS/TS) — no code sharing across boundary without
  codegen/serde bridges
- JS supply chain concerns
- Not "pure Rust"

**Dual-mode:** The most natural fit. Standard web deployment + Tauri wrapping.
Well-trodden path with many production examples.

---

## 2. Architecture Patterns for Dual-Mode

### 2.1 Tauri + Web Server Hybrid

Ship the same web frontend in Tauri for desktop, serve it via Axum for web.

**Recommended codebase structure (Cargo workspace):**

```
my-app/
  Cargo.toml              # workspace root
  crates/
    core/                  # shared business logic, no platform deps
    server/                # Axum web server, imports core
    tauri-app/             # Tauri desktop app, imports core
  frontend/                # JS/TS or Rust WASM frontend
    src/
    dist/                  # built assets for both Tauri and server
```

**Platform-specific features via:**

- Tauri commands for desktop-only (filesystem, PTY, native dialogs)
- Axum handlers for web-only (auth, multi-user sessions)
- Feature flags in `core` for conditional compilation
- Frontend runtime detection (`window.__TAURI__` vs browser)

**Gotcha:** Tauri owns its tokio runtime. If embedding Actix inside Tauri, spawn
it on a separate `std::thread` with its own runtime. Common discussion topic.

**Reference:** `jetli/rust-yew-axum-tauri-desktop` demonstrates this pattern.

### 2.2 WASM-First

Build the UI in Rust (Dioxus/Leptos) compiled to WASM. Same binary runs in
desktop webview and browser.

**Limitations:**

- No native system calls from WASM (filesystem, PTY, networking). Must bridge
  to host (Tauri commands for desktop, JS interop for browser).
- Binary size: Complex UIs can reach 20-25MB uncompressed. Optimization
  (wasm-opt, LTO, codegen-units=1) essential.
- Many Rust crates assume `std` with OS features — won't compile to
  `wasm32-unknown-unknown`.
- Limited threading (SharedArrayBuffer + Web Workers, not native threads).
- WASM debugging is immature.

**Success story:** Typst Studio uses Leptos 0.8 CSR compiled to WASM, deploying
the identical binary to web and Tauri. 73MB web → 5-10MB Tauri installer.

### 2.3 Shared Core, Platform Shells

A Rust core library shared between platforms, with separate UI per platform.

**[Crux](https://github.com/redbadger/crux):** Most mature implementation.
Elm-inspired, pure/side-effect-free Rust Core handles all business logic. Thin
Shell per platform handles UI and effects. Auto-generates types for Swift,
Kotlin, TypeScript via UniFFI/wasm-pack.

**Trade-off:** Build separate UIs per platform, but each gets a truly native UI.
Business logic and state management are fully shared and testable.

### 2.4 Server-Centric (Thin Wrapper)

Everything runs on a server. Desktop app is a webview pointing to localhost or
remote URL.

**Approaches:**

1. Tauri + embedded Axum on background thread, webview at `localhost:<port>`
2. Tauri as pure wrapper pointing at remote URL (site-specific browser)
3. Tauri sidecar: bundle a server binary, launch on startup

**Pros:** Simplest architecture, single source of truth.
**Cons:** Requires connectivity for remote. Desktop provides minimal native
value beyond window chrome and OS integration.

---

## 3. Terminal Embedding

### 3.1 PTY Libraries

| Library          | Notes                                                  |
|------------------|--------------------------------------------------------|
| `portable-pty`   | From WezTerm. Most mature. Cross-platform.             |
| `pty-process`    | Async-first, tokio integration. Lighter weight.        |
| `pseudoterminal` | Newer, cross-platform, async support.                  |

**portable-pty** is the recommended choice — extracted from a production
terminal emulator (WezTerm), handles platform differences comprehensively.

### 3.2 xterm.js Integration Pattern

```
[xterm.js (frontend)] <--WebSocket--> [Rust server] <--PTY--> [shell]
```

1. Frontend creates xterm.js Terminal, connects via WebSocket
2. Rust server (Axum) accepts WS upgrade
3. Server spawns PTY via portable-pty, bridges read/write between WS and PTY
4. Resize events: xterm.js → WS → server → `pty.resize(cols, rows)`

**For Tauri desktop:** Same pattern but using Tauri events/channels instead of
WebSocket. `tauri-plugin-pty` provides a ready-made integration.

**Key considerations:**

- Flow control: PTY can produce output faster than WS delivers. Need
  backpressure.
- Use binary WebSocket frames for raw terminal escape sequences (not text).
- Session management: map WS connections to PTY sessions, support reconnection.
- Heartbeat/keepalive for dead connection detection and PTY cleanup.

### 3.3 How Existing Tools Handle Terminals

**VS Code Remote:** Server spawns PTY, client connects via WebSocket. Terminal
data multiplexed alongside other RPC. Uses node-pty.

**Theia:** JSON-RPC over WebSocket. Separate WS connection per terminal,
multiplexed over a single physical WS.

**sshx:** Fully Rust. PTY on host, encrypted WebSocket to relay servers. Server
is a Hyper + Tonic gRPC + Axum hybrid. React + WebGL + xterm.js frontend.

---

## 4. Web Content Embedding (VS Code Web)

### 4.1 Available VS Code Web Servers

- **[code-server](https://github.com/coder/code-server)** (Coder): Runs VS
  Code as a server, accessible via browser.
- **[openvscode-server](https://github.com/gitpod-io/openvscode-server)**
  (Gitpod): Upstream VS Code running as a server.

### 4.2 iframe Embedding Challenges

**CSP:** VS Code's page sets restrictive Content-Security-Policy. To embed in
an iframe, code-server must send
`Content-Security-Policy: frame-ancestors 'self' https://your-app.com`.

**Authentication:** code-server uses `--connection-token`. Access via
`http://host:port/?tkn=your_token`. Production: OAuth2 proxy in front.

**CORS:** Different origins require `Cross-Origin-Resource-Policy: cross-origin`
headers on code-server. WebSocket connections also need CORS headers.

**Reverse proxy:** Must proxy both HTTP and WebSocket. Path rewriting can be
tricky — code-server expects root or configured base path.

### 4.3 Desktop (Tauri) Embedding

**iframes work** within Tauri's webview with CSP configuration. Target site
must not set `X-Frame-Options: DENY`.

**Multiwebview** (Tauri v2 unstable): Can create child webviews loading
external URLs. More control than iframes. Platform-specific requirements for
child webview creation (related views on Linux, shared environment on Windows).

**Electron advantage:** `BrowserView` and `<webview>` tag provide proper
embedded browser contexts with dedicated devtools, separate process, and
navigation events. This is one area where Electron is still superior to Tauri.

### 4.4 How Cloud IDE Platforms Handle This

**Gitpod:** Created openvscode-server. Container-based on Kubernetes. Browser
connects directly to container via WebSocket.

**GitHub Codespaces:** VM-based. VS Code Server inside VM. Browser connects to
`*.github.dev` which proxies to VM.

**Coder:** Self-hosted. Terraform-provisioned workspaces. Supports code-server,
JetBrains Gateway, Jupyter. Web terminal + VS Code web through dashboard.

**Common pattern:** Server process inside container/VM, exposed via
authenticated WebSocket/HTTP. Browser connects. VS Code Web frontend is same
codebase as desktop VS Code with platform-specific backends swapped.

---

## 5. Real-World Examples

### 5.1 Warp Terminal

**Best real-world example of dual-mode Rust.**

- Custom GPU-accelerated UI framework in Rust
- Desktop: Metal (macOS), DirectX (Windows), Vulkan (Linux)
- Web: Same Rust codebase cross-compiled to WASM, renders to HTML canvas via
  WebGL/WebGPU
- `bundled_or_fetched_asset!` macro for compile-time asset resolution
  (bundled for native, fetched for WASM)
- Custom font fallback for web (no OS font APIs in browser)
- WASM binary optimized from 21.4MB to 8MB gzip (65% smaller than desktop)
- Average screen redraw: 1.9ms, >144 FPS

**Key lessons:**

1. Cross-compiling Rust to WASM is viable for complex apps but requires
   significant platform abstraction
2. OS-provided features (fonts, clipboard, dialogs) need web reimplementations
3. WASM binary size optimization is real engineering work
4. Asset management must be compile-time conditional

### 5.2 Zed Editor

- Custom GPUI framework — hybrid immediate/retained mode, GPU-accelerated
- Targets 120 FPS on native Metal/DirectX/Vulkan
- **No web version exists or is planned.** GPUI renders via platform-specific
  GPU APIs, not webview/WASM
- Remote development via SSH (local native UI + remote server), but client
  must be native Zed app
- 200+ crates in Cargo workspace

**Takeaway:** Chose maximum native performance over web portability.

### 5.3 WezTerm

- GPU-accelerated terminal emulator and multiplexer in Rust
- Created `portable-pty` (used by many other projects)
- Client-server multiplexing: headless `wezterm-mux-server` + attachable GUI
  clients
- Codec-based RPC for remote terminal access (SSH, TLS)
- Not web-based, but architecture (separate mux server + attachable clients)
  is a model for multi-client terminal access

### 5.4 RustDesk

- Open-source remote desktop (TeamViewer alternative)
- Desktop client: Rust + Flutter (since v1.2.0)
- Web client available via WebSocket to relay servers
- P2P architecture with rendezvous/relay servers

### 5.5 sshx

- Collaborative terminal sharing, fully Rust backend
- CLI (Rust) + web frontend (React + xterm.js)
- Server: Hyper + Tonic gRPC + Axum hybrid
- End-to-end encrypted WebSocket tunnels

---

## 6. Comparative Matrix

| Approach              | Desktop       | Web            | Dual-mode | Embed Web Content | Terminal | Maturity    | Bundle        |
|-----------------------|---------------|----------------|-----------|-------------------|----------|-------------|---------------|
| **Tauri + JS/TS**     | Webview       | Standard web   | Best      | Trivial (iframe)  | xterm.js | Production  | 2-10 MB       |
| **Dioxus fullstack**  | Webview/WGPU  | WASM + SSR     | Good      | Webview mode only | Via JS   | Pre-1.0     | Moderate      |
| **Leptos + Tauri**    | Tauri webview | SSR/CSR/Islands| Good      | iframe in webview | Via JS   | Pre-1.0     | Excellent     |
| **Iced**              | wgpu native   | WASM canvas    | Partial   | Experimental      | No       | Pre-1.0     | Heavy WASM    |
| **egui**              | glow/wgpu     | WASM canvas    | Good      | No                | Partial  | Pre-1.0     | Moderate      |
| **Slint**             | Native render | WASM canvas    | Limited   | No                | No       | **1.x**     | Small         |
| **Yew + Tauri**       | Tauri webview | WASM VDOM      | Similar   | iframe in webview | Via JS   | Declining   | Larger        |
| **Custom (Warp-style)**| Native GPU   | WASM canvas    | Excellent | No                | Native   | Custom work | 8MB WASM      |

---

## 7. Key Tradeoffs and Decision Points

### Pure Rust vs. Rust + JS/TS

**Pure Rust (Dioxus/Leptos):**

- Single language, unified tooling, no JS supply chain
- Smaller ecosystem for UI components
- RSX macros are less ergonomic than JSX for complex UIs
- WASM debugging is immature
- Team must be comfortable with Rust for UI work

**Rust + JS/TS (Tauri + React/Svelte/Solid):**

- Largest ecosystem, best tooling, most hiring options
- Two-language boundary requires serialization bridges
- Proven at scale (ChatGPT desktop uses Tauri)
- iframe/webview embedding is trivial

### Webview-based vs. Native GPU Rendering

**Webview (Tauri, Dioxus webview mode):**

- Familiar web tech, huge component ecosystem
- iframe embedding works naturally
- Cross-platform webview inconsistencies (especially Linux WebKitGTK)
- Adequate performance for most apps

**Native GPU (Dioxus Blitz, Iced, Zed/Warp-style):**

- Maximum performance, consistent rendering
- Cannot embed web content (no iframes, no JS)
- Incompatible with the VS Code embedding requirement
- Much more engineering effort

### Server-centric vs. Client-heavy

**Server-centric (thin desktop wrapper):**

- Simplest architecture, one deployment target
- Desktop app is essentially a branded browser window
- Requires connectivity (even local mode needs localhost server)
- Less native feel

**Client-heavy (Tauri with offline capability):**

- Rich desktop experience with native integrations
- Works offline
- More complex: two deployment paths, feature-detection
- Desktop-specific features (system tray, file associations, etc.)

---

## 8. Assessment for the Use Case

Given the requirements (desktop + web, embed VS Code web, terminal rendering),
the field narrows significantly:

**Eliminated approaches:**

- Iced, egui, Slint — cannot embed web content (iframes/webviews)
- Dioxus Blitz/native mode — no iframe/JS support
- Custom GPU renderer (Zed/Warp-style) — no web content embedding, massive
  engineering effort

**Viable approaches (ranked by fit):**

### Tier 1: Best Fit

**1. Tauri + JS/TS frontend (React/Svelte/Solid)**

- Most mature, best ecosystem, trivial web content embedding
- Terminal: xterm.js + portable-pty, well-documented
- Dual-mode: natural — same frontend served by Axum for web, Tauri for desktop
- Trade-off: two languages

**2. Tauri + Leptos (CSR for desktop, SSR for web)**

- Pure Rust. Shared UI components, different backend layers.
- Terminal: xterm.js via JS interop in the webview
- Web content embedding: iframe in the webview
- Trade-off: Leptos is pre-1.0, CSR-only in Tauri means no server functions

### Tier 2: Good Fit with Caveats

**3. Dioxus fullstack (webview mode for desktop)**

- True single-codebase: web + desktop + mobile from one Rust project
- Fullstack mode with server functions, SSR, streaming
- Trade-off: pre-1.0 with breaking changes, smaller ecosystem
- Blitz mode is irrelevant for this use case (no iframe support)

**4. Tauri + Yew**

- Same pattern as Leptos+Tauri but with declining momentum. Not recommended
  over Leptos.

### Tier 3: Possible but Harder

**5. Crux (shared core, platform shells)**

- Maximum code sharing for business logic
- Separate UI per platform — more engineering work
- Best if native-feeling desktop UI matters more than code sharing for UI

---

## Sources

- Tauri v2 docs: <https://v2.tauri.app/>
- Tauri v2 architecture: <https://v2.tauri.app/concept/architecture/>
- Tauri localhost plugin: <https://tauri.app/plugin/localhost/>
- Tauri WebKitGTK issues: <https://github.com/tauri-apps/tauri/discussions/8524>
- Tauri webview embedding: <https://github.com/tauri-apps/tauri/issues/2709>
- Tauri + Axum dual target: <https://github.com/tauri-apps/tauri/discussions/11399>
- Dioxus 0.7 release: <https://github.com/DioxusLabs/dioxus/releases/tag/v0.7.0>
- Dioxus docs.rs: <https://docs.rs/crate/dioxus/latest>
- Dioxus 0.8 roadmap: <https://github.com/DioxusLabs/dioxus/discussions/5024>
- Leptos GitHub: <https://github.com/leptos-rs/leptos>
- Leptos + Tauri guide: <https://v2.tauri.app/start/frontend/leptos/>
- Crux framework: <https://github.com/redbadger/crux>
- Iced GitHub: <https://github.com/iced-rs/iced>
- egui GitHub: <https://github.com/emilk/egui>
- Slint: <https://slint.dev/>
- portable-pty: <https://docs.rs/portable-pty>
- tauri-plugin-pty: <https://crates.io/crates/tauri-plugin-pty>
- code-server: <https://github.com/coder/code-server>
- openvscode-server: <https://github.com/gitpod-io/openvscode-server>
- sshx: <https://github.com/ekzhang/sshx>
- Warp (how it works): <https://www.warp.dev/blog/how-warp-works>
- Warp (WASM binary size): <https://www.warp.dev/blog/reducing-wasm-binary-size>
- Zed: <https://zed.dev/>
- WezTerm: <https://github.com/wezterm/wezterm>
- RustDesk: <https://rustdesk.com/>
- Typst Studio + Tauri: <https://autognosi.medium.com/typst-studio-desktop-90-smaller-100-native-same-wasm-codebase-with-tauri-8dc43cbb199b>
- Tauri vs Electron: <https://www.dolthub.com/blog/2025-11-13-electron-vs-tauri/>
- rust-yew-axum-tauri-desktop: <https://github.com/jetli/rust-yew-axum-tauri-desktop>
- Theia architecture: <https://theia-ide.org/docs/architecture/>
- 2025 survey of Rust GUI libraries: <https://www.boringcactus.com/2025/04/13/2025-survey-of-rust-gui-libraries.html>
