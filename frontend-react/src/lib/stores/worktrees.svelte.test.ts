// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandler, SseEventName } from "$lib/events";
import type { Worktree } from "$lib/types";

vi.mock("$lib/api", () => ({
  createProjectWorktree: vi.fn(),
  deleteProjectWorktree: vi.fn(),
  reorderProjectWorktrees: vi.fn(),
}));

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

vi.mock("$lib/events", async () => {
  const actual =
    await vi.importActual<typeof import("$lib/events")>("$lib/events");
  return {
    ...actual,
    getEventClient: () => {
      if (!mockEvents) mockEvents = new MockEventClient();
      return mockEvents;
    },
  };
});

function makeWorktree(
  overrides: Partial<Worktree> & { id: string; project_id: string },
): Worktree {
  return {
    id: overrides.id,
    project_id: overrides.project_id,
    name: overrides.name ?? "worktree",
    path: overrides.path ?? "/tmp/worktree",
    branch: overrides.branch ?? "main",
    is_local: overrides.is_local ?? false,
    missing_on_disk: overrides.missing_on_disk ?? false,
    position: overrides.position ?? 1,
  };
}

async function getStore() {
  const mod = await import("./worktrees");
  mod.resetWorktreeStoreForTests();
  mod.initializeWorktreeStore();
  return mod;
}

describe("Worktree store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    localStorage.clear();
    mockEvents = new MockEventClient();
  });

  it("preserves missing_on_disk from snapshot payload", async () => {
    const store = await getStore();
    mockEvents.emit("snapshot", {
      worktrees: {
        p1: [
          makeWorktree({
            id: "local",
            project_id: "p1",
            name: "local",
            is_local: true,
            branch: "local",
            position: 1,
          }),
          makeWorktree({
            id: "missing",
            project_id: "p1",
            name: "feature-a",
            missing_on_disk: true,
            position: 2,
          }),
        ],
      },
      project_errors: {},
    });

    const list = store.worktreesForProject("p1");
    expect(
      list.find((worktree) => worktree.id === "missing")?.missing_on_disk,
    ).toBe(true);
  });
});
