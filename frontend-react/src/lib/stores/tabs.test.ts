// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandler, SseEventName } from "@/lib/events";
import type { Tab } from "@/lib/types";

const mockCreateTab = vi.fn();
const mockDeleteTab = vi.fn();
const mockReorderTabs = vi.fn();

vi.mock("@/lib/api", () => ({
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
      if (!mockEvents) mockEvents = new MockEventClient();
      return mockEvents;
    },
  };
});

function makeTab(overrides: Partial<Tab> & { id: string }): Tab {
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
  const mod = await import("./tabs");
  mod.resetTabStoreForTests();
  mod.initializeTabStore();
  return mod;
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
    mockEvents.emit("snapshot", {
      tabs: [
        makeTab({ id: "a", position: 2 }),
        makeTab({ id: "b", position: 1 }),
      ],
    });

    expect(store.useTabStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("reorder() resequences locally and calls API", async () => {
    const store = await getStore();
    mockReorderTabs.mockResolvedValue(undefined);

    mockEvents.emit("snapshot", {
      tabs: [
        makeTab({ id: "a", position: 1, worktree_id: "w1" }),
        makeTab({ id: "b", position: 2, worktree_id: "w1" }),
        makeTab({ id: "c", position: 3, worktree_id: "w1" }),
      ],
    });

    await store.useTabStore.getState().reorder("w1", ["c", "a", "b"]);

    expect(mockReorderTabs).toHaveBeenCalledWith("w1", ["c", "a", "b"]);
    expect(store.tabsForWorktree("w1").map((tab) => tab.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("tabs_reordered SSE event updates state", async () => {
    const store = await getStore();

    mockEvents.emit("snapshot", {
      tabs: [
        makeTab({ id: "a", position: 1, worktree_id: "w1" }),
        makeTab({ id: "b", position: 2, worktree_id: "w1" }),
        makeTab({ id: "c", position: 3, worktree_id: "w1" }),
      ],
    });

    mockEvents.emit("tabs_reordered", {
      worktree_id: "w1",
      tabs: [
        makeTab({ id: "c", position: 1, worktree_id: "w1" }),
        makeTab({ id: "a", position: 2, worktree_id: "w1" }),
        makeTab({ id: "b", position: 3, worktree_id: "w1" }),
      ],
    });

    expect(store.tabsForWorktree("w1").map((tab) => tab.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("tabs_reordered does not affect other worktrees", async () => {
    const store = await getStore();

    mockEvents.emit("snapshot", {
      tabs: [
        makeTab({ id: "a", position: 1, worktree_id: "w1" }),
        makeTab({ id: "b", position: 2, worktree_id: "w1" }),
        makeTab({ id: "x", position: 1, worktree_id: "w2" }),
      ],
    });

    mockEvents.emit("tabs_reordered", {
      worktree_id: "w1",
      tabs: [
        makeTab({ id: "b", position: 1, worktree_id: "w1" }),
        makeTab({ id: "a", position: 2, worktree_id: "w1" }),
      ],
    });

    expect(store.tabsForWorktree("w1").map((tab) => tab.id)).toEqual([
      "b",
      "a",
    ]);
    expect(store.tabsForWorktree("w2").map((tab) => tab.id)).toEqual(["x"]);
  });

  it("snapshot prunes stale active-tab persistence", async () => {
    localStorage.setItem("hubris-active-tab", "gone");
    localStorage.setItem(
      "hubris-active-tab-by-worktree",
      JSON.stringify({ w1: "a", w2: "gone" }),
    );

    const store = await getStore();

    mockEvents.emit("snapshot", {
      tabs: [makeTab({ id: "a", worktree_id: "w1", position: 1 })],
    });

    expect(store.useTabStore.getState().activeTabId).toBeNull();
    expect(store.useTabStore.getState().activeTabByWorktree).toEqual({
      w1: "a",
    });
    expect(localStorage.getItem("hubris-active-tab")).toBeNull();
    expect(localStorage.getItem("hubris-active-tab-by-worktree")).toBe(
      JSON.stringify({ w1: "a" }),
    );
  });

  it("resetTabStoreForTests unsubscribes SSE handlers", async () => {
    const store = await import("./tabs");
    store.resetTabStoreForTests();
    store.initializeTabStore();

    expect(mockEvents.handlerCount("snapshot")).toBe(1);

    store.resetTabStoreForTests();

    expect(mockEvents.handlerCount("snapshot")).toBe(0);
  });
});
