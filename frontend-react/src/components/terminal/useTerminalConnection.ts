import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { terminalWsUrl } from "@/lib/api";
import type {
  ClientControlMessage,
  ServerControlMessage,
} from "@/lib/contracts/ws.generated";
import type { TerminalAdapter, TerminalViewport } from "@/lib/terminal/adapter";
import {
  buildTerminalViewportMessage,
  shouldApplyTerminalViewport,
} from "@/lib/terminal/viewport";

const RECONNECT_DELAY_INITIAL = 100;
const RECONNECT_DELAY_MAX = 5000;
const RECONNECT_DELAY_MULTIPLIER = 2;

type UseTerminalConnectionArgs = {
  tabId: string;
  visible: boolean;
  terminalRef: RefObject<TerminalAdapter | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  onClosed?: (tabId: string) => void;
};

type UseTerminalConnectionResult = {
  connected: boolean;
  everConnected: boolean;
  handleTerminalData: (data: string) => void;
  sendResize: (force?: boolean) => boolean;
};

export function useTerminalConnection({
  tabId,
  visible,
  terminalRef,
  containerRef,
  onClosed,
}: UseTerminalConnectionArgs): UseTerminalConnectionResult {
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
  const localViewportRef = useRef<TerminalViewport | null>(null);
  const appliedViewportRef = useRef<TerminalViewport | null>(null);
  const lastSentViewportRef = useRef("");
  const flushInputAfterResizeRef = useRef(false);
  const connectFrameRef = useRef<number | null>(null);
  const encoderRef = useRef(new TextEncoder());

  const [everConnected, setEverConnected] = useState(false);
  const [connected, setConnected] = useState(false);

  useLayoutEffect(() => {
    visibleRef.current = visible;
    onClosedRef.current = onClosed;
  }, [onClosed, visible]);

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
  }, [terminalRef]);

  const applyPtySize = useCallback(
    (cols: number, rows: number): void => {
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
    },
    [terminalRef],
  );

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
  }, [applyPtySize, scheduleReconnect, sendResize, tabId, terminalRef]);

  useEffect(() => {
    connectWsRef.current = connectWs;
  }, [connectWs]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !terminalRef.current) {
      return;
    }

    intentionalCloseRef.current = false;
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
      resizeObserverRef.current = null;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [
    connectWs,
    containerRef,
    measureViewport,
    sendResize,
    tabId,
    terminalRef,
  ]);

  useEffect(() => {
    visibleRef.current = visible;

    if (!terminalRef.current) {
      return;
    }

    const isVisible = visible;
    const frameId = requestAnimationFrame(() => {
      sendResize(true);
      if (isVisible) {
        terminalRef.current?.focus();
      }
    });

    return () => cancelAnimationFrame(frameId);
  }, [sendResize, terminalRef, visible]);

  const handleTerminalData = useCallback((data: string): void => {
    const encoded = encoderRef.current.encode(data);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(encoded);
    } else {
      inputBufferRef.current.push(encoded);
    }
  }, []);

  return {
    connected,
    everConnected,
    handleTerminalData,
    sendResize,
  };
}
