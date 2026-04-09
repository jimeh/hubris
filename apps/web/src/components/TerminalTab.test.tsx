import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalAdapter, TerminalViewport } from "@/lib/terminal/adapter";
import TerminalTab from "@/components/TerminalTab";

let currentViewport: TerminalViewport | null = { cols: 100, rows: 30 };
let terminalDataHandler: ((data: string) => void) | null = null;
let mockTerminal: TerminalAdapter;

const themeState = { version: 0 };
const terminalState = {
  version: 0,
  fontFamily: "JetBrains Mono",
  settings: {
    fontSize: 14,
  },
};

let resizeObserverCallback: ResizeObserverCallback | null = null;
const mockCreateXtermAdapter = vi.fn();

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallback = callback;
  }

  observe() {}

  unobserve() {}

  disconnect() {}
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  binaryType = "";
  readyState = MockWebSocket.CONNECTING;
  sent: Array<string | ArrayBuffer> = [];
  url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send = vi.fn((data: string | ArrayBuffer) => {
    this.sent.push(data);
  });

  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  });

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(data: string | ArrayBuffer): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

vi.mock("@/lib/terminal/xterm", () => ({
  createXtermAdapter: (...args: unknown[]) => mockCreateXtermAdapter(...args),
}));

vi.mock("@/lib/api", () => ({
  terminalWsUrl: (tabId: string) => `ws://example.test/${tabId}`,
}));

vi.mock("@/lib/stores/theme", () => ({
  useThemeSettings: <T,>(selector: (state: typeof themeState) => T) =>
    selector(themeState),
}));

vi.mock("@/lib/stores/terminal", () => ({
  useTerminalSettings: <T,>(selector: (state: typeof terminalState) => T) =>
    selector(terminalState),
}));

function parseControlMessage(message: string | ArrayBuffer) {
  expect(typeof message).toBe("string");
  return JSON.parse(message as string);
}

function parseBinaryMessage(message: string | ArrayBuffer): number[] {
  expect(typeof message).not.toBe("string");
  return Array.from(new Uint8Array(message as ArrayBuffer));
}

function triggerResizeObserver(): void {
  if (!resizeObserverCallback) {
    throw new Error("ResizeObserver callback not registered");
  }

  act(() => {
    resizeObserverCallback?.([], {} as ResizeObserver);
  });
}

