import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { TerminalAdapter, TerminalViewport } from "./adapter";
import { DEFAULT_FONT_FAMILY } from "./fonts";

export function getTerminalTheme(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const get = (prop: string): string | undefined =>
    style.getPropertyValue(prop).trim() || undefined;

  return Object.fromEntries(
    Object.entries<string | undefined>({
      background: get("--terminal-background"),
      foreground: get("--terminal-foreground"),
      cursor: get("--terminal-cursor"),
      selectionBackground: get("--terminal-selection"),
      black: get("--terminal-ansi-black"),
      red: get("--terminal-ansi-red"),
      green: get("--terminal-ansi-green"),
      yellow: get("--terminal-ansi-yellow"),
      blue: get("--terminal-ansi-blue"),
      magenta: get("--terminal-ansi-magenta"),
      cyan: get("--terminal-ansi-cyan"),
      white: get("--terminal-ansi-white"),
      brightBlack: get("--terminal-ansi-bright-black"),
      brightRed: get("--terminal-ansi-bright-red"),
      brightGreen: get("--terminal-ansi-bright-green"),
      brightYellow: get("--terminal-ansi-bright-yellow"),
      brightBlue: get("--terminal-ansi-bright-blue"),
      brightMagenta: get("--terminal-ansi-bright-magenta"),
      brightCyan: get("--terminal-ansi-bright-cyan"),
      brightWhite: get("--terminal-ansi-bright-white"),
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

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

  return {
    open(container: HTMLElement) {
      term.open(container);
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
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
      term.dispose();
    },
  };
}
