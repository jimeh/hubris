// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandler, SseEventName } from "@/lib/events";
import type { VscodeStatus } from "@/lib/api";
import {
  initializeVscodeStore,
  resetVscodeStoreForTests,
  setVscodeStatus,
  useVscodeStore,
} from "./vscode";

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

function makeRuntimeStatus(
  overrides: Partial<VscodeStatus["codeServer"]> = {},
): VscodeStatus["codeServer"] {
  return {
    supported: true,
    installedVersion: null,
    processStatus: "stopped",
    latest: null,
    installProgress: null,
    message: null,
    activeTaskId: null,
    ...overrides,
  };
}

function makeStatus(overrides: Partial<VscodeStatus> = {}): VscodeStatus {
  return {
    selectedRuntime: "vscodeCli",
    codeServer: makeRuntimeStatus(),
    vscodeCli: makeRuntimeStatus(),
    ...overrides,
  };
}

describe("vscode store", () => {
  beforeEach(() => {
    mockEvents = new MockEventClient();
    resetVscodeStoreForTests();
  });

  it("hydrates status from snapshot events", () => {
    initializeVscodeStore();

    mockEvents.emit("snapshot", {
      vscode: makeStatus({
        vscodeCli: makeRuntimeStatus({
          installedVersion: "1.115.0",
          processStatus: "running",
        }),
      }),
    });

    expect(useVscodeStore.getState().status?.vscodeCli.installedVersion).toBe(
      "1.115.0",
    );
    expect(useVscodeStore.getState().status?.vscodeCli.processStatus).toBe(
      "running",
    );
  });

  it("applies incremental vscode_updated events", () => {
    initializeVscodeStore();

    mockEvents.emit(
      "vscode_updated",
      makeStatus({
        selectedRuntime: "codeServer",
        codeServer: makeRuntimeStatus({
          processStatus: "installing",
          installProgress: {
            phase: "downloading",
            percent: 42,
            downloadedBytes: 42,
            totalBytes: 100,
          },
        }),
      }),
    );

    expect(useVscodeStore.getState().status?.selectedRuntime).toBe(
      "codeServer",
    );
    expect(useVscodeStore.getState().status?.codeServer.processStatus).toBe(
      "installing",
    );
    expect(
      useVscodeStore.getState().status?.codeServer.installProgress?.percent,
    ).toBe(42);
  });

  it("supports direct test seeding", () => {
    setVscodeStatus(
      makeStatus({
        vscodeCli: makeRuntimeStatus({ installedVersion: "1.115.0" }),
      }),
    );

    expect(useVscodeStore.getState().status?.vscodeCli.installedVersion).toBe(
      "1.115.0",
    );
  });

  it("unsubscribes handlers during reset", () => {
    initializeVscodeStore();

    expect(mockEvents.handlerCount("snapshot")).toBe(1);
    expect(mockEvents.handlerCount("vscode_updated")).toBe(1);

    resetVscodeStoreForTests();

    expect(mockEvents.handlerCount("snapshot")).toBe(0);
    expect(mockEvents.handlerCount("vscode_updated")).toBe(0);
  });
});
