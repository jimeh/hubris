# Research: Web Serving & Remote Access — The Critical Path

Building on [research.md](research.md) and [research2.md](research2.md). This
document focuses on the **primary deployment mode**: running as a web server
accessed remotely from any browser. The desktop app wrapping is secondary — at
minimum the tool works as a web server accessed on `localhost`.

---

## 1. Architecture Overview

```
Browser (any)                      Server (Rust/Axum)
┌──────────────────┐              ┌────────────────────────┐
│  SPA (Svelte/    │  HTTPS/WSS   │  Axum Router           │
│  React)          │◄────────────►│                        │
│                  │              │  /api/*  → handlers    │
│  ┌────────────┐  │              │  /ws/*   → WS upgrade  │
│  │ xterm.js   │──┼── Binary WS ─┼─► PTY session manager │
│  │ (WebGL)    │  │              │     └─ portable-pty    │
│  └────────────┘  │              │     └─ shell process   │
│                  │              │                        │
│  ┌────────────┐  │              │  /vscode/* → reverse   │
│  │ iframe:    │──┼── HTTP/WS ───┼─► proxy to code-server │
│  │ code-server│  │              │                        │
│  └────────────┘  │              │  /*  → SPA fallback    │
│                  │              │     (static assets)    │
└──────────────────┘              └────────────────────────┘
```

---

## 2. Serving the SPA

### 2.1 Two Approaches: Embedded vs Disk

**Embedded in binary (`memory-serve`):**

```rust
use memory_serve::{load_assets, MemoryServe};

let memory_router = MemoryServe::new(load_assets!("../dist"))
    .index_file(Some("/index.html"))
    .into_router();

let app = Router::new()
    .nest("/api", api_routes)
    .merge(memory_router);
```

- Brotli-compresses text files at compile time, decompresses at startup
- Serves gzip or brotli based on client `Accept-Encoding`
- Automatic ETag + `If-None-Match` / `304 Not Modified`
- Configurable `Cache-Control`
- SPA routing (index_file)
- In debug: reads from disk dynamically (hot reload)
- Single-binary deployment — no `dist/` folder to ship

**Served from disk (`tower-http ServeDir`):**

```rust
let app = Router::new()
    .nest("/api", api_routes)
    .route("/ws/{*path}", get(ws_handler))
    .nest_service("/assets",
        ServeDir::new("dist/assets")
            .precompressed_br()
            .precompressed_gzip()
    )
    .fallback_service(
        ServeDir::new("dist")
            .fallback(ServeFile::new("dist/index.html"))
    );
```

- Reads from disk (OS page cache keeps hot files in memory)
- `precompressed_br()`/`precompressed_gzip()` serves pre-compressed `.br`/`.gz`
  files when client supports them — zero runtime CPU
- Handles `Last-Modified`/`If-Modified-Since` natively
- Does NOT generate ETags or set `Cache-Control` — add via middleware
- Does NOT support Range requests

**Verdict:** `memory-serve` for single-binary deployment (simplest distribution).
`ServeDir` with precompression for development or when assets change frequently.

### 2.2 Compression Strategy

| Approach                         | Latency     | CPU at serve time | Ratio   |
| -------------------------------- | ----------- | ----------------- | ------- |
| Pre-compressed brotli (level 11) | ~0          | ~0                | Best    |
| Pre-compressed zstd (level 19)   | ~0          | ~0                | Near-br |
| On-the-fly gzip                  | Per-request | Moderate          | Good    |
| On-the-fly brotli                | Per-request | High              | Best    |

**Recommendation:** Pre-compress static assets at build time. Use
`ServeDir::precompressed_br().precompressed_gzip()` or `memory-serve`
(handles this automatically). Reserve `tower-http::CompressionLayer` for
dynamic API responses only.

Build-time compression script:

```bash
find dist/ -type f \( -name '*.js' -o -name '*.css' \
  -o -name '*.html' -o -name '*.svg' -o -name '*.json' \) \
  -exec brotli --best {} \; \
  -exec gzip --best --keep {} \;
```

### 2.3 Cache Headers

Vite produces hashed filenames (e.g., `assets/index-a1b2c3.js`) which are
content-addressed and immutable.

| Asset type           | Cache-Control                           |
| -------------------- | --------------------------------------- |
| `assets/*.js/*.css`  | `public, max-age=31536000, immutable`   |
| `index.html`         | `no-cache` (must revalidate every time) |
| Fonts, images (hash) | `public, max-age=31536000, immutable`   |

Implementation via `tower-http::set_header::SetResponseHeaderLayer` on
nested routers — different policies for `/assets/*` vs root.

### 2.4 SPA Routing

```rust
let app = Router::new()
    .nest("/api", api_router)          // API: highest priority
    .route("/ws/{*path}", get(ws_handler))  // WebSocket
    .nest_service("/assets", assets)   // Static (hashed, immutable)
    .fallback_service(                 // SPA: everything else
        ServeDir::new("dist")
            .fallback(ServeFile::new("dist/index.html"))
    );
```

