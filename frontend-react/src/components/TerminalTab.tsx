import React, { useEffect, useRef, useState, useCallback } from "react";
import { createXtermAdapter } from "@/lib/terminal/xterm";
import { terminalWsUrl } from "@/lib/api";
import type { ServerControlMessage } from "@/lib/contracts/ws.generated";
import { useThemeStore } from "@/lib/stores/theme";
import { useTerminalStore } from "@/lib/stores/terminal";
import type { TerminalAdapter, TerminalViewport } from "@/lib/terminal/adapter";
import {
  buildTerminalViewportMessage,
  shouldApplyTerminalViewport,
} from "@/lib/terminal/viewport";

const RECONNECT_DELAY_INITIAL = 100;
const RECONNECT_DELAY_MAX = 5000;
const RECONNECT_DELAY_MULTIPLIER = 2;

interface TerminalTabProps {
  tabId: string;
  visible: boolean;
  onClosed?: () => void;
}

export const TerminalTab = React.memo(function TerminalTab({
  tabId,
  visible,
  onClosed,
}: TerminalTabProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<TerminalAdapter | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const bytePositionRef = useRef(0);
  const inputBufferRef = useRef<Uint8Array[]>([]);
  const intentionalCloseRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(RECONNECT_DELAY_INITIAL);
  const encoderRef = useRef(new TextEncoder());

  const localViewportRef = useRef<TerminalViewport | null>(null);
  const appliedViewportRef = useRef<TerminalViewport | null>(null);
  const lastSentViewportRef = useRef("");
  const flushInputAfterResizeRef = useRef(false);
  const visibleRef = useRef(visible);

  const [everConnected, setEverConnected] = useState(false);
  const [connected, setConnected] = useState(false);

  const themeVersion = useThemeStore((s) => s.version);
  const termFontFamily = useTerminalStore((s) => s.fontFamily);
  const termFontSize = useTerminalStore((s) => s.fontSize);
  const termVersion = useTerminalStore((s) => s.version);

  // Keep visibleRef in sync with the visible prop.
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  const measureViewport = useCallback((): TerminalViewport | null => {
    const terminal = terminalRef.current;
    if (!terminal) return null;

    const viewport = terminal.measureViewport();
    if (viewport) {
      localViewportRef.current = viewport;
    }

    return viewport;
  }, []);

  const applyPtySize = useCallback((cols: number, rows: number) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const nextViewport = { cols, rows };
    if (
      !shouldApplyTerminalViewport(appliedViewportRef.current, nextViewport)
    ) {
      return;
    }

    terminal.resize(cols, rows);
    appliedViewportRef.current = nextViewport;
  }, []);

  const flushBufferedInput = useCallback(() => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }

    for (const chunk of inputBufferRef.current) {
      wsRef.current.send(chunk);
    }
    inputBufferRef.current = [];
    flushInputAfterResizeRef.current = false;
  }, []);

  const sendResize = useCallback(
    (force = false): boolean => {
      const { localViewport: nextLocalViewport, message } =
        buildTerminalViewportMessage({
          visible: visibleRef.current,
          measuredViewport: measureViewport(),
          localViewport: localViewportRef.current,
          appliedViewport: appliedViewportRef.current,
        });

      localViewportRef.current = nextLocalViewport;

      if (!message) return false;

      const serialized = JSON.stringify(message);
      if (!force && serialized === lastSentViewportRef.current) {
        return false;
      }

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(serialized);
        lastSentViewportRef.current = serialized;
        if (
          flushInputAfterResizeRef.current &&
          inputBufferRef.current.length > 0
        ) {
          flushBufferedInput();
        }
        return true;
      }

      return false;
    },
    [measureViewport, flushBufferedInput],
  );

  const sendInput = useCallback((data: string) => {
    const encoded = encoderRef.current.encode(data);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(encoded);
    } else {
      inputBufferRef.current.push(encoded);
    }
  }, []);

  const connectWsRef = useRef<() => void>(() => {});

  const scheduleReconnect = useCallback(() => {
    if (intentionalCloseRef.current) return;
    if (reconnectTimerRef.current != null) return;

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      reconnectDelayRef.current = Math.min(
        reconnectDelayRef.current * RECONNECT_DELAY_MULTIPLIER,
        RECONNECT_DELAY_MAX,
      );
      connectWsRef.current();
    }, reconnectDelayRef.current);
  }, []);

  // Connect WebSocket
  const connectWs = useCallback(() => {
    if (intentionalCloseRef.current) return;

    let url = terminalWsUrl(tabId);
    if (bytePositionRef.current > 0) {
      url += `&resume_from=${bytePositionRef.current}`;
    }

    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setEverConnected(true);
      reconnectDelayRef.current = RECONNECT_DELAY_INITIAL;
      lastSentViewportRef.current = "";
      flushInputAfterResizeRef.current = inputBufferRef.current.length > 0;

      if (!sendResize(true)) {
        requestAnimationFrame(() => {
          sendResize(true);
          if (visibleRef.current) {
            terminalRef.current?.focus();
          }
        });
      } else if (visibleRef.current) {
        terminalRef.current?.focus();
      }
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data) as ServerControlMessage;
          switch (msg.type) {
            case "tab_closed": {
              intentionalCloseRef.current = true;
              onClosed?.();
              return;
            }
            case "attached": {
              applyPtySize(msg.cols, msg.rows);
              bytePositionRef.current = msg.byte_offset;
              if (msg.data_lost) {
                terminalRef.current?.clear();
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
      terminalRef.current?.write(data);
      bytePositionRef.current += data.byteLength;
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      if (!intentionalCloseRef.current) {
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose fires after onerror — reconnect handled there
    };
  }, [tabId, onClosed, sendResize, applyPtySize, scheduleReconnect]);
  connectWsRef.current = connectWs;

  // Initialize terminal + WebSocket
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = createXtermAdapter({
      fontSize: useTerminalStore.getState().fontSize,
      fontFamily: useTerminalStore.getState().fontFamily,
    });
    terminalRef.current = terminal;
    terminal.open(container);
    terminal.onData(sendInput);

    connectWs();

    const resizeObserver = new ResizeObserver(() => {
      measureViewport();
      sendResize();
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current != null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close();
      terminal.dispose();
      terminalRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // Handle visibility changes
  useEffect(() => {
    if (!terminalRef.current) return;

    requestAnimationFrame(() => {
      measureViewport();
      sendResize(true);
      if (visible) {
        terminalRef.current?.focus();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Refresh terminal theme when theme changes
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.refreshTheme();
    }
  }, [themeVersion]);

  // Update terminal font when settings change
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.updateFont(termFontFamily, termFontSize);
      measureViewport();
      sendResize(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termVersion]);

  return (
    <div className="terminal-wrapper">
      <div className="terminal-container" ref={containerRef} />
      {!connected && everConnected && (
        <div className="reconnect-indicator">Reconnecting…</div>
      )}
    </div>
  );
});
