<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { createXtermAdapter } from "$lib/terminal/xterm";
  import { terminalWsUrl } from "$lib/api";
  import type {
    ClientControlMessage,
    ServerControlMessage,
  } from "$lib/contracts/ws.generated";
  import { getThemeStore } from "$lib/stores/theme.svelte";
  import { getTerminalStore } from "$lib/stores/terminal.svelte";
  import type {
    TerminalAdapter,
    TerminalViewport,
  } from "$lib/terminal/adapter";
  import {
    buildTerminalViewportMessage,
    shouldApplyTerminalViewport,
  } from "$lib/terminal/viewport";

  let {
    tabId,
    visible,
    onclosed,
  }: {
    tabId: string;
    visible: boolean;
    onclosed?: () => void;
  } = $props();

  const theme = getThemeStore();
  const termStore = getTerminalStore();

  let containerEl: HTMLDivElement;
  let terminal: TerminalAdapter | null = null;
  let ws: WebSocket | null = null;

  // Reconnection state
  let bytePosition = 0;
  let inputBuffer: Uint8Array[] = [];
  let intentionalClose = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 100;
  let everConnected = $state(false);
  let connected = $state(false);
  let localViewport: TerminalViewport | null = null;
  let appliedViewport: TerminalViewport | null = null;
  let lastSentViewport = "";
  let flushInputAfterResize = false;

  const RECONNECT_DELAY_INITIAL = 100;
  const RECONNECT_DELAY_MAX = 5000;
  const RECONNECT_DELAY_MULTIPLIER = 2;

  const encoder = new TextEncoder();

  function measureViewport(): TerminalViewport | null {
    if (!terminal) return null;

    const viewport = terminal.measureViewport();
    if (viewport) {
      localViewport = viewport;
    }

    return viewport;
  }

  function applyPtySize(cols: number, rows: number) {
    if (!terminal) return;
    const nextViewport = { cols, rows };
    if (!shouldApplyTerminalViewport(appliedViewport, nextViewport)) {
      return;
    }

    terminal.resize(cols, rows);
    appliedViewport = nextViewport;
  }

  function buildViewportMessage(): ClientControlMessage | null {
    const { localViewport: nextLocalViewport, message } =
      buildTerminalViewportMessage({
        visible,
        measuredViewport: measureViewport(),
        localViewport,
        appliedViewport,
      });

    localViewport = nextLocalViewport;
    return message;
  }

  function flushBufferedInput() {
    if (ws?.readyState !== WebSocket.OPEN) {
      return;
    }

    for (const chunk of inputBuffer) {
      ws.send(chunk);
    }
    inputBuffer = [];
    flushInputAfterResize = false;
  }

  function sendResize(force = false): boolean {
    const message = buildViewportMessage();
    if (!message) return false;

    const serialized = JSON.stringify(message);
    if (!force && serialized === lastSentViewport) {
      return false;
    }

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(serialized);
      lastSentViewport = serialized;
      if (flushInputAfterResize && inputBuffer.length > 0) {
        flushBufferedInput();
      }
      return true;
    }

    return false;
  }

  function connectWs() {
    if (intentionalClose) return;

    let url = terminalWsUrl(tabId);
    if (bytePosition > 0) {
      url += `&resume_from=${bytePosition}`;
    }

    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      connected = true;
      everConnected = true;
      reconnectDelay = RECONNECT_DELAY_INITIAL;
      lastSentViewport = "";
      flushInputAfterResize = inputBuffer.length > 0;

      if (!sendResize(true)) {
        requestAnimationFrame(() => {
          sendResize(true);
          if (visible) {
            terminal?.focus();
          }
        });
      } else if (visible) {
        terminal?.focus();
      }
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data) as ServerControlMessage;
          switch (msg.type) {
            case "tab_closed": {
              intentionalClose = true;
              onclosed?.();
              return;
            }
            case "attached": {
              applyPtySize(msg.cols, msg.rows);
              bytePosition = msg.byte_offset;
              if (msg.data_lost) {
                terminal!.clear();
              }
              return;
            }
            case "pty_resized": {
              applyPtySize(msg.cols, msg.rows);
              return;
            }
          }
        } catch {
          // not JSON, ignore
        }
      }

      const data = new Uint8Array(ev.data);
      terminal!.write(data);
      bytePosition += data.byteLength;
    };

    ws.onclose = () => {
      connected = false;
      ws = null;
      if (!intentionalClose) {
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose fires after onerror — reconnect handled there
    };
  }

  function scheduleReconnect() {
    if (intentionalClose) return;
    if (reconnectTimer != null) return;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(
        reconnectDelay * RECONNECT_DELAY_MULTIPLIER,
        RECONNECT_DELAY_MAX,
      );
      connectWs();
    }, reconnectDelay);
  }

  function sendInput(data: string) {
    const encoded = encoder.encode(data);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(encoded);
    } else {
      inputBuffer.push(encoded);
    }
  }

  onMount(() => {
    terminal = createXtermAdapter({
      fontSize: termStore.fontSize,
      fontFamily: termStore.fontFamily,
    });
    terminal.open(containerEl);
    terminal.onData(sendInput);

    connectWs();

    const resizeObserver = new ResizeObserver(() => {
      void measureViewport();
      sendResize();
    });
    resizeObserver.observe(containerEl);

    return () => {
      resizeObserver.disconnect();
    };
  });

  $effect(() => {
    const isVisible = visible;
    if (!terminal) return;

    requestAnimationFrame(() => {
      void measureViewport();
      sendResize(true);
      if (isVisible) {
        terminal!.focus();
      }
    });
  });

  $effect(() => {
    void theme.version;
    if (terminal) terminal.refreshTheme();
  });

  $effect(() => {
    void termStore.version;
    if (terminal) {
      terminal.updateFont(termStore.fontFamily, termStore.fontSize);
      void measureViewport();
      sendResize(true);
    }
  });

  onDestroy(() => {
    intentionalClose = true;
    if (reconnectTimer != null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.close();
    terminal?.dispose();
  });
</script>

<div class="terminal-wrapper">
  <div class="terminal-container" bind:this={containerEl}></div>
  {#if !connected && everConnected}
    <div class="reconnect-indicator">Reconnecting…</div>
  {/if}
</div>

<style>
  .terminal-wrapper {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--terminal-background);
  }

  .terminal-container {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--terminal-background);
  }

  .reconnect-indicator {
    position: absolute;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    padding: 4px 12px;
    border-radius: 6px;
    background: oklch(0.25 0.05 25 / 0.85);
    color: oklch(0.7 0.12 25);
    font-size: 12px;
    font-family: sans-serif;
    pointer-events: none;
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
</style>