Axum tries routes in specificity order. `/api/*` and `/ws/*` matched first.
`/assets/*` next by ServeDir. Everything else hits the fallback, which tries
to find a file in `dist/` and falls back to `index.html` with 200 status.

### 2.5 HTTP/2 Support

Axum supports HTTP/1.1 and HTTP/2 via hyper. With TLS (axum-server + rustls),
HTTP/2 negotiated automatically via ALPN. Multiplexed streams let the browser
fetch all SPA assets concurrently over a single TCP connection.

HTTP/3: Not supported natively. Use Caddy in front if needed.

HTTP/2 Server Push: Not supported (deprecated by Chrome in 2022 anyway).

---

## 3. Terminal Streaming — The Critical Feature

### 3.1 Full Data Path

```
Keystroke → xterm.js onData → WS.send(binary)
→ network (0.5ms local, 20-200ms remote)
→ Axum WS recv → Message::Binary(bytes)
→ writer.write_all(&bytes) on PTY master fd
→ kernel PTY (~0.01ms)
→ shell processes, writes output
→ kernel PTY (~0.01ms)
→ reader.read(&mut buf) on PTY master fd (blocking thread)
→ tokio channel → Axum WS send(Message::Binary(data))
→ network return
→ xterm.js terminal.write(data)
→ WebGL/Canvas renderer paints
```

**Latency by hop (local loopback):**

| Hop                       | Time                           |
| ------------------------- | ------------------------------ |
| xterm.js key → WS send    | ~0.1ms                         |
| WS framing + network      | ~0.5ms                         |
| Axum recv + PTY write     | ~0.1ms                         |
| Kernel PTY round-trip     | ~0.02ms                        |
| Shell processing (echo)   | ~0.01ms                        |
| PTY read + channel + send | ~0.2ms                         |
| Network return            | ~0.5ms                         |
| xterm.js write + render   | 1-5ms (WebGL), 5-15ms (Canvas) |
| **Total local (WebGL)**   | **~3-7ms**                     |
| **50ms RTT remote**       | **~55ms**                      |

**Reference points:**

- Native xterm (X11): ~2.4ms
- User perception threshold: ~50-100ms before feeling sluggish
- Target for web terminal: **sub-50ms on good network**

### 3.2 portable-pty Integration

```rust
use portable_pty::{
    native_pty_system, CommandBuilder, PtySize,
};

let pty_system = native_pty_system();
let pair = pty_system.openpty(PtySize {
    rows: 24, cols: 80,
    pixel_width: 0, pixel_height: 0,
})?;

let mut cmd = CommandBuilder::new("/bin/bash");
cmd.cwd("/home/user");
cmd.env("TERM", "xterm-256color");
let child = pair.slave.spawn_command(cmd)?;
drop(pair.slave); // release slave fd after spawn

let reader = pair.master.try_clone_reader()?; // blocking Read
let writer = pair.master.take_writer()?;       // blocking Write
```

**Key details:**

- `try_clone_reader()` → `Box<dyn Read + Send>`. **Reads are blocking.**
  Must run on `tokio::task::spawn_blocking`.
- `take_writer()` → `Box<dyn Write + Send>`. Can only be called once.
- `resize(PtySize)` → Unix: `ioctl(TIOCSWINSZ)`, Windows: `ResizePseudoConsole`
- Platform: Unix uses `libc::openpty`, Windows uses ConPTY API

### 3.3 Axum WebSocket Handling

```rust
use axum::extract::ws::{
    WebSocket, WebSocketUpgrade, Message
};
use futures_util::{SinkExt, StreamExt};

async fn ws_handler(
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.max_message_size(1024 * 1024)
      .on_upgrade(handle_terminal)
}
```

**Use Binary frames, not Text.** Reasons:

1. No UTF-8 validation overhead
2. Terminal output can contain partial multi-byte sequences at buffer
   boundaries — Text frames would error and close the connection
