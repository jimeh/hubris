# Research: Rust Backend + TypeScript Frontend — Stack Evaluation

Building on [research.md](research.md) which narrowed to "Rust backend + JS/TS
frontend" as the top approach. This document evaluates the specific options
within that stack: desktop shell (Tauri vs Electron), frontend framework, and
Rust server backend.

---

## 1. Desktop Shell: Tauri v2 vs Electron

### 1.1 Bundling & Distribution

#### Build Process

**Tauri v2:**

1. `tauri build` runs `beforeBuildCommand` (e.g., `vite build`) to produce
   static HTML/JS/CSS
2. `cargo build` compiles Rust backend, embeds frontend assets into binary
3. Bundler wraps binary into platform-specific installers

First build is slow (Rust compilation, minutes). Incremental builds faster
with `swatinem/rust-cache`. Requires Rust toolchain + platform-specific system
deps (e.g., `libwebkit2gtk-4.1-dev` on Linux).

**Electron:**

1. Frontend builds normally (Vite/webpack)
2. `electron-builder` or `electron-forge` packages source + `node_modules`
   alongside bundled Chromium + Node.js runtime
3. Platform-specific installers generated

Faster builds (no Rust compilation). Simpler toolchain (Node.js only).
Massive output because it includes Chromium.

#### Bundle Sizes (Real Numbers)

| Metric                  | Tauri v2    | Electron      |
|-------------------------|-------------|---------------|
| Minimal app installer   | ~2.5 MB     | ~85 MB        |
| Typical app installer   | 3-10 MB     | 80-150 MB     |
| On-disk after install   | 5-15 MB     | 150-300 MB    |

Levminer Authme comparison: 2.5 MB (Tauri) vs 85 MB (Electron). One migration
case study: 130 MB (Electron) → 8 MB (Tauri).

The difference is architectural: Tauri dynamically links the OS's webview.
Electron bundles an entire Chromium engine.

#### Installer Formats

| Platform | Tauri v2                   | Electron                                |
|----------|----------------------------|-----------------------------------------|
| macOS    | DMG, .app                  | DMG, .pkg, .app, MAS                    |
| Windows  | NSIS (.exe), MSI (WiX)     | NSIS, MSI, AppX/MSIX, Squirrel, Portable|
| Linux    | deb, rpm, AppImage         | deb, rpm, AppImage, Snap, Flatpak, pacman|

Electron has broader format support, especially AppX (MS Store) and
Snap/Flatpak on Linux.

#### Auto-Update

**Tauri `tauri-plugin-updater`:**

- Ed25519-like keypair signing. Mandatory — cannot be disabled.
- Update manifest is a static JSON file (S3, GitHub Gist, etc.) or dynamic
  endpoint
- Supports differential/delta updates
- CrabNebula Cloud provides hosted update infrastructure

**Electron `electron-updater`:**

- Relies on platform code signing (not its own signature scheme)
- macOS requires code signing for Squirrel.Mac updates
- Supports GitHub Releases, S3, generic HTTP servers
- Staged rollouts and download progress
- Third-party `ElectronSafeUpdater` adds Ed25519 verification

Key difference: Tauri forces cryptographic update signing by design.
Electron relies on platform certificates.

#### Code Signing

| Platform | Cost              | Notes                                   |
|----------|-------------------|-----------------------------------------|
| macOS    | $99/yr (Apple)    | Both handle notarization. Tauri via env vars, Electron via `@electron/notarize` |
| Windows OV| $200-250/yr      | Must be on HSM/hardware token since May 2023 |
| Windows EV| $270-625/yr      | Fully eliminates SmartScreen warnings   |
| Linux    | Free              | Optional GPG signing for package repos  |

Both frameworks support the same signing workflows. Same certificates.

#### Cross-Compilation / CI

Neither supports true cross-compilation for all targets from one machine.
Both need CI with macOS/Windows/Linux runners.

- **Tauri:** `tauri-apps/tauri-action` GitHub Action with matrix strategy
- **Electron:** `electron-builder` can build Windows from macOS/Linux. macOS
  builds only work on macOS.

---

### 1.2 Runtime Characteristics

#### Startup Time

| Framework | Cold Start        |
|-----------|-------------------|
| Tauri v2  | < 500 ms (~200ms) |
| Electron  | 1-2 seconds       |

#### Memory Usage

