import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { TerminalAdapter } from './adapter';

export function createXtermAdapter(opts?: {
  fontSize?: number;
  fontFamily?: string;
}): TerminalAdapter {
  const term = new Terminal({
    fontSize: opts?.fontSize ?? 14,
    fontFamily: opts?.fontFamily ?? "'JetBrains Mono', 'Fira Code', monospace",
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
    },
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
    fit() {
      fitAddon.fit();
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
    dispose() {
      term.dispose();
    },
  };
}