3. Docker switched to binary frames for exactly this reason (moby/moby#30460)
4. Framing overhead is identical (1 bit difference in opcode)

### 3.4 The Bridge: PTY ↔ WebSocket

```rust
async fn handle_terminal(socket: WebSocket) {
    // Open PTY + spawn shell (see 3.2)
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Bounded channel for backpressure
    let (pty_tx, mut pty_rx) =
        tokio::sync::mpsc::channel::<Vec<u8>>(8);

    // PTY reader → channel (blocking thread)
    let reader_handle =
        tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if pty_tx.blocking_send(
                            buf[..n].to_vec()
                        ).is_err() {
                            break;
                        }
                    }
                }
            }
        });

    // Channel → WebSocket (with adaptive batching)
    let send_task = tokio::spawn(async move {
        let mut batch = Vec::with_capacity(16384);
        let mut interval = tokio::time::interval(
            Duration::from_millis(4) // ~250fps max
        );
        loop {
            tokio::select! {
                Some(data) = pty_rx.recv() => {
                    batch.extend_from_slice(&data);
                    if batch.len() < 128 {
                        // Small data = interactive,
                        // send immediately
                        let _ = ws_tx.send(
                            Message::Binary(
                                batch.drain(..)
                                     .collect::<Vec<_>>()
                                     .into()
                            )
                        ).await;
                    }
                    // else let timer flush (high throughput)
                }
                _ = interval.tick() => {
                    if !batch.is_empty() {
                        let _ = ws_tx.send(
                            Message::Binary(
                                batch.drain(..)
                                     .collect::<Vec<_>>()
                                     .into()
                            )
                        ).await;
                    }
                }
                else => break,
            }
        }
    });

    // WebSocket → PTY writer
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Binary(data) => {
                let _ = writer.write_all(&data);
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Cleanup: drop writer → EOF → shell gets SIGHUP
    drop(writer);
    drop(master);
    let _ = reader_handle.await;
    send_task.abort();
}
```

**Adaptive batching:** The `< 128 bytes` threshold sends interactive
keystrokes immediately (no batching delay). The 4ms timer coalesces
high-throughput output (e.g., `cat largefile`) into larger frames,
preventing xterm.js from being overwhelmed.

### 3.5 Flow Control / Backpressure

Without flow control, `cat /dev/urandom | hexdump` will:

1. PTY produces GB/s of output
2. Channel fills, WebSocket buffers grow
3. xterm.js write buffer hits 50MB limit → data discarded or crash

**Server-side:** The bounded mpsc channel (capacity 8 × 8KB = ~64KB in flight)
creates natural OS-level backpressure. When WebSocket can't send fast enough:
channel fills → `blocking_send` blocks → reader stops reading → kernel PTY
buffer fills → shell's `write()` to slave fd blocks.

**Client-side (xterm.js watermark approach):**

```javascript
const HIGH_WATERMARK = 100000; // bytes
const LOW_WATERMARK = 10000;
let pendingBytes = 0;
let paused = false;

ws.onmessage = (ev) => {
    pendingBytes += ev.data.byteLength;
    terminal.write(new Uint8Array(ev.data), () => {
        pendingBytes -= ev.data.byteLength;
        if (paused && pendingBytes < LOW_WATERMARK) {
            paused = false;
            ws.send(JSON.stringify({type: 'resume'}));
        }
    });
    if (!paused && pendingBytes > HIGH_WATERMARK) {
        paused = true;
        ws.send(JSON.stringify({type: 'pause'}));
    }
};
```

Server pauses PTY reading when it receives 'pause', resumes on 'resume'.
This spans flow control across the full pipeline.

### 3.6 WebSocket Compression

**tungstenite does NOT support permessage-deflate** (open issue since 2017).

**Alternatives:**

- Reverse proxy (nginx/Caddy) in front with its own permessage-deflate
- Application-level zstd/lz4 compression before binary frames
- `yawc` crate (Rust WebSocket lib with permessage-deflate support)

Terminal data compresses well (repetitive escape sequences, whitespace).
3:1 to 10:1 ratio typical. For LAN use, skip compression. For WAN, the
bandwidth savings outweigh the ~0.1-0.5ms compression overhead.

### 3.7 Predictive Local Echo

For high-latency connections (>100ms RTT), typing feels sluggish because
each keystroke must round-trip. Mosh pioneered the solution: render typed
characters locally before server confirmation, reconcile when response
arrives.

The `xterm-zerolag-input` npm package implements this for xterm.js: renders
a DOM overlay at cursor position showing predicted characters, removes it
when server confirms. Underlines unconfirmed predictions (Mosh convention).

sshx also implements predictive echo in its web client.

---

## 4. xterm.js Deep Dive

### 4.1 Rendering Modes

**WebGL renderer (`@xterm/addon-webgl`):**

- WebGL2 with vertex/fragment shaders
- Dynamic texture atlas (512×512 → up to 4096×4096)
- **Up to 900% faster** than canvas
- Handles WebGL context loss (OOM, system suspend)
- Use as default, fall back to Canvas on error

**Canvas renderer (`@xterm/addon-canvas`):**

- Canvas2D API with layered architecture
- Shared character atlas for glyph caching
- CPU-bound, slower but more compatible

**DOM renderer (built-in default):**

- HTML `<span>` elements with CSS
- Slowest but most compatible

```javascript
const term = new Terminal();
term.open(container);
try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
        webgl.dispose();
        term.loadAddon(new CanvasAddon());
    });
    term.loadAddon(webgl);
} catch {
    term.loadAddon(new CanvasAddon());
}
```

### 4.2 Write Buffer Internals

- `write()` is non-blocking, queues data in WriteBuffer
- Processing budget: **12ms per event loop tick**
- Uses microtasks for better input latency (since 5.1.0)
- `DISCARD_WATERMARK`: 50MB hardcoded — exceeding = data loss
- Throughput: 5-35 MB/s depending on content + renderer

### 4.3 Key Addons

| Addon                         | Purpose                          |
|-------------------------------|----------------------------------|
| `@xterm/addon-fit`            | Auto-resize to container         |
| `@xterm/addon-webgl`          | GPU-accelerated rendering        |
| `@xterm/addon-canvas`         | Canvas2D fallback                |
| `@xterm/addon-web-links`      | Clickable URLs                   |
| `@xterm/addon-search`         | Find text in buffer              |
| `@xterm/addon-serialize`      | Export buffer to VT/HTML         |
| `@xterm/addon-image`          | Inline images (sixel, iTerm2)    |
| `@xterm/addon-unicode11`      | Correct unicode character widths |
| `@xterm/addon-clipboard`      | Browser clipboard access         |
| `@xterm/addon-attach`         | WebSocket attach helper          |

### 4.4 Memory: Scrollback Buffer

~160 bytes per line (80-col terminal). 10k lines ≈ 1.6 MB, 100k ≈ 16 MB.

---

## 4B. ghostty-web as xterm.js Alternative

### 4B.1 What It Is

[ghostty-web](https://github.com/coder/ghostty-web) is Coder's web terminal
emulator that wraps Ghostty's VT100 parser (the same code from the native
Ghostty terminal) compiled to WASM. It provides an xterm.js-compatible API,
aiming to be a near drop-in replacement. MIT licensed, published on npm as
`ghostty-web` (currently v0.4.0).

- **Created**: Nov 2025 by Coder (the company behind code-server)
- **Stars**: ~2,000 (as of Feb 2026)
- **Activity**: Active development, recent commits (Feb 2026), community PRs
- **Production use**: Coder uses it in their Mux desktop application

### 4B.2 Architecture

```
Browser                             WASM Module
┌──────────────────────┐           ┌─────────────────────┐
│  Terminal (TS)       │           │  ghostty-vt.wasm    │
│  ├─ InputHandler     │──keys───►│  ├─ VT100 parser    │
│  │  (KB→escape seq)  │          │  ├─ screen buffer   │
│  ├─ CanvasRenderer   │◄─cells──│  └─ terminal state  │
│  │  (Canvas2D, 60fps)│          └─────────────────────┘
│  ├─ SelectionManager │          Built from actual Ghostty
│  ├─ LinkDetector     │          source + minimal patch
│  └─ FitAddon         │          (~400KB WASM bundle)
└──────────────────────┘
```

The WASM binary is built from the real Ghostty source (cloned as submodule,
compiled via Zig) with a small patch (`ghostty-wasm-api.patch`) to expose the
web API surface. This means the VT parser is battle-tested native code, not a
JS reimplementation.

### 4B.3 Rendering: Canvas2D with Dirty Tracking

Unlike xterm.js which offers DOM/Canvas/WebGL rendering via addons, ghostty-web
uses a **single Canvas2D renderer** built in:

- **Two-pass rendering**: backgrounds first, then text/decorations
- **Dirty line tracking**: only redraws changed lines
- **Zero-allocation render loop**: reuses cell object pool after warmup
- **RenderState API**: pre-computed snapshot in 2 WASM calls per frame
  (vs ~1,920 per-cell calls naively — 960x reduction)
- **60 FPS** via requestAnimationFrame

No WebGL support. This is a significant difference — xterm.js's WebGL renderer
claims up to **900% faster** than Canvas. For most terminal workloads this
won't matter (terminal output rarely pushes rendering limits), but for
high-throughput scenarios like `cat`ing large files it could be noticeable.

### 4B.4 API Compatibility with xterm.js

Migration is designed to be changing the import:

```javascript
// Before (xterm.js)
import { Terminal } from '@xterm/xterm';
// After (ghostty-web)
import { init, Terminal } from 'ghostty-web';
await init(); // loads WASM — extra async step required
```

**Compatible APIs**: `cols`, `rows`, `element`, `textarea`, `buffer`,
`onData`, `onResize`, `onBell`, `onSelectionChange`, `onKey`,
`onTitleChange`, `onScroll`, `onRender`, `onCursorMove`, `write()`,
`resize()`, `loadAddon()`.

**Addon compatibility**: Implements `ITerminalAddon` interface. Provides its
own `FitAddon`. But **xterm.js-specific addons don't work**:

- WebGL/Canvas addons — N/A (internal renderer)
- Search addon — ghostty-web has no equivalent yet
- Serialize addon — no equivalent
- Image addon (sixel) — not supported yet (open issue #111)
- Web links — has its own OSC8 + URL regex link detection
- Unicode — built-in Unicode 15.1 (no addon needed)
- Attach — trivial to implement manually

### 4B.5 Performance Comparison

| Metric                   | xterm.js (WebGL)      | ghostty-web       |
|--------------------------|-----------------------|-------------------|
| Renderer                 | WebGL2 + texture atlas| Canvas2D + dirty  |
| VT parser                | JavaScript            | WASM (native)     |
| Parse speed              | JS speed              | 5-10x faster      |
| Render speed (relative)  | Fastest (GPU)         | Slower (CPU)      |
| Memory (typical)         | 15-25 MB              | 6-9 MB            |
| Bundle size (npm)        | ~5.9 MB + 2.4 MB(WGL)| ~2.2 MB           |
| WASM overhead            | None                  | ~400KB + init     |
| Complex scripts          | Issues with some      | Proper grapheme   |
| Scrollback               | Configurable          | Up to 100K lines  |
| Thread model             | Main thread           | Main thread       |

**Key takeaway**: ghostty-web is faster at *parsing* (WASM), xterm.js is
faster at *rendering* (WebGL GPU). For our use case (interactive terminal with
moderate output), parsing speed rarely bottlenecks — rendering is more likely
to matter during high-throughput output.

### 4B.6 Known Limitations (as of v0.4.0)

- **No sixel/image support** — xterm.js has `@xterm/addon-image`
- **No search** — xterm.js has `@xterm/addon-search`
- **No serialize** — can't export buffer to VT/HTML
- **Canvas2D only** — no WebGL path for GPU acceleration
- **Main thread only** — WASM core is single-threaded
- **Theme changes after `open()`** — limited/partial support
- **Korean IME** — Hangul input not working (issue #119)
- **iOS Safari** — context menu/selection handle issues
- **Unicode line gaps** — rendering issues with some box-drawing chars (#126)
- **Ghost cursor at (0,0)** on initialization (#122)

### 4B.7 Advantages Over xterm.js

- **VT correctness**: Battle-tested Ghostty parser, same code as native app
- **Complex script rendering**: Proper Devanagari, Arabic, CJK grapheme
  handling where xterm.js has known issues
- **XTPUSHSGR/XTPOPSGR**: Full support (xterm.js lacks this)
- **Memory efficiency**: ~60% less memory
- **Smaller bundle**: ~2.2 MB vs ~8.3 MB (xterm + WebGL addon)
- **Zero runtime dependencies**
- **Backed by Coder**: Same company that makes code-server — they're using
  it in production and have strong incentive to maintain it

### 4B.8 Head-to-Head Evaluation for This Project

| Factor                    | xterm.js           | ghostty-web        | Winner      |
|---------------------------|--------------------|--------------------|-------------|
| Maturity/stability        | 10+ years, v5.5    | ~4 months, v0.4    | xterm.js    |
| Ecosystem/addons          | Rich (10+ addons)  | Minimal (FitAddon) | xterm.js    |
| Community/docs            | Huge, extensive     | Small, growing     | xterm.js    |
| Rendering performance     | WebGL (GPU)        | Canvas2D (CPU)     | xterm.js    |
| VT parsing correctness    | Good, some gaps    | Excellent (native) | ghostty-web |
| Complex script support    | Partial            | Full               | ghostty-web |
| Memory footprint          | 15-25 MB           | 6-9 MB             | ghostty-web |
| Bundle size               | ~8.3 MB            | ~2.2 MB            | ghostty-web |
| Image/sixel support       | Yes (addon)        | No                 | xterm.js    |
| Search in buffer          | Yes (addon)        | No                 | xterm.js    |
| Drop-in replaceability    | N/A (baseline)     | High (API compat)  | Tie         |
| Long-term trajectory      | Stable, slow moves | Fast evolution     | TBD         |
| Production proven at scale| VS Code, many apps | Coder Mux only     | xterm.js    |

### 4B.9 Recommendation

**Start with xterm.js, keep ghostty-web as a planned migration target.**

Reasoning:

1. xterm.js is mature, battle-tested at massive scale (VS Code uses it), and
   has the addon ecosystem we need (search, serialize, images, WebGL).
2. ghostty-web is promising but at v0.4 with notable gaps (no search, no
   images, no WebGL, IME issues).
3. The API compatibility layer means switching later is low-cost — it's
   designed as a drop-in replacement.
4. ghostty-web's trajectory is strong: Coder is invested (they built
   code-server), the Ghostty WASM core is solid, and the project is actively
   developed.
5. By the time we reach production, ghostty-web may have closed most gaps
   (search, images, etc.), making it the better choice then.

**Mitigation**: Abstract the terminal component behind a thin wrapper so the
xterm.js → ghostty-web swap is isolated to one file:

```typescript
// terminal-adapter.ts
export interface TerminalAdapter {
    open(container: HTMLElement): void;
    write(data: string | Uint8Array): void;
    onData(cb: (data: string) => void): void;
    resize(cols: number, rows: number): void;
    dispose(): void;
    fit(): void;
}
```

Both xterm.js and ghostty-web conform to this interface trivially.

---

## 5. Session Management & Reconnection

### 5.1 Architecture: Session Registry

```rust
struct SessionManager {
    sessions: DashMap<SessionId, Session>,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    output_tx: mpsc::Sender<Vec<u8>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    replay_buffer: Arc<Mutex<CircularBuffer>>,
    last_active: Instant,
}
```

### 5.2 Reconnection Strategy

When WebSocket disconnects:

1. Don't kill the PTY. Keep session alive in the registry.
2. Buffer PTY output in a circular ring buffer (e.g., last 64 KB).
3. On reconnect: client sends session ID + last sequence number.
4. Server replays buffered output from that point.
5. Session timeout (e.g., 5 minutes) → kill orphaned PTYs.

**Alternative:** Use `@xterm/addon-serialize` to snapshot the terminal
state. On reconnect, send the full snapshot instead of replaying output.

Coder uses UUID-based reconnection tokens with a configurable circular
buffer or GNU screen backend. sshx uses per-shell sequence numbers with
periodic sync every 5 seconds.

### 5.3 Multiple Terminals

**Pattern: One WebSocket per terminal session** (not multiplexed).

This is what Theia does for its terminals. Simplest, independent
backpressure per session, no head-of-line blocking. Modern browsers handle
hundreds of concurrent WebSocket connections.

Server uses `DashMap<SessionId, Session>` to track active sessions.

---

## 6. Reverse Proxy for code-server

### 6.1 Proxying Through Axum

```rust
use axum_reverse_proxy::ReverseProxy;

let vscode_proxy =
    ReverseProxy::new("http://127.0.0.1:8080");

let app = Router::new()
    .nest("/api", api_routes)
    .nest("/vscode", vscode_proxy.into_router())
    .route("/ws/{*path}", get(ws_handler))
    .fallback_service(spa_service);
```

`axum-reverse-proxy` (v0.4+):

- Auto-detects WebSocket upgrade requests and proxies them
- RFC 9110 compliant header processing
- Connection pooling with keepalive
- Sets `TCP_NODELAY` for low-latency proxying

### 6.2 code-server Configuration

- Set `--base-path=/vscode` so code-server expects the path prefix
- May need to strip/adjust `X-Frame-Options` and CSP headers that
  code-server sets (defaults to `DENY` for framing)
- Add `X-Forwarded-For`, `X-Forwarded-Proto`, `Host` headers manually

### 6.3 CSP for iframes

```rust
let csp = SetResponseHeaderLayer::overriding(
    CONTENT_SECURITY_POLICY,
    HeaderValue::from_static(
        "default-src 'self'; \
         frame-src 'self'; \
         connect-src 'self' wss://your-domain.com; \
         script-src 'self' 'unsafe-eval'; \
         style-src 'self' 'unsafe-inline'"
    ),
);
```

code-server patches VS Code's CSP to serve webviews from the same origin,
which simplifies iframe embedding.

---

## 7. TLS / HTTPS

### 7.1 Direct TLS in Axum

```rust
use axum_server::tls_rustls::RustlsConfig;

let config = RustlsConfig::from_pem_file(
    "certs/cert.pem", "certs/key.pem"
).await?;

axum_server::bind_rustls("0.0.0.0:443".parse()?, config)
    .serve(app.into_make_service())
    .await?;
```

HTTP/2 negotiated automatically via ALPN. Certificate hot-reload supported
via `config.reload_from_pem_file()`.

### 7.2 Let's Encrypt / ACME

Options:

- `rustls-acme`: TLS-ALPN-01 challenge on same port (443). Simplest.
- `instant-acme`: All challenge types (HTTP-01, DNS-01, TLS-ALPN-01).
  Most flexible.

Must cache certificates and account keys to avoid rate limits.

### 7.3 When to Use a Reverse Proxy Instead

| Direct Axum TLS                          | Reverse Proxy (Caddy/nginx)              |
|------------------------------------------|------------------------------------------|
| Single-service, single-binary deployment | Multiple services behind one entry point |
| Self-contained tool for users to deploy  | Need HTTP/3 (Caddy supports it natively) |
| Fewer moving parts                       | Need advanced load balancing / WAF       |
| Handle TLS via ACME in code              | Want zero-config HTTPS (Caddy)           |

**Caddy is the easiest reverse proxy choice:** Automatic HTTPS, WebSocket
"just works", HTTP/3, minimal config:

```
your-domain.com {
    reverse_proxy localhost:3000
}
```

---

## 8. Authentication & Security

### 8.1 Auth Pattern for SPA

1. Login endpoint (`POST /api/auth/login`) validates credentials
2. Sets `HttpOnly, Secure, SameSite=Strict` session cookie
3. All subsequent requests include cookie automatically
4. API middleware checks for valid session
5. SPA index.html served without auth; SPA shows login if API returns 401

```rust
use tower_sessions::{SessionManagerLayer, MemoryStore};

let session_layer = SessionManagerLayer::new(
    MemoryStore::default()
)
    .with_secure(true)
    .with_http_only(true)
    .with_same_site(SameSite::Strict);
```

### 8.2 Protecting WebSocket Connections

Auth must happen **before** WebSocket upgrade (middleware doesn't apply
after upgrade):

```rust
async fn ws_handler(
    session: Session,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let user_id: Option<String> =
        session.get("user_id").await.ok().flatten();
    match user_id {
        Some(uid) => ws.on_upgrade(move |socket| {
            handle_terminal(socket, uid)
        }),
        None => StatusCode::UNAUTHORIZED.into_response(),
    }
}
```

Alternative: one-time ticket in URL query parameter for WebSocket clients
that can't set headers. Short-lived (30-60s), bound to user session.

### 8.3 OAuth2/OIDC

Key crates:

- `oauth2`: Generic OAuth2 client
- `openidconnect`: OIDC discovery + ID token validation
- `axum-login`: User identification middleware

Also support external auth proxies (Pomerium, oauth2-proxy, Cloudflare
Access) — low-effort, high-value.

### 8.4 Terminal Security

- Set `TERM=xterm-256color` (avoids dangerous legacy sequences)
- xterm.js is safe from the worst escape sequence attacks (no file writes)
- Consider disabling OSC 52 (clipboard access) — malicious programs could
  set clipboard content
- Rate limit new WebSocket connections (e.g., 10/minute)
- Limit concurrent terminals per user (e.g., 5)
- Limit max session duration (e.g., 24 hours)

### 8.5 Audit Logging

Record in [asciicast v2 format](https://asciinema.org/) for replay:
`[timestamp, "o", "data"]` for output, `[timestamp, "i", "data"]` for input.

---

## 9. Concurrent Connection Capacity

### 9.1 WebSocket Limits

Axum on tokio handles tens of thousands of concurrent WebSockets. For
10 users × 3 terminals = 30 WebSockets: **trivially handled.**

**Per-connection overhead:**

- TCP socket buffer: ~87 KB default (tunable)
- tokio task: ~500 bytes - 2 KB
- Application state: depends on data
- **Total: ~10-50 KB per idle connection**

30 connections ≈ ~1.5 MB memory. No tuning needed.

**Production limit:** File descriptors. Default `ulimit -n` is 1024.
Set `LimitNOFILE=65536` in systemd for production.

Benchmarks show tokio handles 15,000+ concurrent WebSockets on a
16-core/32GB machine with p95 latency of 9.5ms.

---

## 10. First Load Performance

### 10.1 Cold Load Timeline (100ms RTT, HTTP/2 over TLS)

| Step                           | Time       |
|--------------------------------|------------|
| DNS + TCP + TLS handshake      | ~300ms     |
| index.html fetch               | ~100ms     |
| JS/CSS fetch (multiplexed h2)  | ~100-200ms |
| JS parse + execute             | ~50-200ms  |
| **Total time-to-interactive**  | **~550-800ms** |

### 10.2 Subsequent Loads (cached assets)

Only index.html revalidation + JS init: **~200-350ms**

### 10.3 Page Load to Interactive Terminal

1. HTML + JS loads: ~550-800ms (cold) or ~200ms (warm)
2. JS init + auth: ~50-100ms
3. WebSocket upgrade handshake: 1 RTT (~100ms)
4. Terminal ready: ~50ms

- **Cold: ~750-1050ms, Warm: ~350-450ms** to interactive terminal

### 10.4 Optimizations

1. Pre-compressed brotli assets (60-80% smaller)
2. HTTP/2 multiplexing (all assets over single TCP connection)
3. Hashed filenames + immutable caching (cache forever)
4. Code splitting via Vite (only load initial route)
5. Service worker for faster subsequent loads
6. `memory-serve` or `rust-embed` for zero-disk-IO serving

---

## 11. How Existing Tools Do It

### 11.1 Patterns Summary

| Tool           | Server       | Terminal Protocol     | Reconnection              |
|----------------|--------------|----------------------|---------------------------|
| **Coder**      | Go (chi)     | Length-prefixed JSON + raw bytes | UUID token + circular buffer |
| **code-server**| Node (Express)| VS Code native binary | VS Code reconnection      |
| **Theia**      | Node         | JSON-RPC over shared WS | None built-in             |
| **JupyterLab** | Python (Tornado)| Per-terminal WS    | None (process persists)   |
| **sshx**       | Rust (Axum)  | CBOR over WS         | Sequence numbers + sync   |
| **ttyd**       | C (libwebsockets)| Raw binary WS    | None                      |
| **Cockpit**    | C            | Channel-multiplexed WS | Session-based             |

### 11.2 What Makes Them Feel Fast

1. **TCP_NODELAY** on all connections (sshx, ttyd)
2. **WebGL renderer** for xterm.js (ttyd default, Theia, sshx)
3. **Binary WebSocket frames** (not JSON-wrapped)
4. **Predictive local echo** (sshx, Mosh)
5. **WebSocket compression** (code-server enables permessage-deflate)
6. **Service worker caching** (code-server PWA)
7. **Embedded assets** (Coder: go:embed, single binary)
8. **Edge relays** (sshx: Fly.io, Coder: workspace proxies)
9. **Heartbeat pings** to prevent proxy idle timeouts

### 11.3 Auth Patterns

| Sophistication | Pattern                  | Used By                    |
|----------------|--------------------------|----------------------------|
| Simple         | Password/token           | code-server, ttyd          |
| Standard       | Session cookies          | Most browser-based tools   |
| Production     | OAuth2/OIDC              | Coder, Teleport, JupyterHub|
| Hardened       | Short-lived certificates | Teleport                   |
| External proxy | Pomerium/oauth2-proxy    | code-server production     |
| Zero-trust     | E2E encryption           | sshx (server never sees data)|

### 11.4 VS Code Embedding

Two patterns observed:

1. **Reverse proxy** (Coder): Routes to code-server in workspace via
   Terraform-defined `coder_app`. Authenticated proxy.
2. **Direct serving** (code-server/openvscode-server): IS VS Code with
   modifications for web serving.

For our use case: reverse proxy to code-server, embedded in iframe with
CSP adjustments.

---

## 12. Production Deployment

### 12.1 Systemd Service

```ini
[Unit]
Description=Hubris2 Web Server
After=network.target

[Service]
Type=exec
ExecStart=/usr/local/bin/hubris2
Restart=on-failure
RestartSec=5
LimitNOFILE=65536
Environment=RUST_LOG=info
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/hubris2

[Install]
WantedBy=multi-user.target
```

### 12.2 Docker

```dockerfile
FROM rust:1.83 AS builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=builder /app/target/release/hubris2 \
     /usr/local/bin/
EXPOSE 443
HEALTHCHECK --interval=30s --timeout=3s \
  CMD curl -f http://localhost:3000/healthz || exit 1
CMD ["hubris2"]
```

With `memory-serve`/`rust-embed`, assets are in the binary — no `COPY` of
`dist/` needed. Can use `FROM scratch` or distroless.

### 12.3 Health Checks

```rust
let app = Router::new()
    .route("/healthz", get(|| async {
        StatusCode::OK
    }))
    .route("/readyz", get(|State(s): State<AppState>| async move {
        if s.is_ready() { StatusCode::OK }
        else { StatusCode::SERVICE_UNAVAILABLE }
    }))
    .nest("/api", api_routes)
    .fallback_service(spa_service);
```

### 12.4 Graceful Shutdown

```rust
axum::serve(listener, app)
    .with_graceful_shutdown(shutdown_signal())
    .await?;
```

**WebSocket concern:** Long-lived WS connections block shutdown. Use a
`CancellationToken` shared with WS handlers. On shutdown signal, notify
connected clients via a control message, then force-close after timeout.

---

## Sources

### Terminal Streaming

- portable-pty docs: <https://docs.rs/portable-pty/latest/portable_pty/>
- Axum WebSocket module: <https://docs.rs/axum/latest/axum/extract/ws/>
- xterm.js Flow Control: <https://xtermjs.org/docs/guides/flowcontrol/>
- xterm.js GitHub: <https://github.com/xtermjs/xterm.js>
- Dan Luu terminal latency: <https://danluu.com/term-latency/>
- Docker binary WS frames: <https://github.com/moby/moby/pull/30460>
- tungstenite permessage-deflate issue: <https://github.com/snapview/tungstenite-rs/issues/2>
- xterm-zerolag-input: <https://www.npmjs.com/package/xterm-zerolag-input>
- sshx: <https://github.com/ekzhang/sshx>
- ttyd: <https://github.com/tsl0922/ttyd>

### ghostty-web

- ghostty-web GitHub: <https://github.com/coder/ghostty-web>
- ghostty-web npm: <https://www.npmjs.com/package/ghostty-web>

### SPA Serving

- tower-http ServeDir: <https://docs.rs/tower-http/latest/tower_http/services/struct.ServeDir.html>
- memory-serve: <https://lib.rs/crates/memory-serve>
- axum-reverse-proxy: <https://crates.io/crates/axum-reverse-proxy>
- axum-server RustlsConfig: <https://docs.rs/axum-server/latest/axum_server/tls_rustls/>
- rustls-acme: <https://lib.rs/crates/rustls-acme>
- tower-sessions: <https://github.com/maxcountryman/tower-sessions>

### Existing Tools

- Coder architecture: <https://coder.com/docs/v2/latest/about/architecture>
- code-server: <https://github.com/coder/code-server>
- Theia JSON-RPC: <https://theia-ide.org/docs/json_rpc/>
- JupyterHub configurable-http-proxy: <https://github.com/jupyterhub/configurable-http-proxy>
- Cockpit protocol: <https://github.com/cockpit-project/cockpit/blob/main/doc/protocol.md>
- Guacamole architecture: <https://guacamole.apache.org/doc/gug/guacamole-architecture.html>
- Teleport TLS routing: <https://goteleport.com/docs/reference/architecture/tls-routing/>
- OWASP WebSocket Security: <https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html>