| Framework            | Idle         | Notes                                |
|----------------------|--------------|--------------------------------------|
| Tauri v2 (macOS)     | 30-40 MB     | WKWebView (WebKit)                   |
| Tauri v2 (Windows)   | ~100-150 MB  | WebView2 (Chromium-based!)           |
| Electron             | 200-300 MB   | Bundled Chromium on all platforms     |

**Critical caveat:** On Windows, Tauri uses WebView2 (Chromium-based, same
engine as Edge). Memory usage on Windows can approach Electron levels. The
dramatic savings are primarily on macOS (WKWebView) and Linux (WebKitGTK).

#### Webview Engine Differences

| Platform | Tauri Engine    | Implication                           |
|----------|-----------------|---------------------------------------|
| macOS    | WKWebView       | Safari/WebKit behavior                |
| Windows  | WebView2        | Chromium (Edge) behavior              |
| Linux    | WebKitGTK       | Version varies wildly by distro       |

**Electron:** Bundles a specific Chromium version. Same rendering everywhere.

This is Tauri's biggest DX pain point: you must test on three different
rendering engines. WebKit (macOS/Linux) and Chromium (Windows) can render CSS
and JS differently. WebKitGTK on older distros may be missing modern features.

Electron gives you consistent Chromium across all platforms but at the cost
of bundling it.

---

### 1.3 Rust Backend Integration

#### Tauri: Native

Rust is Tauri's native language. Backend code IS the Tauri application:

```rust
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}
```

```typescript
import { invoke } from '@tauri-apps/api/core';
const greeting = await invoke('greet', { name: 'World' });
```

- Commands are type-safe with automatic serde
- v2 supports raw binary payloads (protobuf, raw bytes)
- Channels API for streaming (PTY output, download progress)
- IPC implemented as pseudo-HTTP via custom protocols (no network)
- Commands run async on tokio

#### Electron: Bolt-on

Three options to integrate Rust:

1. **napi-rs (native Node module):** Best performance. Compiles Rust to a
   `.node` addon. Called from main process directly. Requires per-platform
   native builds.
2. **Sidecar process:** Separate Rust binary. Communicate via
   stdin/stdout, IPC sockets, or HTTP/WebSocket. More isolation, higher
   latency. No built-in lifecycle management.
3. **FFI (ffi-napi):** Call into Rust shared libs. Lower-level, more
   error-prone. Rarely used.

**Verdict:** Tauri wins decisively. Rust is native, zero friction, optimized
IPC. With Electron, you're bolting Rust onto Node.js — it works (napi-rs is
good) but adds compilation complexity and architectural boundaries.

---

### 1.4 Security

**Tauri v2:**

- Default-deny capability system. All OS/system access locked down by default.
- Granular per-window/per-webview permissions in config
- Frontend never directly accesses system APIs
- Smaller attack surface (no Node.js, no Chromium binary)
- Rust memory safety eliminates entire vulnerability classes
- System webview updates handled by OS vendor
- Fewer CVEs historically (younger project)

**Electron:**

- Historically permissive by default (Node.js accessible from renderer)
- Modern Electron (v12+): `contextIsolation` default on, sandbox default on
  since v20
- Security depends on correct configuration
- Bundled Chromium must be manually updated for patches
- Wider attack surface: V8 + Node.js + Chromium
- Notable CVEs:
  - CVE-2025-10585: V8 type-confusion bug affecting Electron apps
  - CVE-2025-55305: Code integrity bypass affecting Signal, 1Password, Slack
    via V8 heap snapshot tampering (Trail of Bits, Sept 2025)

---

### 1.5 Webview Embedding (VS Code Web / code-server)

This is the area where the two frameworks differ most significantly.

#### Tauri

**iframes:** Primary mechanism. Works but limited:

- Target site must not set `X-Frame-Options: DENY`
- CSP configuration needed in `tauri.conf.json`
- Communication via `postMessage` (no Tauri commands from iframe)
- Iframe shares same webview process (no process isolation)

**Multiwebview (unstable):** Multiple webview instances per window. As of
early 2026, **not production-ready**:

