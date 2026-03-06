// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandler, SseEventName } from "$lib/events";
import type { Tab } from "$lib/types";

const mockCreateTab = vi.fn();
const mockDeleteTab = vi.fn();
const mockReorderTabs = vi.fn();

vi.mock("$lib/api", () => ({
  createTab: (...args: unknown[]) => mockCreateTab(...args),
  deleteTab: (...args: unknown[]) => mockDeleteTab(...args),
  reorderTabs: (...args: unknown[]) => mockReorderTabs(...args),
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

function makeTab(
  overrides: Partial<Tab> & { id: string },
): Tab {
  return {
    id: overrides.id,
    label: overrides.label ?? `Terminal ${overrides.id}`,
    position: overrides.position ?? 1,
    worktree_id: overrides.worktree_id ?? "w1",
    session_id: overrides.session_id ?? "default",
    type: overrides.type ?? "terminal",
    created_at: overrides.created_at ?? 0,
  };
}

async function getStore() {
  const mod = await import("./tabs.svelte");
  return mod.getTabStore();
}

describe("Tab store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    localStorage.clear();
    mockEvents = new MockEventClient();
  });

  it("loads tabs from snapshot sorted by position", async () => {
    const store = await getStore();
    const t1 = makeTab({ id: "a", position: 2 });
    const t2 = makeTab({ id: "b", position: 1 });

    mockEvents.emit("snapshot", { tabs: [t1, t2] });

    expect(store.tabs.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("reorder() resequences locally and calls API", async () => {
    const store = await getStore();
    mockReorderTabs.mockResolvedValue(undefined);

    const t1 = makeTab({ id: "a", position: 1, worktree_id: "w1" });
    const t2 = makeTab({ id: "b", position: 2, worktree_id: "w1" });
    const t3 = makeTab({ id: "c", position: 3, worktree_id: "w1" });
    mockEvents.emit("snapshot", { tabs: [t1, t2, t3] });

    await store.reorder("w1", ["c", "a", "b"]);

    expect(mockReorderTabs).toHaveBeenCalledWith("w1", ["c", "a", "b"]);
    const worktreeTabs = store.tabsForWorktree("w1");
    expect(worktreeTabs.map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("tabs_reordered SSE event updates state", async () => {
    const store = await getStore();

    const t1 = makeTab({ id: "a", position: 1, worktree_id: "w1" });
    const t2 = makeTab({ id: "b", position: 2, worktree_id: "w1" });
    const t3 = makeTab({ id: "c", position: 3, worktree_id: "w1" });
    mockEvents.emit("snapshot", { tabs: [t1, t2, t3] });

    // Server says new order is c, a, b
    mockEvents.emit("tabs_reordered", {
      worktree_id: "w1",
      tabs: [
        makeTab({ id: "c", position: 1, worktree_id: "w1" }),
        makeTab({ id: "a", position: 2, worktree_id: "w1" }),
        makeTab({ id: "b", position: 3, worktree_id: "w1" }),
      ],
    });

    const worktreeTabs = store.tabsForWorktree("w1");
    expect(worktreeTabs.map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("tabs_reordered does not affect other worktrees", async () => {
    const store = await getStore();

    const t1 = makeTab({ id: "a", position: 1, worktree_id: "w1" });
    const t2 = makeTab({ id: "b", position: 2, worktree_id: "w1" });
    const t3 = makeTab({ id: "x", position: 1, worktree_id: "w2" });
    mockEvents.emit("snapshot", { tabs: [t1, t2, t3] });

    mockEvents.emit("tabs_reordered", {
      worktree_id: "w1",
      tabs: [
        makeTab({ id: "b", position: 1, worktree_id: "w1" }),
        makeTab({ id: "a", position: 2, worktree_id: "w1" }),
      ],
    });

    // w1 reordered
    expect(store.tabsForWorktree("w1").map((t) => t.id)).toEqual([
      "b",
      "a",
    ]);
    // w2 untouched
    expect(store.tabsForWorktree("w2").map((t) => t.id)).toEqual(["x"]);
  });
});
