# Research: Terminal Session Lifecycle

How the web frontend and Rust backend wire up terminal sessions,
from WebSocket connect through PTY I/O relay to disconnect/cleanup.

## High-Level Architecture

```
Browser (Svelte + xterm.js)         Server (Axum + Tokio + portable-pty)
─────────────────────────          ──────────────────────────────────────
TerminalTab.svelte                  api/terminal.rs
  ├─ createXtermAdapter()             ws_handler()
  ├─ new WebSocket(url)        ──→    ├─ validate project_id
  │   binaryType=arraybuffer          ├─ openpty(24×80)
  │                                   ├─ spawn $SHELL in project cwd
  ├─ onopen: send resize     ──→     ├─ split ws into sender/receiver
  │          focus terminal           ├─ mpsc channel(8) for PTY reads
  │                                   │
  ├─ onmessage: write to     ←──     ├─ Task 1: PTY reader (blocking)
  │   xterm (Uint8Array)              │    read 4KB → channel
  │                                   │
  ├─ onData: encode + send   ──→     ├─ Task 2: channel → ws sender
  │   (binary WS frame)               │    adaptive batching
  │                                   │
  ├─ ResizeObserver: fit()            └─ Task 3: ws receiver (main loop)
  │   + send resize JSON     ──→          binary → PTY writer
  │                                       JSON → resize PTY
  ├─ onclose: "[Connection             Close → break
  │   closed]" message
  │                                   Cleanup:
  └─ onDestroy: ws.close()   ──→       abort tasks
     terminal.dispose()                 kill child process
```

## Session Model: Fully Ephemeral

Sessions are **not persisted**. Each WebSocket connection spawns a fresh
PTY + shell; disconnection kills the shell and all state is lost.

- `PtySession` struct exists (`pty/session.rs:8-11`) but is **unused**
  — placeholder for future persistence.
- `AppState.sessions` (`state.rs:12`) is a `DashMap<SessionId,
  PtySession>` that's created but **never read or written**.
- `handle_terminal` receives `_state` (underscore-prefixed, unused)
  at `terminal.rs:68`.
- No session IDs, tokens, or reconnection protocol exist.

## Frontend: Component & Store Wiring

### Component Hierarchy

```
App.svelte
  └─ ProjectView.svelte          project prop, owns TabStore
       ├─ Tab bar UI             click + → tabStore.addTerminal()
       └─ {#each tabStore.tabs}
            <div class:hidden={not active}>   ← CSS hidden, NOT #if
              <TerminalTab {projectId} {visible} />
            </div>
```

**Key detail:** `ProjectView.svelte:69-70` uses `class:hidden` not
`{#if}`, so **all TerminalTab instances stay mounted** (and their
WebSocket connections stay alive) even when the tab is inactive. Only
the `visible` prop changes.

### TabStore (`stores/tabs.svelte.ts`)

Tracks tab metadata only: `{ id: UUID, label, type: 'terminal' }`.
No terminal or WebSocket state.

- `addTerminal()` — creates tab, sets it active.
- `close(id)` — removes tab from array; falls back to last tab.
- `activate(id)` — changes `activeTabId`.
- `reset()` — clears all tabs. Called from `ProjectView.svelte:12-15`
  via `$effect` whenever the `project` prop changes.

### Project Switch → Tab Reset

```svelte
// ProjectView.svelte:12-15
$effect(() => {
  project; // track
  tabStore.reset();
});
```

When the user selects a different project, all tabs are cleared. This
unmounts all `TerminalTab` components, triggering `onDestroy` which
closes WebSockets and disposes xterm instances.

## Frontend: TerminalTab Lifecycle (`TerminalTab.svelte`)

Props: `projectId: string`, `visible: boolean`.

### Mount (`onMount`, line 16)

1. **Create xterm adapter:** `createXtermAdapter()` — instantiates
   `Terminal` with Catppuccin theme, 14px JetBrains Mono, 10k
   scrollback, cursor blink.
2. **Open xterm in DOM:** `terminal.open(containerEl)` — loads
   FitAddon, WebLinksAddon, and WebglAddon (with canvas fallback).
3. **Open WebSocket:** `new WebSocket(terminalWsUrl(projectId))` with
   `binaryType = 'arraybuffer'`.
4. **Wire event handlers:**
   - `onopen` → send initial resize JSON, focus terminal.
   - `onmessage` → `terminal.write(new Uint8Array(ev.data))`.
   - `onclose` → `terminal.write('\r\n[Connection closed]\r\n')`.
   - `terminal.onData` → encode to UTF-8, send as binary WS frame.
