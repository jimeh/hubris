import { useCallback, useEffect, useRef, useState } from "react";
import { createXtermAdapter } from "$lib/terminal/xterm";
import { terminalWsUrl } from "$lib/api";
import type {
  ClientControlMessage,
  ServerControlMessage,
} from "$lib/contracts/ws.generated";
import { useThemeStore } from "$lib/stores/theme";
import { useTerminalStore } from "$lib/stores/terminal";
import type { TerminalAdapter, TerminalViewport } from "$lib/terminal/adapter";
import {
  buildTerminalViewportMessage,
  shouldApplyTerminalViewport,
} from "$lib/terminal/viewport";

type Props = {
  tabId: string;
  visible: boolean;
  onClosed?: (tabId: string) => void;
};

const RECONNECT_DELAY_INITIAL = 100;
const RECONNECT_DELAY_MAX = 5000;
const RECONNECT_DELAY_MULTIPLIER = 2;

export default function TerminalTab({ tabId, visible, onClosed }: Props) {
  const themeVersion = useThemeStore((state) => state.version);
  const terminalVersion = useTerminalStore((state) => state.version);
  const fontFamily = useTerminalStore((state) => state.fontFamily);
  const fontSize = useTerminalStore((state) => state.settings.fontSize);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<TerminalAdapter | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const bytePositionRef = useRef(0);
  const inputBufferRef = useRef<Uint8Array[]>([]);
  const intentionalCloseRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(RECONNECT_DELAY_INITIAL);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const connectWsRef = useRef<() => void>(() => {});
  const visibleRef = useRef(visible);
  const onClosedRef = useRef(onClosed);
  const fontFamilyRef = useRef(fontFamily);
  const fontSizeRef = useRef(fontSize);
  const localViewportRef = useRef<TerminalViewport | null>(null);
  const appliedViewportRef = useRef<TerminalViewport | null>(null);
  const lastSentViewportRef = useRef("");
  const flushInputAfterResizeRef = useRef(false);
  const connectFrameRef = useRef<number | null>(null);

  const [everConnected, setEverConnected] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    onClosedRef.current = onClosed;
  }, [onClosed]);

  useEffect(() => {
    fontFamilyRef.current = fontFamily;
    fontSizeRef.current = fontSize;
  }, [fontFamily, fontSize]);

  const measureViewport = useCallback((): TerminalViewport | null => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return null;
    }

    const viewport = terminal.measureViewport();
    if (viewport) {
      localViewportRef.current = viewport;
    }

    return viewport;
  }, []);

  const applyPtySize = useCallback((cols: number, rows: number): void => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const nextViewport = { cols, rows };
    if (
      !shouldApplyTerminalViewport(appliedViewportRef.current, nextViewport)
    ) {
      return;
    }

    terminal.resize(cols, rows);
    appliedViewportRef.current = nextViewport;
  }, []);

  const buildViewportMessage = useCallback((): ClientControlMessage | null => {
    const { localViewport, message } = buildTerminalViewportMessage({
      visible: visibleRef.current,
      measuredViewport: measureViewport(),
      localViewport: localViewportRef.current,
      appliedViewport: appliedViewportRef.current,
    });

    localViewportRef.current = localViewport;
    return message;
  }, [measureViewport]);

  const flushBufferedInput = useCallback((): void => {
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
      const message = buildViewportMessage();
      if (!message) {
        return false;
      }

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
    [buildViewportMessage, flushBufferedInput],
  );

  const scheduleReconnect = useCallback((): void => {
    if (intentionalCloseRef.current || reconnectTimerRef.current) {
      return;
    }

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      reconnectDelayRef.current = Math.min(
        reconnectDelayRef.current * RECONNECT_DELAY_MULTIPLIER,
        RECONNECT_DELAY_MAX,
      );
      connectWsRef.current();
    }, reconnectDelayRef.current);
  }, []);

  const connectWs = useCallback((): void => {
    if (intentionalCloseRef.current) {
      return;
    }

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
        connectFrameRef.current = requestAnimationFrame(() => {
          connectFrameRef.current = null;
          sendResize(true);
          if (visibleRef.current) {
            terminalRef.current?.focus();
          }
        });
      } else if (visibleRef.current) {
        terminalRef.current?.focus();
      }
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data) as ServerControlMessage;
          switch (message.type) {
            case "tab_closed":
              intentionalCloseRef.current = true;
              onClosedRef.current?.(tabId);
              return;
            case "attached":
              applyPtySize(message.cols, message.rows);
              bytePositionRef.current = message.byte_offset;
              if (message.data_lost) {
                terminalRef.current?.clear();
              }
              return;
            case "pty_resized":
              applyPtySize(message.cols, message.rows);
              return;
          }
        } catch {
          // Ignore non-control messages.
        }
      }

      const data = new Uint8Array(event.data);
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
  }, [applyPtySize, scheduleReconnect, sendResize, tabId]);

  useEffect(() => {
    connectWsRef.current = connectWs;
  }, [connectWs]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    intentionalCloseRef.current = false;
    const terminal = createXtermAdapter({
      fontFamily: fontFamilyRef.current,
      fontSize: fontSizeRef.current,
    });
    terminalRef.current = terminal;
    terminal.open(container);

    const encoder = new TextEncoder();
    const onDataSubscription = terminal.onData((data) => {
      const encoded = encoder.encode(data);
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(encoded);
      } else {
        inputBufferRef.current.push(encoded);
      }
    });

    connectWs();

    const observer = new ResizeObserver(() => {
      void measureViewport();
      sendResize();
    });
    observer.observe(container);
    resizeObserverRef.current = observer;

    return () => {
      intentionalCloseRef.current = true;
      if (connectFrameRef.current !== null) {
        cancelAnimationFrame(connectFrameRef.current);
        connectFrameRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      resizeObserverRef.current?.disconnect();
      wsRef.current?.close();
      onDataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [connectWs, measureViewport, sendResize, tabId]);

  useEffect(() => {
    if (!terminalRef.current) {
      return;
    }

    const isVisible = visible;
    const frameId = requestAnimationFrame(() => {
      void measureViewport();
      sendResize(true);
      if (isVisible) {
        terminalRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(frameId);
  }, [measureViewport, sendResize, visible]);

  useEffect(() => {
    if (!terminalRef.current) {
      return;
    }

    terminalRef.current.refreshTheme();
  }, [themeVersion]);

  useEffect(() => {
    if (!terminalRef.current) {
      return;
    }

    terminalRef.current.updateFont(fontFamily, fontSize);
    void measureViewport();
    sendResize(true);
  }, [fontFamily, fontSize, measureViewport, sendResize, terminalVersion]);

  return (
    <div className="terminal-wrapper">
      <div className="terminal-container" ref={containerRef} />
      {!connected && everConnected ? (
        <div className="reconnect-indicator">Reconnecting…</div>
      ) : null}
    </div>
  );
}