- Positioning/layout bugs (issue #10420)
- Only last child renders on some platforms (issue #11376)
- Focus events broken (issue #12568)
- Resizing stops working (issue #10131)
- Linux layout errors (issue #13071)

#### Electron

**WebContentsView (replacement for BrowserView):**

- Independent web content areas within a window
- Each view has its own renderer process with full process isolation
- Fine-grained navigation events, loading, and security policies
- Mature and battle-tested

**`<webview>` tag:** Deprecated but functional. iframe-like with process
isolation.

#### For Embedding VS Code Web

**Electron is significantly better for this.**

- VS Code itself is Electron. Architecture maps naturally.
- `WebContentsView` provides proper process isolation for the editor
- Fine-grained lifecycle control
- VS Code's web build can run with full Node.js backend access

With Tauri, you'd run code-server as a sidecar and load it in an iframe.
This works but limits integration depth and hits CSP issues. Multiwebview
is too unstable.

**However:** If the VS Code embedding is "just an iframe to a running
code-server" (i.e., a mostly independent embedded app, not deeply
integrated), then Tauri's iframe approach is adequate. The advantage
of Electron matters most when you need deep integration with the
embedded content.

---

### 1.6 Developer Experience

| Aspect          | Tauri v2                              | Electron                           |
|-----------------|---------------------------------------|------------------------------------|
| Hot reload      | Frontend HMR via Vite. Rust changes = recompile (seconds) | Frontend HMR. Main process: restart |
| Debugging       | WebInspector + lldb/gdb for Rust. CrabNebula DevTools | Chrome DevTools + Node.js inspector. More mature |
| Testing (E2E)   | WebDriver via tauri-driver. **macOS E2E not supported** | Playwright first-class support. All platforms |
| Docs            | Good, some gaps in advanced topics    | Excellent, 10+ years of community content |
| Community       | ~90k stars, ~17.7k Discord, growing   | ~120k stars, massive npm ecosystem |

---

### 1.7 Production Examples

**Electron (dev tools):** VS Code, Cursor, Hyper, Postman, GitHub Desktop,
Slack, Discord, 1Password, Obsidian, Figma (desktop wrapper)

**Tauri:** Pake, CrabNebula, various developer utilities. Growing but fewer
high-profile apps, especially in the IDE/terminal space.

**Switches:** Levminer Authme (Electron → Tauri, 85MB → 2.5MB). DoltHub
evaluated Tauri for Dolt Workbench but documented tradeoffs. Warp went native
Rust instead of either.

---

### 1.8 Summary: Tauri vs Electron

| Factor                    | Winner       | Margin   |
|---------------------------|--------------|----------|
| Bundle size               | Tauri        | 10-30x   |
| Startup time              | Tauri        | 2-4x     |
| Memory (macOS/Linux)      | Tauri        | 5-10x    |
| Memory (Windows)          | Roughly even | —        |
| Rust integration          | Tauri        | Decisive |
| Security model            | Tauri        | Significant |
| Auto-update               | Tie          | —        |
| Code signing / CI         | Tie          | —        |
| Webview embedding         | Electron     | Significant |
| Multiwebview              | Electron     | Decisive (Tauri's is broken) |
| E2E testing               | Electron     | macOS gap |
| Documentation / community | Electron     | Larger   |
| Cross-platform rendering  | Electron     | Consistent Chromium |

**Bottom line:**

If VS Code embedding needs deep integration (navigation control, process
isolation, lifecycle management) → **Electron** is the safer choice.

If VS Code embedding is "just an iframe to code-server" and Rust integration
- bundle size + security matter more → **Tauri** is the stronger choice.

---

## 2. Frontend Frameworks

### 2.1 React

**Current version:** React 19.2.x (stable Dec 2025). Next.js 16.

**Ecosystem:**

- 73.5M npm weekly downloads. Dominant market share.
- Component libs: MUI (5.8M weekly DL, 100+ components), Radix UI, shadcn/ui,
  AG Grid, TanStack Table
- xterm.js: Multiple maintained wrappers (xterm-react, xterm-for-react,
  @aspect-build/react-xtermjs). Best integration story.
- Split panes: `react-resizable-panels` (actively maintained, well-designed)
- Bundle: ~45 KB min+gzip (react + react-dom). Heaviest baseline.

**Tauri integration:** Official template. Vite dev server works seamlessly.
tauri-specta for typed commands. Most community examples.

**Electron integration:** Best-supported. electron-vite has first-class
templates.

**Rust backend communication:**

- REST: TanStack Query (React Query) is the gold standard
- WebSocket: native API + custom hooks
- Type sharing: all Rust-to-TS generators produce standard TS interfaces

**Performance:** Slowest of the five candidates (virtual DOM). Re-render
overhead is measurable for high-frequency updates (terminal). Requires careful
memoization.

**DX:** Moderate learning curve (hooks, stale closures, dependency arrays).
Best tooling (React DevTools, extensive IDE support). Most mature testing
ecosystem (Jest/Vitest + React Testing Library + Playwright).

**Verdict:** Safest choice by ecosystem metrics. Largest library selection.
Performance penalty manageable with discipline but requires it.

---

### 2.2 Svelte (5.x)

**Current version:** Svelte 5.45.x (stable). SvelteKit 2.20.x.

Svelte 5 introduced Runes ($state, $derived, $effect) — significant paradigm
shift from Svelte 4. Released Oct 2024, 14+ months of production use.

**Ecosystem:**

- 2.1M npm weekly downloads. ~82k GitHub stars.
- Component libs: Skeleton (complete design system, has Tauri-specific docs),
  shadcn-svelte (40+ components), Flowbite Svelte, SVAR DataGrid
- xterm.js: [xterm-svelte](https://github.com/BattlefieldDuck/xterm-svelte)
  — actively maintained, supports Svelte 4+5, addon management. Best dedicated
  wrapper outside React.
- Split panes: [svelte-splitpanes](https://github.com/orefalo/svelte-splitpanes)
  (full-featured)
- Bundle: ~2-3 KB min+gzip runtime. Compiles to imperative DOM operations.
  Framework disappears from output.

**Tauri integration:** Official template. SvelteKit guide in Tauri docs.
Some friction points:

- SvelteKit upgrades have broken Tauri compat (issue #8592)
- Tailwind CSS integration caused dev errors (issue #11710)
- SvelteKit dev mode random close-without-error (issue #8849)
- Must use `adapter-static` with SPA mode (disables SSR)
- Using plain Svelte via Vite (not SvelteKit) for desktop eliminates most
  of these issues.

**Electron integration:** electron-vite supports Svelte. Less battle-tested
than React.

**Rust backend communication:**

- REST: TanStack Svelte Query exists but Svelte 5 support being finalized.
  SvelteKit load functions for web. `$effect` + `fetch` for SPA mode.
- WebSocket: standard API + $state runes
- Type sharing: same tools, standard TS interfaces

**Web deployment from Axum:** Well-documented. Multiple reference repos:
Rust_Axum-SvelteKit, example-rust-embed-sveltekit, svelte-axum-project.
Can embed static files via `rust-embed`.

**Performance:** Second-fastest after SolidJS. Compiled output close to
hand-written DOM manipulation. No virtual DOM.

**DX:** Lowest learning curve. Template syntax close to HTML. Runes
intuitive once learned. Highest developer satisfaction (State of JS).
Vite was created by the Vue team but Svelte HMR is excellent.

**Verdict:** Best overall fit for this use case. Compiled output eliminates
re-render overhead for xterm.js. Dedicated xterm-svelte wrapper. Dedicated
svelte-splitpanes. Skeleton has Tauri docs. Multiple Axum reference
implementations. Smallest runtime. Highest developer satisfaction.

---

### 2.3 SolidJS

**Current version:** SolidJS 1.9.x. SolidStart 1.x.

**Ecosystem:**

- 1.5M npm weekly downloads. ~34k GitHub stars. Smallest community.
- Component libs: Kobalte (headless, ~Radix equivalent), Solid UI
  (shadcn-style), corvu (headless primitives). No mature data grid.
- xterm.js: **No wrapper.** Would need custom integration. But SolidJS's
  lack of re-renders makes this straightforward — mount once, feed data
  via signals.
- Split panes: **No dedicated library.** CSS-based solution or port required.
- Bundle: ~7 KB min+gzip. Second smallest.

**Tauri integration:** Official template. Known issues:

- `data-tauri-drag-region` attributes don't trigger Solid's event delegation
  correctly (custom titlebar)
- Font rendering differences between browser and Tauri webview

**Performance:** Top-ranked in js-framework-benchmark. Fine-grained reactivity
= no virtual DOM diff. Only exact DOM nodes that change get updated.
Architecturally ideal for terminal rendering.

**DX:** Moderate learning curve (similar to React hooks but signals/effects
model). Thinner ecosystem of examples/patterns. Solid DevTools less polished
than React/Vue.

**Verdict:** Best raw performance. Ideal architecture for terminal rendering.
But genuinely thin component library ecosystem — more custom work required.
Best if you prioritize runtime performance over ecosystem breadth.

---

### 2.4 Vue (3.5)

**Current version:** Vue 3.5.26. Nuxt 4.3.

**Ecosystem:**

- 7.4M npm weekly downloads. ~47k GitHub stars.
- Component libs: Vuetify (80+ Material Design components), PrimeVue (80+
  components), Naive UI, Element Plus
- xterm.js: **No maintained wrapper** (vue-term is 8 years stale). Custom
  composable required.
- Split panes: [splitpanes](https://antoniandre.github.io/splitpanes/)
  (well-maintained)
- Bundle: ~34 KB min+gzip. Middle of the pack.

**Tauri integration:** Official template. Minimal friction — Vue + Vite is the
most natural Vite pairing (same creator).

**Performance:** Third-fastest. Virtual DOM with compile-time optimizations.
Vapor Mode (compile-to-DOM) in development but not production-ready.

**DX:** Low-moderate learning curve. Excellent tooling (Vue DevTools is
production-quality). Vite HMR is fastest (reference implementation). Smoothest
DX alongside Svelte.

**Verdict:** Strong ecosystem but no compelling advantage over React for this
use case. Lacks xterm.js wrapper. Doesn't offer performance advantage to
justify smaller (though large) ecosystem vs React.

---

### 2.5 Preact

**Current version:** Preact 10.x.

**Strategy:** React compatibility via `preact/compat`. Inherits React's
ecosystem — but not perfectly. Libraries depending on React internals,
concurrent features, or Suspense may break.

- Bundle: ~4 KB min+gzip. Extremely small.
- xterm.js: React wrappers should work via compat. Untested.
- Component libs: Via React compat aliasing. Complex ones (MUI advanced
  features, AG Grid) may have edge cases.

**Verdict:** Not recommended for a complex desktop app. The compat layer
introduces risk without sufficient reward. The 41 KB savings over React is
meaningless in a Tauri app loading from disk. Best for bundle-sensitive
web-only apps.

---

### 2.6 Frontend Framework Comparison

| Dimension            | React       | Svelte      | SolidJS     | Vue         | Preact      |
|----------------------|-------------|-------------|-------------|-------------|-------------|
| Bundle (min+gz)      | ~45 KB      | ~2-3 KB     | ~7 KB       | ~34 KB      | ~4 KB       |
| npm weekly DL        | 73.5M       | 2.1M        | 1.5M        | 7.4M        | 11.5M       |
| Tauri template       | Official    | Official    | Official    | Official    | Official    |
| xterm.js wrapper     | Multiple    | xterm-svelte| **None**    | **Stale**   | React compat|
| Split panes          | react-resizable-panels | svelte-splitpanes | **None** | splitpanes | React compat |
| Component libs       | Massive     | Good        | Small       | Large       | React compat|
| Performance rank     | 4th         | 2nd         | **1st**     | 3rd         | ~React      |
| DX / satisfaction    | Good        | **Highest** | High        | High        | Good        |
| Axum serving refs    | Generic     | **Multiple**| Generic     | Generic     | Generic     |

**Ranking for this use case:**

1. **Svelte** — best fit. Compiled output, dedicated xterm/splitpane libs,
   Skeleton + Tauri docs, multiple Axum reference repos, smallest runtime,
   highest DX satisfaction.
2. **SolidJS** — best performance. Ideal for terminal rendering. But thin
   ecosystem = more custom work.
3. **React** — safest ecosystem choice. Largest library pool. Performance
   penalty manageable with discipline.
4. **Vue** — strong ecosystem but no compelling advantage over React here.
   Missing xterm wrapper.
5. **Preact** — not recommended for complex desktop apps.

---

## 3. Rust Server Backends

### 3.1 Axum (tokio-rs)

**Current version:** 0.8.x (0.8.0 released Jan 2025; 0.9 in dev).

| Attribute          | Detail                                          |
|--------------------|-------------------------------------------------|
| Async runtime      | Tokio (first-class, same maintainers)           |
| crates.io DL       | ~222M all-time                                  |
| GitHub stars       | ~20k+                                           |
| TechEmpower        | Top-10 across multiple categories               |

**WebSocket support:** Built-in via `axum::extract::ws::WebSocketUpgrade`.
Supports Text, Binary, Ping/Pong, Close natively. Binary frames work out of
the box — critical for terminal data. Uses tokio-tungstenite under the hood.

**Static file serving:** `tower-http::services::ServeDir`. SPA fallback:

```rust
let app = Router::new()
    .nest("/api", api_routes())
    .fallback_service(
        ServeDir::new("./frontend/dist")
            .not_found_service(
                ServeFile::new("./frontend/dist/index.html")
            )
    );
```

**Middleware:** Uses Tower ecosystem directly. Every Tower middleware works:
tower-http (CORS, compression, tracing, timeouts), tower-governor (rate
limiting), custom auth layers. Middleware shared across axum, tonic (gRPC),
hyper.

**Type generation (strongest argument):**

| Tool         | Axum Support                                       |
|--------------|---------------------------------------------------|
| ts-rs        | Works (framework-agnostic)                        |
| specta       | Native support, powers rspc and tauri-specta      |
| utoipa       | First-class `utoipa-axum` crate (OpenAPI 3.0)     |
| aide         | Purpose-built for Axum (code-first OpenAPI)       |
| rspc         | tRPC-like end-to-end type safety, uses specta     |
| tauri-specta | Tauri-specific typed invoke() bindings            |

**Tauri integration (strongest argument):**

- Both Tauri v2 and Axum use tokio. Same runtime, no conflicts.
- `tauri-axum`: Routes requests through Tauri's FFI bridge to Axum without
  opening a network socket (zero network overhead)
- `tauri-plugin-localhost`: Formal localhost serving pattern
- `tauri-specta`: Fully typed IPC with generated TS bindings
- Shared state: wrap Axum State and Tauri managed state in same `Arc<AppState>`

**Electron integration:**

- Sidecar pattern: compile Axum to standalone binary, Electron spawns as
  child process. Health-check endpoint for readiness.
- Keeps architecture identical to Tauri mode (HTTP/WebSocket interface).

**Production users:** Zed (collab server), Shuttle.rs, Discord (services),
Vector (Datadog). Surpassed Actix Web in 2023 Rust Developer Survey adoption.

---

### 3.2 Actix Web

**Current version:** 4.12.1 (Nov 2025).

| Attribute          | Detail                                          |
|--------------------|-------------------------------------------------|
| Async runtime      | Tokio 1.x (migrated from actix-rt in v4)       |
| crates.io DL       | ~59M all-time                                   |
| GitHub stars       | ~22k+                                           |
| TechEmpower        | Consistently #1 or #2                           |

**Performance:** 10-15% higher throughput than Axum under heavy concurrent
load. Handles highest number of concurrent connections in benchmarks.

**Middleware:** Own system (`Transform` + `Service` traits), NOT
Tower-compatible. tower-http, tower-governor, etc. do not work. Has own
ecosystem (actix-web-httpauth, actix-limitation).

**WebSocket concern:** Known issue where WebSocket context does not expose
backpressure signals for the outgoing buffer. If client is slow, server-side
buffer grows unboundedly. Needs manual bounded-channel mitigation. Real
concern for terminal streaming.

**Tauri integration:** Potential runtime conflict. v4 uses tokio but
historically had its own actix-rt. No equivalent to `tauri-axum` or
`tauri-specta`.

**Verdict:** Strong raw performance but non-Tower middleware is a significant
composability drawback. WebSocket backpressure issue needs manual mitigation.
Tauri integration less smooth than Axum. Community momentum shifted to Axum.

---

### 3.3 Rocket (v0.5.1)

- Slow release cadence (v0.5 took years of RC releases)
- Custom "Fairings" middleware (not Tower-compatible)
- No Tauri integration libraries
- Trails Axum and Actix in benchmarks
- Small addon ecosystem

**Verdict:** Excellent DX for simple CRUD APIs but poor fit for this project
due to slow releases, custom middleware, and no desktop integration ecosystem.

---

### 3.4 Warp (v0.4.1)

- Sporadic releases. Effectively in maintenance mode.
- Filter-based API becomes unwieldy for complex routing
- Historical Windows path traversal vulnerability
- No framework-specific tooling
- Creator went on to influence Axum

**Verdict:** Superseded by Axum in every dimension. Not recommended.

---

### 3.5 Poem (~3.x)

- `#![forbid(unsafe_code)]` — 100% safe Rust
- Built-in OpenAPI via `poem-openapi` (better integrated than utoipa)
- Experimental HTTP/3 support
- Small community (~4M DL vs Axum's ~222M)
- Single primary maintainer (bus factor risk)
- Non-Tower middleware
- No Tauri integration

**Verdict:** Underrated with good OpenAPI. Too risky for a complex project
given small community and single maintainer.

---

### 3.6 Rust Backend Comparison

| Framework   | Perf Rank | Tokio Native | Tower Compat | Tauri Integration | Type Gen     | Community |
|-------------|-----------|--------------|--------------|-------------------|--------------|-----------|
| **Axum**    | 2nd       | Yes          | **Yes**      | **Excellent**     | **Best**     | Largest   |
| Actix Web   | **1st**   | Yes (v4)     | No           | Possible          | Good         | 2nd       |
| Rocket      | 4th       | Yes          | No           | None              | Basic        | 3rd       |
| Warp        | 3rd       | Yes          | N/A          | None              | Basic        | Declining |
| Poem        | ~3rd      | Yes          | No           | None              | Good (built-in OpenAPI) | Small |

**Axum is the clear choice.** Tokio-native (shared runtime with Tauri),
Tower middleware ecosystem, best type generation story (utoipa-axum, aide,
tauri-specta), largest community, and purpose-built desktop integration
crates.

---

## 4. Type Generation Strategy (Rust → TypeScript)

This is framework-agnostic on the frontend side — all produce standard TS
interfaces. The strategy depends on which communication paths exist:

### For Tauri IPC Commands

**tauri-specta:** Generates typed `invoke()` wrappers from Rust types.
End-to-end type safety for Tauri commands. The recommended tool.

### For REST API (Axum → Browser)

**Option A: utoipa + utoipa-axum**

- Generates OpenAPI 3.0 spec from Rust handler macros
- Feed spec to `openapi-generator-cli` to produce a TypeScript client
- Also gives you Swagger UI for free
- More boilerplate (annotate every endpoint)

**Option B: ts-rs**

- `#[derive(TS)]` on shared types
- Generates `.ts` files at compile time
- Simpler, focused, no runtime cost
- Types only — doesn't generate API client code

**Option C: rspc**

- tRPC-like end-to-end type safety
- Adds its own routing layer alongside Axum
- Zero type validators needed on client
- More opinionated

### For WebSocket Messages (Terminal Data)

**ts-rs** for message envelope types. Terminal data itself is raw bytes
(binary WebSocket frames) — no type generation needed.

### Recommended Combo

- **tauri-specta** for Tauri IPC
- **utoipa + utoipa-axum** for REST API (OpenAPI spec + generated client)
- **ts-rs** for shared types that don't flow through endpoints (WS messages,
  shared enums/constants)

---

## 5. SSR Considerations

**Can the Rust server do SSR for JS frameworks?**

The `ssr_rs` crate embeds V8 and supports React 18, Svelte 5, SolidJS. The
`tuono` framework builds full-stack React SSR on Axum + ssr_rs. However:

- Binary size increase: V8 adds ~30-50 MB
- Significant complexity (separate build step, hydration, routing)
- For a dev tool: **SSR is overkill.** Serve SPA as static files. Users
  interact for extended sessions; first-paint time isn't critical.

**Recommendation:** Skip SSR. Serve the built frontend as static files via
`tower-http::ServeDir` or embed via `rust-embed`/`memory-serve`.

---

## 6. Dual-Mode Architecture (Desktop vs Browser)

All frontend frameworks handle this identically:

```typescript
const isTauri = '__TAURI_INTERNALS__' in window;

async function fetchData(endpoint: string, params: any) {
  if (isTauri) {
    return invoke('get_data', { endpoint, params });
  } else {
    return fetch(`/api/${endpoint}`, {
      method: 'POST',
      body: JSON.stringify(params),
    }).then(r => r.json());
  }
}
```

An abstraction layer at the data-fetching boundary keeps the UI code
environment-agnostic. SolidJS's `createResource` and Svelte's
runes/$effect make this slightly more ergonomic than React hooks (no
stale closure concerns), but the pattern is identical.

---

## 7. How the Pieces Fit Together

### If Tauri

```
┌─────────────────────────────────────────┐
│ Tauri App                               │
│ ┌─────────────────────────────────────┐ │
│ │ Webview (WKWebView/WebView2/GTK)   │ │
│ │ ┌─────────────────────────────────┐ │ │
│ │ │ Frontend (Svelte/React/Solid)   │ │ │
│ │ │ - xterm.js for terminal         │ │ │
│ │ │ - iframe for code-server        │ │ │
│ │ └─────────────────────────────────┘ │ │
│ └──────────┬──────────────────────────┘ │
│            │ invoke() IPC               │
│ ┌──────────▼──────────────────────────┐ │
│ │ Rust Backend                        │ │
│ │ - #[tauri::command] handlers        │ │
│ │ - portable-pty (terminal)           │ │
│ │ - Axum (optional, for web mode)     │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

For web mode, the same Axum server serves the same frontend build + provides
REST/WebSocket APIs. Frontend detects environment and switches communication
layer.

### If Electron

```
┌─────────────────────────────────────────┐
│ Electron App                            │
│ ┌─────────────────────────────────────┐ │
│ │ Chromium Renderer Process           │ │
│ │ ┌─────────────────────────────────┐ │ │
│ │ │ Frontend (Svelte/React/Solid)   │ │ │
│ │ │ - xterm.js for terminal         │ │ │
│ │ │ - WebContentsView for VS Code   │ │ │
│ │ └─────────────────────────────────┘ │ │
│ └──────────┬──────────────────────────┘ │
│            │ contextBridge IPC          │
│ ┌──────────▼──────────────────────────┐ │
│ │ Main Process (Node.js)              │ │
│ │ - preload scripts                   │ │
│ │ - spawns Rust sidecar               │ │
│ └──────────┬──────────────────────────┘ │
│            │ HTTP / WebSocket           │
│ ┌──────────▼──────────────────────────┐ │
│ │ Rust Sidecar (Axum binary)          │ │
│ │ - REST API handlers                 │ │
│ │ - WebSocket (terminal streaming)    │ │
│ │ - portable-pty (terminal)           │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

More layers (Node.js main process mediates), but VS Code embedding via
WebContentsView is first-class. Same Axum binary used for web mode.

---

## Sources

### Tauri vs Electron

- Hopp: Tauri vs Electron Real Trade-offs: <https://www.gethopp.app/blog/tauri-vs-electron>
- Levminer: Tauri vs Electron Real World: <https://www.levminer.com/blog/tauri-vs-electron>
- DoltHub: Electron vs Tauri (Nov 2025): <https://www.dolthub.com/blog/2025-11-13-electron-vs-tauri/>
- Mamezou: Porting Electron to Tauri 2.0: <https://developer.mamezou-tech.com/en/blogs/2025/12/01/porting-an-electron-app-to-tauri2/>
- RaftLabs: Tauri vs Electron 2025: <https://www.raftlabs.com/blog/tauri-vs-electron-pros-cons/>
- Tauri v2 Docs: <https://v2.tauri.app/>
- Tauri IPC: <https://v2.tauri.app/concept/inter-process-communication/>
- Tauri Security: <https://v2.tauri.app/security/capabilities/>
- Tauri Multiwebview Issues: #10420, #11376, #12568, #10131, #13071
- Tauri Memory (Windows): <https://github.com/tauri-apps/tauri/issues/5889>
- Trail of Bits CVE-2025-55305: <https://blog.trailofbits.com/2025/09/03/subverting-code-integrity-checks-to-locally-backdoor-signal-1password-slack-and-more/>
- V8 CVE-2025-10585: <https://dev.to/pentest_testing_corp/kev-v8-cve-2025-10585-hits-electron-apps-1ob1>

### Frontend Frameworks

- xterm-svelte: <https://github.com/BattlefieldDuck/xterm-svelte>
- svelte-splitpanes: <https://github.com/orefalo/svelte-splitpanes>
- Skeleton (Svelte): <https://skeleton.dev/>
- shadcn-svelte: <https://shadcn-svelte.com/>
- Kobalte (Solid): <https://kobalte.dev/>
- react-resizable-panels: <https://github.com/bvaughn/react-resizable-panels>
- xterm-react: <https://github.com/PabloLION/xterm-react>
- Svelte + Axum examples: <https://github.com/sv-LayZ/Rust_Axum-SvelteKit>, <https://github.com/thanhnguyen2187/example-rust-embed-sveltekit>
- SvelteKit + Tauri issues: #8592, #11710, #8849

### Rust Server Backends

- Axum 0.8.0 announcement: <https://tokio.rs/blog/2025-01-01-announcing-axum-0-8-0>
- Axum GitHub: <https://github.com/tokio-rs/axum>
- tauri-axum: <https://github.com/logankeenan/tauri-axum>
- tauri-specta: <https://github.com/specta-rs/tauri-specta>
- utoipa: <https://github.com/juhaku/utoipa>
- aide: <https://github.com/tamasfe/aide>
- rspc: <https://www.rspc.dev/>
- ts-rs: <https://github.com/Aleph-Alpha/ts-rs>
- specta: <https://github.com/specta-rs/specta>
- webterm (Actix + PTY): <https://github.com/fubarnetes/webterm>
- ssr_rs: <https://github.com/Valerioageno/ssr-rs>
- Actix WebSocket backpressure: <https://users.rust-lang.org/t/actix-websocket-back-pressure/49518>
- Axum Ecosystem: <https://github.com/tokio-rs/axum/blob/main/ECOSYSTEM.md>
