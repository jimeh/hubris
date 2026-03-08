// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalAdapter, TerminalViewport } from "@/lib/terminal/adapter";
import { useTerminalConnection } from "./useTerminalConnection";

let currentViewport: TerminalViewport | null = { cols: 100, rows: 30 };
let resizeObserverCallback: ResizeObserverCallback | null = null;
let mockTerminal: TerminalAdapter;

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
  sent: Array<string | Uint8Array> = [];
  url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send = vi.fn((data: string | Uint8Array) => {
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

vi.mock("@/lib/api", () => ({
  terminalWsUrl: (tabId: string) => `ws://example.test/${tabId}`,
}));

function parseControlMessage(message: string | Uint8Array) {
  expect(typeof message).toBe("string");
  return JSON.parse(message as string);
}

function triggerResizeObserver(): void {
  if (!resizeObserverCallback) {
    throw new Error("ResizeObserver callback not registered");
  }

  act(() => {
    resizeObserverCallback?.([], {} as ResizeObserver);
  });
}

function renderTerminalConnection({
  visible = true,
  onClosed = vi.fn(),
}: {
  visible?: boolean;
  onClosed?: (tabId: string) => void;
} = {}) {
  const terminalRef = {
    current: mockTerminal,
  } as RefObject<TerminalAdapter | null>;
  const containerRef = {
    current: document.createElement("div"),
  } as RefObject<HTMLDivElement | null>;

  return renderHook(
    ({ visible: currentVisible, onClosed: currentOnClosed }) =>
      useTerminalConnection({
        tabId: "tab-1",
        visible: currentVisible,
        terminalRef,
        containerRef,
        onClosed: currentOnClosed,
      }),
    {
      initialProps: {
        visible,
        onClosed,
      },
    },
  );
}

describe("useTerminalConnection", () => {
  beforeEach(() => {
    MockWebSocket.instances.length = 0;
    resizeObserverCallback = null;
    currentViewport = { cols: 100, rows: 30 };

    mockTerminal = {
      open: vi.fn(),
      write: vi.fn(),
      onData: vi.fn(),
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

    window.ResizeObserver =
      ResizeObserverMock as unknown as typeof ResizeObserver;
    window.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    };
    window.cancelAnimationFrame = vi.fn();
    vi.useFakeTimers();
  });

  it("sends visible resize on open and applies attached PTY size", () => {
    const { result } = renderTerminalConnection();

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
    });

    expect(result.current.connected).toBe(true);
    expect(result.current.everConnected).toBe(true);
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
          data_lost: true,
          cols: 90,
          rows: 25,
        }),
      );
    });

    expect(mockTerminal.resize).toHaveBeenCalledWith(90, 25);
    expect(mockTerminal.clear).toHaveBeenCalledTimes(1);
  });

  it("builds a hidden resize message after visibility flips", () => {
    const { result, rerender } = renderTerminalConnection();

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
    });

    rerender({ visible: false, onClosed: vi.fn() });

    act(() => {
      result.current.sendResize(true);
    });

    expect(parseControlMessage(ws.sent.at(-1)!)).toEqual({
      type: "resize",
      cols: 100,
      rows: 30,
      visible: false,
    });
  });

  it("flushes buffered input only after the viewport resize is sent", () => {
    const { result } = renderTerminalConnection();

    const ws = MockWebSocket.instances[0];
    act(() => {
      result.current.handleTerminalData("ls\n");
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
    expect(typeof ws.sent[1]).not.toBe("string");
    expect(Array.from(ws.sent[1] as ArrayLike<number>)).toEqual(
      Array.from(new TextEncoder().encode("ls\n")),
    );
  });

  it("retries initial resize on the next animation frame if measurement is not ready", () => {
    let queuedFrame: FrameRequestCallback | null = null;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      queuedFrame = callback;
      return 1;
    }) as typeof window.requestAnimationFrame;
    currentViewport = null;

    renderTerminalConnection();

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

  it("dedupes resize messages and applies pty_resized events", () => {
    const { result } = renderTerminalConnection();

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

    expect(result.current.connected).toBe(true);
    expect(mockTerminal.resize).toHaveBeenCalledWith(88, 22);
  });

  it("schedules reconnects and cancels them on cleanup", () => {
    const { unmount } = renderTerminalConnection();

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
    });

    act(() => {
      ws.onclose?.(new CloseEvent("close"));
    });

    expect(MockWebSocket.instances).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => {
      MockWebSocket.instances[1].onclose?.(new CloseEvent("close"));
    });

    unmount();

    act(() => {
      vi.runAllTimers();
    });

    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("does not reconnect after an intentional tab_closed message", () => {
    const onClosed = vi.fn();
    renderTerminalConnection({ onClosed });

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
    });

    act(() => {
      ws.receive(
        JSON.stringify({
          type: "tab_closed",
        }),
      );
    });

    expect(onClosed).toHaveBeenCalledWith("tab-1");

    act(() => {
      ws.onclose?.(new CloseEvent("close"));
      vi.runAllTimers();
    });

    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
