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
  static instances: ResizeObserverMock[] = [];
  disconnect = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallback = callback;
    ResizeObserverMock.instances.push(this);
  }

  observe() {}
  unobserve() {}
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
    ResizeObserverMock.instances.length = 0;
    resizeObserverCallback = null;
    currentViewport = { cols: 100, rows: 30 };

    mockTerminal = {
      open: vi.fn(),
      write: vi.fn(),
      onData: vi.fn(),
      onBinary: vi.fn(),
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

  it("defers websocket creation until a hidden tab becomes visible", () => {
    const queuedFrames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      queuedFrames.set(frameId, callback);
      return frameId;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = vi.fn((frameId: number) => {
      queuedFrames.delete(frameId);
    }) as typeof window.cancelAnimationFrame;

    const { rerender } = renderTerminalConnection({ visible: false });

    expect(MockWebSocket.instances).toHaveLength(0);
    expect(queuedFrames.size).toBe(0);

    act(() => {
      rerender({ visible: true, onClosed: vi.fn() });
    });

    expect(MockWebSocket.instances).toHaveLength(0);

    act(() => {
      for (const callback of Array.from(queuedFrames.values())) {
        callback(0);
      }
      queuedFrames.clear();
    });

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

  it("keeps the existing connection when a started tab is shown again", () => {
    const queuedFrames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      queuedFrames.set(frameId, callback);
      return frameId;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = vi.fn((frameId: number) => {
      queuedFrames.delete(frameId);
    }) as typeof window.cancelAnimationFrame;

    const { result, rerender } = renderTerminalConnection({ visible: false });

    act(() => {
      rerender({ visible: true, onClosed: vi.fn() });
    });

    act(() => {
      for (const callback of Array.from(queuedFrames.values())) {
        callback(0);
      }
      queuedFrames.clear();
    });

    expect(MockWebSocket.instances).toHaveLength(1);

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

    rerender({ visible: true, onClosed: vi.fn() });

    act(() => {
      result.current.sendResize(true);
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(parseControlMessage(ws.sent.at(-1)!)).toEqual({
      type: "resize",
      cols: 100,
      rows: 30,
      visible: true,
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

  it("closes the current attachment and reconnects cleanly after remount", () => {
    const cancelAnimationFrameSpy = vi.fn();
    window.requestAnimationFrame = vi.fn(() => 42);
    window.cancelAnimationFrame =
      cancelAnimationFrameSpy as typeof window.cancelAnimationFrame;
    currentViewport = null;

    const firstRender = renderTerminalConnection();
    const firstSocket = MockWebSocket.instances[0];

    act(() => {
      firstSocket.open();
    });

    firstRender.unmount();

    expect(firstSocket.close).toHaveBeenCalledTimes(1);
    expect(cancelAnimationFrameSpy).toHaveBeenCalledWith(42);
    expect(ResizeObserverMock.instances[0]?.disconnect).toHaveBeenCalledTimes(
      1,
    );

    act(() => {
      vi.runAllTimers();
    });

    expect(MockWebSocket.instances).toHaveLength(1);

    currentViewport = { cols: 100, rows: 30 };
    const secondRender = renderTerminalConnection();
    const secondSocket = MockWebSocket.instances[1];

    act(() => {
      secondSocket.open();
    });

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(parseControlMessage(secondSocket.sent[0])).toEqual({
      type: "resize",
      cols: 100,
      rows: 30,
      visible: true,
    });

    secondRender.unmount();
  });

  it("ignores stale socket close and message events after remount", () => {
    const firstRender = renderTerminalConnection();
    const firstSocket = MockWebSocket.instances[0];

    act(() => {
      firstSocket.open();
    });

    firstRender.unmount();

    const secondRender = renderTerminalConnection();
    const secondSocket = MockWebSocket.instances[1];

    act(() => {
      secondSocket.open();
    });

    act(() => {
      firstSocket.receive(
        JSON.stringify({
          type: "attached",
          byte_offset: 999,
          snapshot: true,
          data_lost: true,
          cols: 77,
          rows: 21,
        }),
      );
      firstSocket.onclose?.(new CloseEvent("close"));
      vi.runAllTimers();
    });

    expect(mockTerminal.resize).not.toHaveBeenCalledWith(77, 21);
    expect(mockTerminal.clear).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(2);

    secondRender.unmount();
  });

  it("ignores stale post-open resize frames from an earlier connection", () => {
    const queuedFrames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    const cancelAnimationFrameSpy = vi.fn((id: number) => {
      queuedFrames.delete(id);
    });

    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      queuedFrames.set(id, callback);
      return id;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame =
      cancelAnimationFrameSpy as typeof window.cancelAnimationFrame;
    currentViewport = null;

    const firstRender = renderTerminalConnection();

    const firstSocket = MockWebSocket.instances[0];
    act(() => {
      firstSocket.open();
    });

    const firstFrameCallback = queuedFrames.get(1);
    expect(firstFrameCallback).toBeDefined();

    firstRender.unmount();

    expect(cancelAnimationFrameSpy).toHaveBeenCalledWith(1);

    currentViewport = { cols: 100, rows: 30 };
    const secondRender = renderTerminalConnection();

    const secondSocket = MockWebSocket.instances[1];
    act(() => {
      secondSocket.open();
    });

    act(() => {
      firstFrameCallback?.(0);
    });

    expect(MockWebSocket.instances).toHaveLength(2);

    secondRender.unmount();
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

  it("does not clear the terminal on byte-resume attach", () => {
    renderTerminalConnection();

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.open();
      ws.receive(
        JSON.stringify({
          type: "attached",
          byte_offset: 12,
          snapshot: false,
          data_lost: false,
          cols: 90,
          rows: 25,
        }),
      );
    });

    expect(mockTerminal.clear).not.toHaveBeenCalled();
  });

  it("buffers and sends binary terminal input as websocket frames", () => {
    const { result } = renderTerminalConnection();

    const ws = MockWebSocket.instances[0];
    act(() => {
      result.current.handleTerminalBinary("\u0000A\u00ff");
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
    expect(Array.from(ws.sent[1] as ArrayLike<number>)).toEqual([0, 65, 255]);
  });
});
