import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { createXtermAdapter } from "@/lib/terminal/xterm";
import { useThemeStore } from "@/lib/stores/theme";
import { useTerminalStore } from "@/lib/stores/terminal";
import type { TerminalAdapter } from "@/lib/terminal/adapter";
import { useTerminalConnection } from "@/components/terminal/useTerminalConnection";

type Props = {
  tabId: string;
  visible: boolean;
  onClosed?: (tabId: string) => void;
};
function TerminalTab({ tabId, visible, onClosed }: Props) {
  const themeVersion = useThemeStore((state) => state.version);
  const terminalVersion = useTerminalStore((state) => state.version);
  const fontFamily = useTerminalStore((state) => state.fontFamily);
  const fontSize = useTerminalStore((state) => state.settings.fontSize);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<TerminalAdapter | null>(null);
  const fontFamilyRef = useRef(fontFamily);
  const fontSizeRef = useRef(fontSize);
  const { connected, everConnected, handleTerminalData, sendResize } =
    useTerminalConnection({
      tabId,
      visible,
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

    return () => {
      onDataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [handleTerminalData, tabId]);

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