5. **Set up ResizeObserver** on container element.

### Resize Flow (lines 48-66)

```
Browser resize / container change
  → ResizeObserver fires
  → if visible:
      terminal.fit()        (xterm recalculates grid cols/rows)
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))
```

Additionally, when `visible` flips to `true` (tab switch), a
`$effect` (line 70-74) calls `requestAnimationFrame(() =>
terminal.fit())` to recalculate after the container becomes visible.

**Subtle point:** `ResizeObserver` captures `visible` from component
scope at creation time. Since `visible` is a `$props()` value (not a
rune), it's reactive via Svelte 5's proxy — the observer closure
always sees the current value.

### Unmount (`onDestroy`, line 76)

```typescript
ws?.close();         // triggers backend cleanup
terminal?.dispose(); // releases xterm DOM + resources
```

The `onMount` return callback also disconnects the ResizeObserver.

### WebSocket URL Construction (`api.ts:53-57`)

```typescript
export function terminalWsUrl(projectId: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/terminal/ws?project_id=${projectId}`;
}
```

In dev, `location.host` is `localhost:5173` (Vite dev server). The
Vite proxy (`vite.config.ts:16-19`) forwards `/api` to
`http://localhost:3001` with `ws: true` for WebSocket upgrades.

## Backend: WebSocket Handler (`api/terminal.rs`)

### Route

```
GET /api/terminal/ws?project_id={id}  →  ws_handler
```

Registered at `lib.rs:26`.

### ws_handler (line 47-63)

1. Load projects from JSON file (`data_dir/projects.json`).
2. Find project by `project_id` or return 404.
3. Extract `project.path` as the shell working directory.
4. Call `ws.on_upgrade(|socket| handle_terminal(socket, cwd, _state))`.

### handle_terminal (line 65-213)

#### PTY Setup (lines 70-104)

```rust
let pty_system = NativePtySystem::default();
let pair = pty_system.openpty(PtySize {
    rows: 24, cols: 80, ...
});
let shell = env::var("SHELL").unwrap_or("/bin/sh");
let mut cmd = CommandBuilder::new(&shell);
cmd.cwd(&cwd);
cmd.env("TERM", "xterm-256color");
let mut child = pair.slave.spawn_command(cmd);
drop(pair.slave);
let master = pair.master;
let mut reader = master.try_clone_reader().unwrap();
let mut writer = master.take_writer().unwrap();
```

- Default PTY size 24×80. Client sends actual size immediately after
  connect (the `onopen` resize message).
- Shell inherits the server's environment plus `TERM=xterm-256color`.
- Slave dropped after spawn; only master used for I/O.

#### Channel Setup (lines 106-107)

```rust
let (ws_sender, mut ws_receiver) = socket.split();
let (tx, mut rx) = mpsc::channel::<Vec<u8>>(8);
```

WebSocket split into half-duplex. mpsc channel (buffer 8) bridges the
blocking PTY reader to the async WebSocket sender.

#### Task 1: PTY Reader (lines 110-124, spawn_blocking)

```rust
tokio::task::spawn_blocking(move || {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,  // EOF (shell exited)
            Ok(n) => { tx.blocking_send(buf[..n].to_vec()); }
            Err(_) => break,
        }
    }
});
```

- Runs on Tokio's blocking thread pool (not the async runtime).
- 4KB read buffer per iteration.
- Exits on EOF (shell exit) or read error. Channel close propagates
  to Task 2.

#### Task 2: Channel → WS Sender (lines 127-175, tokio::spawn)

Adaptive batching strategy:

- **Small data (<128 bytes):** Send immediately. Optimizes for
  interactive latency (single keystrokes, short prompts).
- **Large data (≥128 bytes):** Start a 4ms batch timer, accumulate
  all available channel data within that window, then send as one
  WebSocket frame. Optimizes throughput for bulk output (e.g., `cat`
  of a large file, `ls -la`).

```rust
if data.len() < 128 {
    ws_sender.send(Message::Binary(data.into())).await;
} else {
    let mut batch = data;
    let deadline = sleep(Duration::from_millis(4));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            more = rx.recv() => match more {
                Some(d) => batch.extend(d),
                None => break,
            }
        }
    }
    ws_sender.send(Message::Binary(batch.into())).await;
}
```

#### Task 3: WS Receiver / Main Loop (lines 178-206)

