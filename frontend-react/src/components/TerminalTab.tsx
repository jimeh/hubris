import React, { useEffect, useRef, useState, useCallback } from "react";
import { createXtermAdapter } from "@/lib/terminal/xterm";
import { terminalWsUrl } from "@/lib/api";
import type {
  ClientControlMessage,
  ServerControlMessage,
} from "@/lib/contracts/ws.generated";
import { useThemeStore } from "@/lib/stores/theme";
import { useTerminalStore } from "@/lib/stores/terminal";
import type { TerminalAdapter } from "@/lib/terminal/adapter";

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

  const [everConnected, setEverConnected] = useState(false);
  const [connected, setConnected] = useState(false);

  const themeVersion = useThemeStore((s) => s.version);
  const termFontFamily = useTerminalStore((s) => s.fontFamily);
  const termFontSize = useTerminalStore((s) => s.fontSize);
  const termVersion = useTerminalStore((s) => s.version);

  const sendControlMessage = useCallback((message: ClientControlMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const sendResize = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    sendControlMessage({
      type: "resize",
      cols: terminal.cols,
      rows: terminal.rows,
    });
  }, [sendControlMessage]);

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

      sendResize();

      for (const chunk of inputBufferRef.current) {
        ws.send(chunk);
      }
      inputBufferRef.current = [];

      terminalRef.current?.focus();
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
              bytePositionRef.current = msg.byte_offset;
              if (msg.data_lost) {
                terminalRef.current?.clear();
              }
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
      // onclose fires after onerror
    };
  }, [tabId, onClosed, sendResize, scheduleReconnect]);
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
      if (terminalRef.current) {
        terminalRef.current.fit();
        sendResize();
      }
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

  // Fit when tab becomes visible
  useEffect(() => {
    if (visible && terminalRef.current) {
      requestAnimationFrame(() => {
        terminalRef.current?.fit();
        terminalRef.current?.focus();
      });
    }
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
      sendResize();
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
