import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { createXtermAdapter } from "@/lib/terminal/xterm";
import { useThemeSettings } from "@/lib/stores/theme";
import { useTerminalSettings } from "@/lib/stores/terminal";
import type { TerminalAdapter } from "@/lib/terminal/adapter";
import { useTerminalConnection } from "@/components/terminal/useTerminalConnection";

type Props = {
  tabId: string;
  visible: boolean;
  focused?: boolean;
  onClosed?: (tabId: string) => void;
};
function TerminalTab({ tabId, visible, focused = true, onClosed }: Props) {
  const themeVersion = useThemeSettings((state) => state.version);
  const terminalVersion = useTerminalSettings((state) => state.version);
  const fontFamily = useTerminalSettings((state) => state.fontFamily);
  const fontSize = useTerminalSettings((state) => state.settings.fontSize);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<TerminalAdapter | null>(null);
  const fontFamilyRef = useRef(fontFamily);
  const fontSizeRef = useRef(fontSize);
  const {
    connected,
    everConnected,
    handleTerminalBinary,
    handleTerminalData,
    sendResize,
  } = useTerminalConnection({
    tabId,
    visible,
    focused,
    terminalRef,
    containerRef,
    onClosed,
  });

  useEffect(() => {
    fontFamilyRef.current = fontFamily;
    fontSizeRef.current = fontSize;
  }, [fontFamily, fontSize]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const terminal = createXtermAdapter({
      fontFamily: fontFamilyRef.current,
      fontSize: fontSizeRef.current,
    });
    terminalRef.current = terminal;
    terminal.open(container);

    const onDataSubscription = terminal.onData(handleTerminalData);
    const onBinarySubscription = terminal.onBinary(handleTerminalBinary);

    return () => {
      onBinarySubscription.dispose();
      onDataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [handleTerminalBinary, handleTerminalData, tabId]);

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
    sendResize(true);
  }, [fontFamily, fontSize, sendResize, terminalVersion]);

  useEffect(() => {
    if (!visible || !focused || !terminalRef.current) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      terminalRef.current?.focus();
    });

    return () => cancelAnimationFrame(frameId);
  }, [focused, visible]);

  return (
    <div className="terminal-wrapper">
      <div className="terminal-container" ref={containerRef} />
      {!connected && everConnected ? (
        <div className="reconnect-indicator">Reconnecting…</div>
      ) : null}
    </div>
  );
}

const MemoizedTerminalTab = memo(TerminalTab);

MemoizedTerminalTab.displayName = "TerminalTab";

export default MemoizedTerminalTab;