describe("TerminalTab", () => {
  beforeEach(() => {
    MockWebSocket.instances.length = 0;
    resizeObserverCallback = null;
    currentViewport = { cols: 100, rows: 30 };
    terminalDataHandler = null;
    themeState.version = 0;
    terminalState.version = 0;
    terminalState.fontFamily = "JetBrains Mono";
    terminalState.settings.fontSize = 14;

    mockTerminal = {
      open: vi.fn(),
      write: vi.fn(),
      onData: vi.fn((callback: (data: string) => void) => {
        terminalDataHandler = callback;
        return { dispose: vi.fn() };
      }),
      onBinary: vi.fn(() => ({ dispose: vi.fn() })),
      resize: vi.fn(),
      measureViewport: vi.fn(() => currentViewport),
      get rows() {
        return currentViewport?.rows ?? 24;
      },
      get cols() {
        return currentViewport?.cols ?? 80;
      },
      focus: vi.fn(),
      clear: vi.fn(),
      refreshTheme: vi.fn(),
      updateFont: vi.fn(),
      dispose: vi.fn(),
    };
    mockCreateXtermAdapter.mockReset();
    mockCreateXtermAdapter.mockReturnValue(mockTerminal);

    window.ResizeObserver =
      ResizeObserverMock as unknown as typeof ResizeObserver;
    window.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    };
    window.cancelAnimationFrame = vi.fn();
  });

  it("sends visible resize on open and applies attached PTY size", () => {
    render(<TerminalTab tabId="tab-1" visible onClosed={vi.fn()} />);

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
    });

    expect(parseControlMessage(ws.sent[0])).toEqual({
      type: "resize",
      cols: 100,
      rows: 30,
      visible: true,
    });

    act(() => {
      ws.receive(
        JSON.stringify({
          type: "attached",
          byte_offset: 12,
          snapshot: true,
          data_lost: true,
          cols: 90,
          rows: 25,
        }),
      );
    });

    expect(mockTerminal.resize).toHaveBeenCalledWith(90, 25);
    expect(mockTerminal.clear).toHaveBeenCalledTimes(1);
  });

  it("waits to connect until a hidden terminal becomes visible", () => {
    const { rerender } = render(
      <TerminalTab tabId="tab-1" visible={false} onClosed={vi.fn()} />,
    );

    expect(MockWebSocket.instances).toHaveLength(0);

    rerender(<TerminalTab tabId="tab-1" visible onClosed={vi.fn()} />);

    expect(MockWebSocket.instances).toHaveLength(1);

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
    });

    expect(parseControlMessage(ws.sent[0])).toEqual({
      type: "resize",
      cols: 100,
      rows: 30,
      visible: true,
    });
  });

  it("sends hidden resize participation changes when visibility flips", () => {
    const { rerender } = render(
      <TerminalTab tabId="tab-1" visible onClosed={vi.fn()} />,
    );

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
    });

    rerender(<TerminalTab tabId="tab-1" visible={false} onClosed={vi.fn()} />);

    expect(parseControlMessage(ws.sent.at(-1)!)).toEqual({
      type: "resize",
      cols: 100,
      rows: 30,
      visible: false,
    });
  });

  it("flushes buffered input only after the viewport resize is sent", () => {
    render(<TerminalTab tabId="tab-1" visible onClosed={vi.fn()} />);

    const ws = MockWebSocket.instances[0];
    act(() => {
      terminalDataHandler?.("ls\n");
    });

    expect(ws.sent).toHaveLength(0);

    act(() => {
      ws.open();
    });

    expect(parseControlMessage(ws.sent[0])).toEqual({
      type: "resize",
      cols: 100,
      rows: 30,
      visible: true,
    });
    expect(parseBinaryMessage(ws.sent[1])).toEqual(
      Array.from(new TextEncoder().encode("ls\n")),
    );
  });

  it("retries the initial resize on the next animation frame if measurement is not ready", () => {
    let queuedFrame: FrameRequestCallback | null = null;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      queuedFrame = callback;
      return 1;
    }) as typeof window.requestAnimationFrame;
    currentViewport = null;

    render(<TerminalTab tabId="tab-1" visible onClosed={vi.fn()} />);

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
    });

    expect(ws.sent).toHaveLength(0);
    expect(queuedFrame).not.toBeNull();

    currentViewport = { cols: 100, rows: 30 };
    act(() => {
      queuedFrame?.(0);
    });

    expect(parseControlMessage(ws.sent[0])).toEqual({
      type: "resize",
      cols: 100,
      rows: 30,
      visible: true,
    });
  });

  it("dedupes identical resize messages and applies pty_resized events", () => {
    render(<TerminalTab tabId="tab-1" visible onClosed={vi.fn()} />);

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
    });

    triggerResizeObserver();
    expect(ws.sent).toHaveLength(1);

    currentViewport = { cols: 110, rows: 32 };
    triggerResizeObserver();

    expect(parseControlMessage(ws.sent.at(-1)!)).toEqual({
      type: "resize",
      cols: 110,
      rows: 32,
      visible: true,
    });

    act(() => {
      ws.receive(
        JSON.stringify({
          type: "pty_resized",
          cols: 88,
          rows: 22,
        }),
      );
    });

    expect(mockTerminal.resize).toHaveBeenCalledWith(88, 22);
  });

  it("forces a resize update after terminal font changes", () => {
    const { rerender } = render(
      <TerminalTab tabId="tab-1" visible onClosed={vi.fn()} />,
    );

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
    });

    terminalState.version = 1;
    terminalState.fontFamily = "Fira Code";
    terminalState.settings.fontSize = 16;

    rerender(<TerminalTab tabId="tab-1" visible onClosed={vi.fn()} />);

    expect(mockTerminal.updateFont).toHaveBeenCalledWith("Fira Code", 16);
    expect(parseControlMessage(ws.sent.at(-1)!)).toEqual({
      type: "resize",
      cols: 100,
      rows: 30,
      visible: true,
    });
  });

  it("cancels pending resize retry frames during cleanup", () => {
    window.requestAnimationFrame = vi.fn(() => 42);
    currentViewport = null;

    const { unmount } = render(
      <TerminalTab tabId="tab-1" visible onClosed={vi.fn()} />,
    );

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
    });

    unmount();

    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(42);
    expect(mockTerminal.dispose).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it("disposes the adapter and reconnects cleanly after remount", () => {
    const firstRender = render(
      <TerminalTab tabId="tab-1" visible onClosed={vi.fn()} />,
    );

    const firstSocket = MockWebSocket.instances[0];
    act(() => {
      firstSocket.open();
    });

    firstRender.unmount();

    expect(mockCreateXtermAdapter).toHaveBeenCalledTimes(1);
    expect(mockTerminal.open).toHaveBeenCalledTimes(1);
    expect(mockTerminal.dispose).toHaveBeenCalledTimes(1);
    expect(firstSocket.close).toHaveBeenCalledTimes(1);

    render(<TerminalTab tabId="tab-1" visible onClosed={vi.fn()} />);

    const secondSocket = MockWebSocket.instances[1];
    act(() => {
      secondSocket.open();
    });

    expect(mockCreateXtermAdapter).toHaveBeenCalledTimes(2);
    expect(mockTerminal.open).toHaveBeenCalledTimes(2);
    expect(parseControlMessage(secondSocket.sent[0])).toEqual({
      type: "resize",
      cols: 100,
      rows: 30,
      visible: true,
    });
  });
});
