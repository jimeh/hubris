<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { createXtermAdapter } from '$lib/terminal/xterm';
  import { terminalWsUrl } from '$lib/api';
  import { getThemeStore } from '$lib/stores/theme.svelte';
  import { getTerminalStore } from '$lib/stores/terminal.svelte';
  import type { TerminalAdapter } from '$lib/terminal/adapter';

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

  const RECONNECT_DELAY_INITIAL = 100;
  const RECONNECT_DELAY_MAX = 5000;
  const RECONNECT_DELAY_MULTIPLIER = 2;

  const encoder = new TextEncoder();

  function connectWs() {
    if (intentionalClose) return;

    let url = terminalWsUrl(tabId);
    if (bytePosition > 0) {
      url += `&resume_from=${bytePosition}`;
    }

    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      connected = true;
      everConnected = true;
      reconnectDelay = RECONNECT_DELAY_INITIAL;

      // Send current terminal dimensions
      ws!.send(
        JSON.stringify({
          type: 'resize',
          cols: terminal!.cols,
          rows: terminal!.rows,
        }),
      );

      // Flush buffered input
      for (const chunk of inputBuffer) {
        ws!.send(chunk);
      }
      inputBuffer = [];

      terminal!.focus();
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'tab_closed') {
            intentionalClose = true;
            onclosed?.();
            return;
          }
          if (msg.type === 'attached') {
            bytePosition = msg.byte_offset;
            if (msg.data_lost) {
              terminal!.clear();
            }
            return;
          }
        } catch {
          // not JSON, ignore
        }
      }

      // Binary PTY data
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

  function sendResize() {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'resize',
          cols: terminal!.cols,
          rows: terminal!.rows,
        }),
      );
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
      if (visible) {
        terminal!.fit();
        sendResize();
      }
    });
    resizeObserver.observe(containerEl);

    return () => {
      resizeObserver.disconnect();
    };
  });

  // Fit when tab becomes visible
  $effect(() => {
    if (visible && terminal) {
      requestAnimationFrame(() => {
        terminal!.fit();
        terminal!.focus();
      });
    }
  });

  // Refresh terminal theme when theme changes
  $effect(() => {
    void theme.version;
    if (terminal) terminal.refreshTheme();
  });

  // Update terminal font when settings change
  $effect(() => {
    void termStore.version;
    if (terminal) {
      terminal.updateFont(
        termStore.fontFamily,
        termStore.fontSize,
      );
      // Notify PTY of new dimensions — font change
      // alters cols/rows via fitAddon.fit()
      sendResize();
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
  }

  .terminal-container {
    width: 100%;
    height: 100%;
  }

  .reconnect-indicator {
    position: absolute;
    bottom: 8px;
    right: 8px;
    padding: 4px 10px;
    border-radius: 6px;
    background: oklch(0.25 0 0 / 0.8);
    color: oklch(0.75 0 0);
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
