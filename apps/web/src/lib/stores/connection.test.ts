import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandler, SseEventName } from "@/lib/events";
import {
  initializeConnectionStore,
  resetConnectionStoreForTests,
  retrySnapshot,
  useConnectionStore,
} from "./connection";

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();

class MockEventClient {
  private handlers = new Map<SseEventName, Set<EventHandler<unknown>>>();

  connect = mockConnect;
  disconnect = mockDisconnect;

  on<K extends SseEventName>(
    event: K,
    handler: EventHandler<unknown>,
  ): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  emit(event: SseEventName, data: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(data);
    }
  }
}

let mockEvents: MockEventClient;

vi.mock("@/lib/events", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/events")>("@/lib/events");
  return {
    ...actual,
    getEventClient: () => {
      if (!mockEvents) {
        mockEvents = new MockEventClient();
      }
      return mockEvents;
    },
  };
});

describe("connection store", () => {
  beforeEach(() => {
    mockConnect.mockClear();
    mockDisconnect.mockClear();
    initializeConnectionStore();
  });

  afterEach(() => {
    resetConnectionStoreForTests();
  });

  it("records snapshot_unavailable events", () => {
    expect(useConnectionStore.getState().snapshotError).toBeNull();

    mockEvents.emit("snapshot_unavailable", {
      scope: "chatConversations",
      message: "database is locked",
    });

    expect(useConnectionStore.getState().snapshotError).toEqual({
      scope: "chatConversations",
      message: "database is locked",
    });
  });

  it("clears the error when a snapshot arrives", () => {
    mockEvents.emit("snapshot_unavailable", {
      scope: "chatRuntimes",
      message: "boom",
    });
    expect(useConnectionStore.getState().snapshotError).not.toBeNull();

    mockEvents.emit("snapshot", { tabs: [] });

    expect(useConnectionStore.getState().snapshotError).toBeNull();
  });

  it("retrySnapshot reconnects the event stream", () => {
    retrySnapshot();

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });
});
