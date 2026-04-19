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
  handleTerminalBinary: (data: string) => void;
  handleTerminalData: (data: string) => void;
  sendResize: (force?: boolean) => boolean;
};

type ScheduledReconnect = {
  generation: number;
  timeoutId: ReturnType<typeof setTimeout>;
} | null;

type ConnectFrame = {
  generation: number;
  frameId: number;
} | null;

function encodeBinaryInput(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    bytes[index] = data.charCodeAt(index) & 0xff;
  }

  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function useTerminalConnection({
  tabId,
  visible,
  terminalRef,
  containerRef,
  onClosed,
}: UseTerminalConnectionArgs): UseTerminalConnectionResult {
  const wsRef = useRef<WebSocket | null>(null);
  const connectionGenerationRef = useRef(0);
  const bytePositionRef = useRef(0);
  const inputBufferRef = useRef<Uint8Array[]>([]);
  const localCleanupRef = useRef(false);
  const serverClosedRef = useRef(false);
  const reconnectTimerRef = useRef<ScheduledReconnect>(null);
  const reconnectDelayRef = useRef(RECONNECT_DELAY_INITIAL);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const connectWsRef = useRef<() => void>(() => {});
  const visibleRef = useRef(visible);
  const onClosedRef = useRef(onClosed);
  const localViewportRef = useRef<TerminalViewport | null>(null);
  const appliedViewportRef = useRef<TerminalViewport | null>(null);
  const lastSentViewportRef = useRef("");
  const flushInputAfterResizeRef = useRef(false);
  const connectFrameRef = useRef<ConnectFrame>(null);
  const encoderRef = useRef(new TextEncoder());
  const startConnectionFrameRef = useRef<number | null>(null);

  const [connectionStarted, setConnectionStarted] = useState(visible);
  const [everConnected, setEverConnected] = useState(false);
  const [connected, setConnected] = useState(false);

  useLayoutEffect(() => {
    visibleRef.current = visible;
    onClosedRef.current = onClosed;
  }, [onClosed, visible]);

  const isCurrentConnection = useCallback(
    (ws: WebSocket, generation: number): boolean =>
      wsRef.current === ws && connectionGenerationRef.current === generation,
    [],
  );

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
      wsRef.current.send(toArrayBuffer(chunk));
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

  const scheduleResizeRetry = useCallback(
    (generation: number): void => {
      const runRetry = (): void => {
        if (connectFrameRef.current !== null) {
          cancelAnimationFrame(connectFrameRef.current.frameId);
        }

        const frameId = requestAnimationFrame(() => {
          if (connectFrameRef.current?.generation !== generation) {
            return;
          }

          connectFrameRef.current = null;
          if (!sendResize(true)) {
            runRetry();
            return;
          }

          if (visibleRef.current) {
            terminalRef.current?.focus();
          }
        });
        connectFrameRef.current = { generation, frameId };
      };

      runRetry();
    },
    [sendResize, terminalRef],
  );

  const scheduleReconnect = useCallback((): void => {
    if (
      localCleanupRef.current ||
      serverClosedRef.current ||
      reconnectTimerRef.current
    ) {
      return;
    }

    const generation = connectionGenerationRef.current;
    const timeoutId = setTimeout(() => {
      if (
        reconnectTimerRef.current?.generation !== generation ||
        localCleanupRef.current ||
        serverClosedRef.current ||
        connectionGenerationRef.current !== generation
      ) {
        return;
      }

      reconnectTimerRef.current = null;
      reconnectDelayRef.current = Math.min(
        reconnectDelayRef.current * RECONNECT_DELAY_MULTIPLIER,
        RECONNECT_DELAY_MAX,
      );
      connectWsRef.current();
    }, reconnectDelayRef.current);

    reconnectTimerRef.current = {
      generation,
      timeoutId,
    };
  }, []);

  const connectWs = useCallback((): void => {
    if (localCleanupRef.current || serverClosedRef.current) {
      return;
    }

    let url = terminalWsUrl(tabId);
    url += `&resume_from=${bytePositionRef.current}`;

    const generation = connectionGenerationRef.current + 1;
    connectionGenerationRef.current = generation;

    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    if (connectFrameRef.current !== null) {
      cancelAnimationFrame(connectFrameRef.current.frameId);
      connectFrameRef.current = null;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      if (!isCurrentConnection(ws, generation)) {
        return;
      }

      setConnected(true);
      setEverConnected(true);
      reconnectDelayRef.current = RECONNECT_DELAY_INITIAL;
      lastSentViewportRef.current = "";
      flushInputAfterResizeRef.current = inputBufferRef.current.length > 0;

      if (!sendResize(true)) {
        scheduleResizeRetry(generation);
      } else if (visibleRef.current) {
        connectFrameRef.current = null;
        terminalRef.current?.focus();
      }
    };

    ws.onmessage = (event) => {
      if (!isCurrentConnection(ws, generation)) {
        return;
      }

      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data) as ServerControlMessage;
          switch (message.type) {
            case "tab_closed":
              serverClosedRef.current = true;
              onClosedRef.current?.(tabId);
              return;
            case "attached":
              applyPtySize(message.cols, message.rows);
              bytePositionRef.current = message.byte_offset;
              if (message.snapshot) {
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
      if (!isCurrentConnection(ws, generation)) {
        return;
      }

      setConnected(false);
      wsRef.current = null;
      if (!localCleanupRef.current && !serverClosedRef.current) {
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose fires after onerror — reconnect handled there
    };
  }, [
    applyPtySize,
    isCurrentConnection,
    scheduleResizeRetry,
    scheduleReconnect,
    sendResize,
    tabId,
    terminalRef,
  ]);

  useEffect(() => {
    connectWsRef.current = connectWs;
  }, [connectWs]);

  useEffect(() => {
    if (!visible || connectionStarted) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      startConnectionFrameRef.current = null;
      setConnectionStarted(true);
    });
    startConnectionFrameRef.current = frameId;

    return () => {
      if (startConnectionFrameRef.current !== null) {
        cancelAnimationFrame(startConnectionFrameRef.current);
        startConnectionFrameRef.current = null;
      }
    };
  }, [connectionStarted, visible]);

  useEffect(() => {
    if (!connectionStarted) {
      return;
    }

    const container = containerRef.current;
    if (!container || !terminalRef.current) {
      return;
    }

    localCleanupRef.current = false;
    serverClosedRef.current = false;
    connectWs();

    const observer = new ResizeObserver(() => {
      void measureViewport();
      sendResize();
    });
    observer.observe(container);
    resizeObserverRef.current = observer;

    return () => {
      // Component teardown detaches this browser attachment only. The server
      // keeps the PTY-backed LiveTab alive so a later remount can reconnect.
      localCleanupRef.current = true;
      connectionGenerationRef.current += 1;
      if (connectFrameRef.current !== null) {
        cancelAnimationFrame(connectFrameRef.current.frameId);
        connectFrameRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current.timeoutId);
        reconnectTimerRef.current = null;
      }
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [
    connectionStarted,
    connectWs,
    containerRef,
    measureViewport,
    sendResize,
    tabId,
    terminalRef,
  ]);

  useEffect(() => {
    visibleRef.current = visible;

    if (!connectionStarted || !terminalRef.current) {
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
  }, [connectionStarted, sendResize, terminalRef, visible]);

  const handleTerminalData = useCallback((data: string): void => {
    const encoded = encoderRef.current.encode(data);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(toArrayBuffer(encoded));
    } else {
      inputBufferRef.current.push(encoded);
    }
  }, []);

  const handleTerminalBinary = useCallback((data: string): void => {
    const encoded = encodeBinaryInput(data);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(toArrayBuffer(encoded));
    } else {
      inputBufferRef.current.push(encoded);
    }
  }, []);

  return {
    connected,
    everConnected,
    handleTerminalBinary,
    handleTerminalData,
    sendResize,
  };
}
