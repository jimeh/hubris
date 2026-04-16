import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventClient } from "./events";

// Mock EventSource
class MockEventSource {
  url: string;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  onerror: (() => void) | null = null;
  closeCalled = false;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(name: string, handler: (e: MessageEvent) => void) {
    if (!this.listeners.has(name)) {
      this.listeners.set(name, []);
    }
    this.listeners.get(name)!.push(handler);
  }

  close() {
    this.closeCalled = true;
  }

  // Test helper: simulate a server event
  simulateEvent(name: string, data: unknown) {
    const handlers = this.listeners.get(name) ?? [];
    const event = {
      data: JSON.stringify(data),
    } as MessageEvent;
    for (const handler of handlers) {
      handler(event);
    }
  }
}

describe("EventClient", () => {
  let mockEs: MockEventSource;
  let constructorCalls: string[];

  beforeEach(() => {
    constructorCalls = [];
    // Use a real class so `new EventSource(...)` works
    vi.stubGlobal(
      "EventSource",
      class extends MockEventSource {
        constructor(url: string) {
          super(url);
          constructorCalls.push(url);
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          mockEs = this;
        }
      },
    );
  });

  it("connect() creates EventSource with session_id", () => {
    const client = new EventClient();
    client.connect("default");

    expect(constructorCalls).toEqual(["/api/events?session_id=default"]);
  });

  it("connect() is idempotent", () => {
    const client = new EventClient();
    client.connect();
    client.connect();

    expect(constructorCalls).toHaveLength(1);
  });

  it("on() registers handlers that receive events", () => {
    const client = new EventClient();
    const handler = vi.fn();
    client.on("tab_created", handler);
    client.connect();

    // Simulate server sending a tab_created event
    mockEs.simulateEvent("tab_created", {
      type: "tab_created",
      data: { id: "t1", label: "Terminal 1" },
    });

    expect(handler).toHaveBeenCalledWith({
      id: "t1",
      label: "Terminal 1",
    });
  });

  it("multiple handlers for same event all called", () => {
    const client = new EventClient();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    client.on("snapshot", handler1);
    client.on("snapshot", handler2);
    client.connect();

    mockEs.simulateEvent("snapshot", {
      type: "snapshot",
      data: { tabs: [] },
    });

    expect(handler1).toHaveBeenCalledWith({ tabs: [] });
    expect(handler2).toHaveBeenCalledWith({ tabs: [] });
  });

  it("on() returns unsubscribe function", () => {
    const client = new EventClient();
    const handler = vi.fn();
    const unsub = client.on("tab_closed", handler);
    client.connect();

    unsub();

    mockEs.simulateEvent("tab_closed", {
      type: "tab_closed",
      data: { tab_id: "t1" },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches managed_process_updated events", () => {
    const client = new EventClient();
    const handler = vi.fn();
    client.on("managed_process_updated", handler);
    client.connect();

    mockEs.simulateEvent("managed_process_updated", {
      type: "managed_process_updated",
      data: {
        id: "code-server",
        kind: "vscode",
        lifecycleState: "running",
        pid: 12345,
        startedAt: "2026-04-16T12:00:00Z",
        lastExit: null,
        lastError: null,
      },
    });

    expect(handler).toHaveBeenCalledWith({
      id: "code-server",
      kind: "vscode",
      lifecycleState: "running",
      pid: 12345,
      startedAt: "2026-04-16T12:00:00Z",
      lastExit: null,
      lastError: null,
    });
  });

  it("skips events with missing data field", () => {
    const client = new EventClient();
    const handler = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    client.on("tab_created", handler);
    client.connect();

    mockEs.simulateEvent("tab_created", {
      type: "tab_created",
      // no data field
    });

    expect(handler).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("disconnect() closes EventSource", () => {
    const client = new EventClient();
    client.connect();
    client.disconnect();

    expect(mockEs.closeCalled).toBe(true);
  });

  it("disconnect() allows reconnect", () => {
    const client = new EventClient();
    client.connect();
    client.disconnect();
    client.connect("other");

    expect(constructorCalls).toHaveLength(2);
    expect(mockEs.url).toBe("/api/events?session_id=other");
  });
});
