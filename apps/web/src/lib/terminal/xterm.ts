import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { TerminalAdapter, TerminalViewport } from "./adapter";
import { DEFAULT_FONT_FAMILY } from "./fonts";
import { getTerminalTheme } from "./theme";

export function createXtermAdapter(opts?: {
  fontSize?: number;
  fontFamily?: string;
}): TerminalAdapter {
  const term = new Terminal({
    fontSize: opts?.fontSize ?? 14,
    fontFamily: opts?.fontFamily ?? DEFAULT_FONT_FAMILY,
    theme: getTerminalTheme(),
    cursorBlink: true,
    scrollback: 10000,
  });

  const fitAddon = new FitAddon();
  let contextLossSubscription: { dispose(): void } | null = null;

  return {
    open(container: HTMLElement) {
      term.open(container);
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      try {
        const webgl = new WebglAddon();
        contextLossSubscription = webgl.onContextLoss(() => {
          webgl.dispose();
        });
        term.loadAddon(webgl);
      } catch {
        // WebGL not available, use default canvas
      }
    },
    write(data: string | Uint8Array) {
      term.write(data);
    },
    onData(cb: (data: string) => void) {
      return term.onData(cb);
    },
    onBinary(cb: (data: string) => void) {
      return term.onBinary(cb);
    },
    resize(cols: number, rows: number) {
      term.resize(cols, rows);
    },
    measureViewport(): TerminalViewport | null {
      const viewport = fitAddon.proposeDimensions();
      if (!viewport) {
        return null;
      }

      return {
        cols: viewport.cols,
        rows: viewport.rows,
      };
    },
    get rows() {
      return term.rows;
    },
    get cols() {
      return term.cols;
    },
    focus() {
      term.focus();
    },
    clear() {
      term.reset();
    },
    refreshTheme() {
      term.options.theme = getTerminalTheme();
    },
    updateFont(family: string, size: number) {
      term.options.fontFamily = family;
      term.options.fontSize = size;
    },
    dispose() {
      contextLossSubscription?.dispose();
      contextLossSubscription = null;
      term.dispose();
    },
  };
}
