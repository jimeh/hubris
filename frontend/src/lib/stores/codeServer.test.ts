// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandler, SseEventName } from "@/lib/events";
import type { CodeServerStatus } from "@/lib/api";
import {
  initializeCodeServerStore,
  resetCodeServerStoreForTests,
  useCodeServerStore,
} from "./codeServer";

class MockEventClient {
  private handlers = new Map<SseEventName, Set<EventHandler<unknown>>>();

  on<K extends SseEventName>(
    event: K,
    handler: EventHandler<unknown>,
  ): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler<unknown>);
    return () =>
      this.handlers.get(event)?.delete(handler as EventHandler<unknown>);
  }

  emit(event: SseEventName, data: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(data);
    }
  }

  handlerCount(event: SseEventName): number {
    return this.handlers.get(event)?.size ?? 0;
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

function makeStatus(
  overrides: Partial<CodeServerStatus> = {},
): CodeServerStatus {
  return {
    supported: true,
    installedVersion: null,
    processStatus: "stopped" as const,
    latest: null,
    installProgress: null,
    message: null,
    ...overrides,
  };
}

describe("codeServer store", () => {
  beforeEach(() => {
    mockEvents = new MockEventClient();
    resetCodeServerStoreForTests();
  });

  it("hydrates status from snapshot events", () => {
    initializeCodeServerStore();

    mockEvents.emit("snapshot", {
      code_server: makeStatus({
        installedVersion: "4.114.1",
        processStatus: "running",
      }),
    });

    expect(useCodeServerStore.getState().status?.installedVersion).toBe(
      "4.114.1",
    );
    expect(useCodeServerStore.getState().status?.processStatus).toBe("running");
  });

  it("applies incremental code_server_updated events", () => {
    initializeCodeServerStore();

    mockEvents.emit(
      "code_server_updated",
      makeStatus({
        processStatus: "installing",
        installProgress: {
          phase: "downloading",
          percent: 42,
          downloadedBytes: 42,
          totalBytes: 100,
        },
      }),
    );

    expect(useCodeServerStore.getState().status?.processStatus).toBe(
      "installing",
    );
    expect(useCodeServerStore.getState().status?.installProgress?.percent).toBe(
      42,
    );
  });

  it("unsubscribes handlers during reset", () => {
    initializeCodeServerStore();

    expect(mockEvents.handlerCount("snapshot")).toBe(1);
    expect(mockEvents.handlerCount("code_server_updated")).toBe(1);

    resetCodeServerStoreForTests();

    expect(mockEvents.handlerCount("snapshot")).toBe(0);
    expect(mockEvents.handlerCount("code_server_updated")).toBe(0);
  });
});
