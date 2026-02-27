export interface TerminalAdapter {
  open(container: HTMLElement): void;
  write(data: string | Uint8Array): void;
  onData(cb: (data: string) => void): { dispose(): void };
  resize(cols: number, rows: number): void;
  fit(): void;
  get rows(): number;
  get cols(): number;
  focus(): void;
  dispose(): void;
}
