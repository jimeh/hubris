<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { createXtermAdapter } from '$lib/terminal/xterm';
  import { terminalWsUrl } from '$lib/api';
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

  let containerEl: HTMLDivElement;
  let terminal: TerminalAdapter | null = null;
  let ws: WebSocket | null = null;

  onMount(() => {
    terminal = createXtermAdapter();
    terminal.open(containerEl);

    ws = new WebSocket(terminalWsUrl(tabId));
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      ws!.send(
        JSON.stringify({
          type: 'resize',
          cols: terminal!.cols,
          rows: terminal!.rows,
        }),
      );
      terminal!.focus();
    };

    ws.onmessage = (ev) => {
      // Check for tab_closed control frame (text/JSON)
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'tab_closed') {
            onclosed?.();
            return;
          }
        } catch {
          // not JSON, ignore
        }
      }
      terminal!.write(new Uint8Array(ev.data));
    };

    ws.onclose = () => {
      // PTY is still alive — no "[Connection closed]"
      // message. Reconnection happens on component remount.
    };

    terminal.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      if (visible) {
        terminal!.fit();
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
    });
    resizeObserver.observe(containerEl);

    return () => {
      resizeObserver.disconnect();
    };
  });

  // Fit when tab becomes visible
  $effect(() => {
    if (visible && terminal) {
      requestAnimationFrame(() => terminal!.fit());
    }
  });

  onDestroy(() => {
    ws?.close();
    terminal?.dispose();
  });
</script>

<div class="terminal-container" bind:this={containerEl}></div>

<style>
  .terminal-container {
    width: 100%;
    height: 100%;
  }
</style>
