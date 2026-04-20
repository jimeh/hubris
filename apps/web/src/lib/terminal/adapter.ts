export interface TerminalViewport {
  cols: number;
  rows: number;
}

export interface TerminalAdapter {
  open(container: HTMLElement): void;
  write(data: string | Uint8Array): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onBinary(cb: (data: string) => void): { dispose(): void };
  resize(cols: number, rows: number): void;
  measureViewport(): TerminalViewport | null;
  get rows(): number;
  get cols(): number;
  focus(): void;
  /** Reset terminal state, clearing screen and scrollback. */
  clear(): void;
  refreshTheme(): void;
  updateFont(family: string, size: number): void;
  updateScrollback(rows: number): void;
  dispose(): void;
}
