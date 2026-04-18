import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopWebSocketBridge } from "./webSocketRendererBridge";

type BridgeEvent =
  | { id: string; type: "open"; protocol?: string }
  | { id: string; type: "message"; data?: string; binary: boolean };

const originalWindow = globalThis.window;

class MockWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(
    public url: string | URL,
    public protocols?: string | string[],
  ) {
    super();
  }
}

describe("installDesktopWebSocketPatch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    Object.defineProperty(globalThis, "window", {
      value: {
        WebSocket: MockWebSocket,
        location: {
          href: "https://desktop.internal.hubris.build/",
        },
      },
      configurable: true,
      writable: true,
    });
    delete window.__HUBRIS_ELECTRON_WS__;
    delete window.__HUBRIS_WS_PATCHED__;
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
  });

  it("delivers bridged text messages without base64 decoding them", async () => {
    const listeners = new Set<(event: BridgeEvent) => void>();
    let nextSocketId = 0;

    const bridge: DesktopWebSocketBridge = {
      connect: vi.fn(async () => ({ id: `socket-${(nextSocketId += 1)}` })),
      send: vi.fn(),
      close: vi.fn(),
      subscribe: vi.fn((listener) => {
        listeners.add(listener as (event: BridgeEvent) => void);
        return () => {
          listeners.delete(listener as (event: BridgeEvent) => void);
        };
      }),
    };

    window.__HUBRIS_ELECTRON_WS__ = bridge;

    const { installDesktopWebSocketPatch } =
      await import("./webSocketPatch.js");
    installDesktopWebSocketPatch([
      "desktop.internal.hubris.build",
      "vscode-cli.desktop.internal.hubris.build",
      "code-server.desktop.internal.hubris.build",
    ]);

    const socket = new window.WebSocket(
      "wss://desktop.internal.hubris.build/api/events",
    );
    const messagePromise = new Promise<MessageEvent>((resolve) => {
      socket.onmessage = resolve;
    });

    await Promise.resolve();
    for (const listener of listeners) {
      listener({
        id: "socket-1",
        type: "open",
        protocol: "",
      });
    }
    for (const listener of listeners) {
      listener({
        id: "socket-1",
        type: "message",
        data: '{"type":"ping"}',
        binary: false,
      });
    }

    const messageEvent = await messagePromise;
    expect(messageEvent.data).toBe('{"type":"ping"}');
  });
});
