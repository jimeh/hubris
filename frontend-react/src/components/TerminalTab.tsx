import { useCallback, useEffect, useRef, useState } from "react";
import { createXtermAdapter } from "$lib/terminal/xterm";
import { terminalWsUrl } from "$lib/api";
import type {
  ClientControlMessage,
  ServerControlMessage,
} from "$lib/contracts/ws.generated";
import { useThemeStore } from "$lib/stores/theme";
import { useTerminalStore } from "$lib/stores/terminal";
import type { TerminalAdapter } from "$lib/terminal/adapter";

type Props = {
  tabId: string;
  visible: boolean;
  onClosed?: () => void;
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

  const sendControlMessage = useCallback(
    (message: ClientControlMessage): void => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(message));
      }
    },
    [],
  );

  const sendResize = useCallback((): void => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }

      sendControlMessage({
        type: "resize",
        cols: terminal.cols,
        rows: terminal.rows,
      });
    }
  }, [sendControlMessage]);

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
      sendResize();

      for (const chunk of inputBufferRef.current) {
        ws.send(chunk);
      }
      inputBufferRef.current = [];
      terminalRef.current?.focus();
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data) as ServerControlMessage;
          switch (message.type) {
            case "tab_closed":
              intentionalCloseRef.current = true;
              onClosedRef.current?.();
              return;
            case "attached":
              bytePositionRef.current = message.byte_offset;
              if (message.data_lost) {
                terminalRef.current?.clear();
              }
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
  }, [scheduleReconnect, sendResize, tabId]);

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
    terminal.onData((data) => {
      const encoded = encoder.encode(data);
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(encoded);
      } else {
        inputBufferRef.current.push(encoded);
      }
    });

    connectWs();

    const observer = new ResizeObserver(() => {
      if (visibleRef.current) {
        terminalRef.current?.fit();
        sendResize();
      }
    });
    observer.observe(container);
    resizeObserverRef.current = observer;

    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      resizeObserverRef.current?.disconnect();
      wsRef.current?.close();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [connectWs, sendResize, tabId]);

  useEffect(() => {
    if (!visible || !terminalRef.current) {
      return;
    }

    requestAnimationFrame(() => {
      terminalRef.current?.fit();
      terminalRef.current?.focus();
    });
  }, [visible]);

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
    sendResize();
  }, [fontFamily, fontSize, sendResize, terminalVersion]);

  return (
    <div className="terminal-wrapper">
      <div className="terminal-container" ref={containerRef} />
      {!connected && everConnected ? (
        <div className="reconnect-indicator">Reconnecting…</div>
      ) : null}
    </div>
  );
}
