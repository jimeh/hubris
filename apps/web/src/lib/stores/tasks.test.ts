// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandler, SseEventName } from "@/lib/events";
import {
  initializeTaskStore,
  resetTaskStoreForTests,
  useTaskStore,
} from "./tasks";

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

const task = {
  id: "task-1",
  definitionName: "vscode.install-runtime",
  title: "Install VS Code Runtime",
  status: "running" as const,
  statusText: "Downloading runtime",
  progressPercent: 42,
  createdAt: "2025-01-01T00:00:00Z",
  startedAt: "2025-01-01T00:00:01Z",
  finishedAt: null,
  scopeKey: "vscode-runtime:vscodeCli",
  failureMessage: null,
  broadcastUpdates: true,
  steps: [],
};

describe("task store", () => {
  beforeEach(() => {
    mockEvents = new MockEventClient();
    resetTaskStoreForTests();
  });

  it("hydrates from snapshot events", () => {
    initializeTaskStore();

    mockEvents.emit("snapshot", {
      tasks: [task],
    });

    expect(useTaskStore.getState().tasksById["task-1"]?.title).toBe(
      "Install VS Code Runtime",
    );
  });

  it("applies task updates and removals", () => {
    initializeTaskStore();

    mockEvents.emit("task_updated", { task });
    expect(useTaskStore.getState().tasksById["task-1"]?.progressPercent).toBe(
      42,
    );

    mockEvents.emit("task_removed", { id: "task-1" });
    expect(useTaskStore.getState().tasksById["task-1"]).toBeUndefined();
  });
});