```rust
while let Some(Ok(msg)) = ws_receiver.next().await {
    match msg {
        Message::Binary(data) => writer.write_all(&data),
        Message::Text(text) => parse ControlMessage → resize,
        Message::Close(_) => break,
        _ => {}
    }
}
```

- Binary frames: user input → PTY writer (synchronous write).
- Text frames: JSON control messages. Currently only `resize`:
  ```json
  { "type": "resize", "cols": 120, "rows": 40 }
  ```
  Calls `master.resize(PtySize { rows, cols, ... })` which sends
  `SIGWINCH` to the shell.
- Close frame: exits loop, triggers cleanup.
- Unrecognized text messages silently ignored.

#### Cleanup (lines 208-212)

```rust
sender_handle.abort();   // stop Task 2 (ws sender)
reader_handle.abort();   // stop Task 1 (pty reader)
let _ = child.kill();    // SIGKILL the shell process
let _ = child.wait();    // reap zombie
```

Runs when the main receive loop exits (client disconnect, close
frame, or write error). Resources (master, reader, writer, channel)
are dropped automatically by Rust's ownership.

## Message Protocol Summary

| Direction          | Format    | Content                         |
| ------------------ | --------- | ------------------------------- |
| Client → Server    | Binary    | User keystrokes (UTF-8 encoded) |
| Client → Server    | JSON text | `{ type: "resize", cols, rows }`|
| Server → Client    | Binary    | Raw PTY output (ANSI + data)    |

No JSON flows server → client. No acknowledgments, heartbeats, or
session negotiation.

## Error Handling

| Failure                  | Behavior                                         |
| -------------------------| ------------------------------------------------ |
| Invalid project_id       | HTTP 404 before WS upgrade (`terminal.rs:58`)    |
| PTY open failure         | Log error, return (silent WS close) (line 79-82) |
| Shell spawn failure      | Log error, return (silent WS close) (line 93-96) |
| PTY read error/EOF       | Reader task exits → channel closes → sender exits |
| PTY write error          | Main loop breaks → cleanup                       |
| WS send error            | Sender task breaks → cleanup runs when main exits |
| WS receive error         | `Some(Err(_))` skipped; `None` exits loop         |
| Resize parse failure     | Silently ignored (line 187-188 `if let Ok`)      |
| Resize apply failure     | Silently ignored (`let _`, line 192)              |
| WebGL unavailable        | Falls back to canvas renderer (xterm.ts:38-40)   |

**Notable:** The backend never sends error messages to the client.
All failures result in either silent WebSocket closure or silent
ignore.

## What Doesn't Exist (Yet)

- **Session persistence:** `PtySession` struct and `DashMap` are
  scaffolded but unused. No session ID generation, storage, or lookup.
- **Reconnection:** No protocol for resuming a session. WS close =
  shell death.
- **Heartbeat/keepalive:** No ping/pong frames. Idle connections rely
  on OS-level TCP keepalive.
- **Authentication/authorization:** Any client with a valid
  `project_id` can open a terminal.
- **Client error feedback:** Backend logs errors but never sends error
  messages over the WebSocket.
- **Shell exit detection:** If the shell exits (EOF on PTY reader),
  the reader task stops, the sender eventually drains, but the client
  only sees `[Connection closed]` — no distinction from network
  disconnect.
- **Terminal tests:** No integration or unit tests for the terminal
  WebSocket flow on either side.

## Key File Reference

### Backend
- `crates/server/src/api/terminal.rs` — WS handler, PTY I/O relay
- `crates/server/src/pty/session.rs` — PtySession struct (unused)
- `crates/server/src/state.rs` — AppState with sessions DashMap
- `crates/server/src/lib.rs` — Router setup, route registration
- `crates/server/src/main.rs` — Server entry, port 3001

### Frontend
- `frontend/src/lib/components/TerminalTab.svelte` — Terminal
  component, WS lifecycle, resize handling
- `frontend/src/lib/components/ProjectView.svelte` — Tab management,
  mounts TerminalTab instances
- `frontend/src/lib/terminal/adapter.ts` — TerminalAdapter interface
- `frontend/src/lib/terminal/xterm.ts` — xterm.js implementation
- `frontend/src/lib/stores/tabs.svelte.ts` — Tab metadata store
- `frontend/src/lib/api.ts` — WS URL builder, REST API client
- `frontend/src/lib/types.ts` — Project, Tab type definitions
- `frontend/vite.config.ts` — Dev proxy `/api` → `:3001` with ws
