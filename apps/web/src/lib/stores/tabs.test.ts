// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandler, SseEventName } from "@/lib/events";
import type {
  AgentChatTab,
  BrowserTab,
  FileTab,
  GitDiffTab,
  TerminalTab,
} from "@/lib/types";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import {
  initializeTabStore,
  resetTabStoreForTests,
  tabsForWorktree,
  useTabStore,
} from "./tabs";

const mockCreateTab = vi.fn();
const mockCreateTerminalTab = vi.fn();
const mockDeleteTab = vi.fn();
const mockReorderTabs = vi.fn();
const mockUpdateTab = vi.fn();
const mockUpdateWorktreeTabLayout = vi.fn();
const mockUpdateWorktreeRestoreState = vi.fn();
const mockScheduleDisposeTabModels = vi.fn();
const mockDesktopBrowserDestroy = vi.fn();

vi.mock("@/lib/api", () => ({
  createTab: (...args: unknown[]) => mockCreateTab(...args),
  createTerminalTab: (...args: unknown[]) => mockCreateTerminalTab(...args),
  deleteTab: (...args: unknown[]) => mockDeleteTab(...args),
  reorderTabs: (...args: unknown[]) => mockReorderTabs(...args),
  updateTab: (...args: unknown[]) => mockUpdateTab(...args),
  updateWorktreeTabLayout: (...args: unknown[]) =>
    mockUpdateWorktreeTabLayout(...args),
  updateWorktreeRestoreState: (...args: unknown[]) =>
    mockUpdateWorktreeRestoreState(...args),
}));

vi.mock("@/lib/monacoLazy", () => ({
  scheduleDisposeTabModels: (...args: unknown[]) =>
    mockScheduleDisposeTabModels(...args),
}));

vi.mock("@/lib/desktopBrowser", () => ({
  desktopBrowserBridge: () => ({
    destroy: (...args: unknown[]) => mockDesktopBrowserDestroy(...args),
  }),
  hasDesktopBrowserBridge: () => true,
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

function makeTab(
  overrides: Partial<TerminalTab> & { id: string },
): TerminalTab {
  return {
    id: overrides.id,
    label: overrides.label ?? `Terminal ${overrides.id}`,
    position: overrides.position ?? 1,
    worktree_id: overrides.worktree_id ?? "w1",
    pane_id: overrides.pane_id ?? "pane-1",
    session_id: overrides.session_id ?? "default",
    type: overrides.type ?? "terminal",
    created_at: overrides.created_at ?? 0,
    preview: overrides.preview ?? false,
  };
}

function makeFileTab(
  overrides: Partial<FileTab> & { id: string; path: string },
): FileTab {
  return {
    id: overrides.id,
    label:
      overrides.label ??
      overrides.path.split("/").filter(Boolean).at(-1) ??
      overrides.path,
    position: overrides.position ?? 1,
    worktree_id: overrides.worktree_id ?? "w1",
    pane_id: overrides.pane_id ?? "pane-1",
    session_id: overrides.session_id ?? "default",
    type: "file",
    created_at: overrides.created_at ?? 0,
    preview: overrides.preview ?? true,
    path: overrides.path,
  };
}

function makeGitDiffTab(
  overrides: Partial<GitDiffTab> & { id: string; path: string },
): GitDiffTab {
  return {
    id: overrides.id,
    label:
      overrides.label ??
      overrides.path.split("/").filter(Boolean).at(-1) ??
      overrides.path,
    position: overrides.position ?? 1,
    worktree_id: overrides.worktree_id ?? "w1",
    pane_id: overrides.pane_id ?? "pane-1",
    session_id: overrides.session_id ?? "default",
    type: "git_diff",
    created_at: overrides.created_at ?? 0,
    preview: overrides.preview ?? true,
    path: overrides.path,
    scope: overrides.scope ?? "unstaged",
    original_path: overrides.original_path ?? null,
    commit_id: overrides.commit_id ?? null,
  };
}

function makeBrowserTab(
  overrides: Partial<BrowserTab> & { id: string; url: string },
): BrowserTab {
  return {
    id: overrides.id,
    label: overrides.label ?? "localhost",
    position: overrides.position ?? 1,
    worktree_id: overrides.worktree_id ?? "w1",
    pane_id: overrides.pane_id ?? "pane-1",
    session_id: overrides.session_id ?? "default",
    type: "browser",
    created_at: overrides.created_at ?? 0,
    preview: overrides.preview ?? false,
    url: overrides.url,
    history: overrides.history ?? [overrides.url],
    history_index: overrides.history_index ?? 0,
  };
}

function makeAgentChatTab(
  overrides: Partial<AgentChatTab> & { id: string; conversation_id: string },
): AgentChatTab {
  return {
    id: overrides.id,
    label: overrides.label ?? "New Chat",
    position: overrides.position ?? 1,
    worktree_id: overrides.worktree_id ?? "w1",
    pane_id: overrides.pane_id ?? "pane-1",
    session_id: overrides.session_id ?? "default",
    type: "agent_chat",
    created_at: overrides.created_at ?? 0,
    preview: overrides.preview ?? false,
    conversation_id: overrides.conversation_id,
  };
}

function getStore() {
  resetTabStoreForTests();
  initializeTabStore();
  return {
    initializeTabStore,
    resetTabStoreForTests,
    tabsForWorktree,
    useTabStore,
  };
}

describe("Tab store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    mockEvents = new MockEventClient();
    useWorktreeStore.setState({
      worktreesByProject: {},
      projectErrors: {},
      selectedWorktreeId: null,
    });
    mockCreateTab.mockReset();
    mockCreateTerminalTab.mockReset();
    mockDeleteTab.mockReset();
    mockReorderTabs.mockReset();
    mockScheduleDisposeTabModels.mockReset();
    mockUpdateTab.mockReset();
    mockUpdateWorktreeTabLayout.mockReset();
    mockUpdateWorktreeRestoreState.mockReset();
    mockUpdateWorktreeRestoreState.mockResolvedValue(undefined);
    mockDesktopBrowserDestroy.mockReset();
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

    await store.useTabStore.getState().reorder("w1", "pane-1", ["c", "a", "b"]);

    expect(mockReorderTabs).toHaveBeenCalledWith("w1", "pane-1", [
      "c",
      "a",
      "b",
    ]);
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
      session_id: "default",
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
      session_id: "default",
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

  it("persists updated split ratios through the layout API", async () => {
    const store = await getStore();
    mockUpdateWorktreeTabLayout.mockResolvedValue({
      layout: {
        rootId: "split-root",
        nodes: [
          { type: "leaf", id: "leaf-a", pane_id: "pane-1" },
          { type: "leaf", id: "leaf-b", pane_id: "pane-2" },
          {
            type: "split",
            id: "split-root",
            axis: "vertical",
            ratio: 0.7,
            first_id: "leaf-a",
            second_id: "leaf-b",
          },
        ],
      },
      tabs: [
        makeTab({ id: "a", worktree_id: "w1", pane_id: "pane-1" }),
        makeTab({ id: "b", worktree_id: "w1", pane_id: "pane-2" }),
      ],
    });

    mockEvents.emit("snapshot", {
      tabs: [
        makeTab({ id: "a", worktree_id: "w1", pane_id: "pane-1" }),
        makeTab({ id: "b", worktree_id: "w1", pane_id: "pane-2" }),
      ],
      tab_layouts: {
        w1: {
          rootId: "split-root",
          nodes: [
            { type: "leaf", id: "leaf-a", pane_id: "pane-1" },
            { type: "leaf", id: "leaf-b", pane_id: "pane-2" },
            {
              type: "split",
              id: "split-root",
              axis: "vertical",
              ratio: 0.5,
              first_id: "leaf-a",
              second_id: "leaf-b",
            },
          ],
        },
      },
    });

    expect(
      store.useTabStore.getState().setSplitRatio("w1", "split-root", 0.7),
    ).toBe(true);
    await store.useTabStore.getState().persistLayout("p1", "w1");

    expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledWith("p1", "w1", {
      rootId: "split-root",
      nodes: [
        { type: "leaf", id: "leaf-a", pane_id: "pane-1" },
        { type: "leaf", id: "leaf-b", pane_id: "pane-2" },
        {
          type: "split",
          id: "split-root",
          axis: "vertical",
          ratio: 0.7,
          first_id: "leaf-a",
          second_id: "leaf-b",
        },
      ],
      panes: [
        { paneId: "pane-1", tabIds: ["a"] },
        { paneId: "pane-2", tabIds: ["b"] },
      ],
    });
  });

  it("splitPane creates the destination pane before creating the new tab", async () => {
    const store = await getStore();
    let nextId = 0;
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
      () => `00000000-0000-4000-8000-00000000000${nextId++}`,
    );
    mockUpdateWorktreeTabLayout.mockResolvedValue({
      layout: {
        rootId: "split-root",
        nodes: [
          { type: "leaf", id: "leaf-a", pane_id: "pane-1" },
          {
            type: "leaf",
            id: "leaf-b",
            pane_id: "00000000-0000-4000-8000-000000000000",
          },
          {
            type: "split",
            id: "split-root",
            axis: "vertical",
            ratio: 0.5,
            first_id: "leaf-a",
            second_id: "leaf-b",
          },
        ],
      },
      tabs: [makeTab({ id: "a", worktree_id: "w1", pane_id: "pane-1" })],
    });
    mockCreateTerminalTab.mockResolvedValue(
      makeTab({
        id: "b",
        worktree_id: "w1",
        pane_id: "00000000-0000-4000-8000-000000000000",
      }),
    );

    mockEvents.emit("snapshot", {
      tabs: [makeTab({ id: "a", worktree_id: "w1", pane_id: "pane-1" })],
      tab_layouts: {
        w1: {
          rootId: "leaf-a",
          nodes: [{ type: "leaf", id: "leaf-a", pane_id: "pane-1" }],
        },
      },
    });

    await store.useTabStore.getState().splitPane("p1", "w1", "pane-1", "right");

    const layoutRequest = mockUpdateWorktreeTabLayout.mock.calls[0]?.[2];
    expect(layoutRequest).toEqual({
      rootId: expect.any(String),
      nodes: expect.arrayContaining([
        expect.objectContaining({ type: "leaf", pane_id: "pane-1" }),
        expect.objectContaining({ type: "leaf" }),
        expect.objectContaining({ type: "split", axis: "vertical" }),
      ]),
      panes: expect.arrayContaining([
        { paneId: "pane-1", tabIds: ["a"] },
        expect.objectContaining({ tabIds: [] }),
      ]),
    });
    const destinationPaneId = layoutRequest.panes.find(
      (pane: { paneId: string; tabIds: string[] }) => pane.tabIds.length === 0,
    )?.paneId;
    expect(destinationPaneId).toBeTruthy();
    expect(mockCreateTerminalTab).toHaveBeenCalledWith("w1", destinationPaneId);
    expect(
      mockUpdateWorktreeTabLayout.mock.invocationCallOrder[0],
    ).toBeLessThan(mockCreateTerminalTab.mock.invocationCallOrder[0]);
  });

  it("splitPane rolls back the layout if creating the new terminal fails", async () => {
    const store = await getStore();
    let nextId = 0;
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
      () => `00000000-0000-4000-8000-00000000000${nextId++}`,
    );
    mockUpdateWorktreeTabLayout
      .mockResolvedValueOnce({
        layout: {
          rootId: "split-root",
          nodes: [
            { type: "leaf", id: "leaf-a", pane_id: "pane-1" },
            {
              type: "leaf",
              id: "leaf-b",
              pane_id: "00000000-0000-4000-8000-000000000000",
            },
            {
              type: "split",
              id: "split-root",
              axis: "vertical",
              ratio: 0.5,
              first_id: "leaf-a",
              second_id: "leaf-b",
            },
          ],
        },
        tabs: [makeTab({ id: "a", worktree_id: "w1", pane_id: "pane-1" })],
      })
      .mockResolvedValueOnce({
        layout: {
          rootId: "leaf-a",
          nodes: [{ type: "leaf", id: "leaf-a", pane_id: "pane-1" }],
        },
        tabs: [makeTab({ id: "a", worktree_id: "w1", pane_id: "pane-1" })],
      });
    mockCreateTerminalTab.mockRejectedValue(new Error("boom"));

    mockEvents.emit("snapshot", {
      tabs: [makeTab({ id: "a", worktree_id: "w1", pane_id: "pane-1" })],
      tab_layouts: {
        w1: {
          rootId: "leaf-a",
          nodes: [{ type: "leaf", id: "leaf-a", pane_id: "pane-1" }],
        },
      },
    });

    await expect(
      store.useTabStore.getState().splitPane("p1", "w1", "pane-1", "right"),
    ).rejects.toThrow("boom");

    expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(2);
    expect(mockUpdateWorktreeTabLayout.mock.calls[1]?.[2]).toEqual({
      rootId: "leaf-a",
      nodes: [{ type: "leaf", id: "leaf-a", pane_id: "pane-1" }],
      panes: [{ paneId: "pane-1", tabIds: ["a"] }],
    });
    expect(store.useTabStore.getState().layoutsByWorktree.w1).toEqual({
      rootId: "leaf-a",
      nodes: [{ type: "leaf", id: "leaf-a", pane_id: "pane-1" }],
    });
  });

  it("closing the focused pane falls back to the previously focused pane", async () => {
    const store = await getStore();
    mockDeleteTab.mockResolvedValue(undefined);

    mockEvents.emit("snapshot", {
      tabs: [
        makeTab({ id: "a", worktree_id: "w1", pane_id: "pane-1" }),
        makeTab({ id: "b", worktree_id: "w1", pane_id: "pane-2" }),
        makeTab({ id: "c", worktree_id: "w1", pane_id: "pane-3" }),
      ],
      tab_layouts: {
        w1: {
          rootId: "split-root",
          nodes: [
            { type: "leaf", id: "leaf-a", pane_id: "pane-1" },
            { type: "leaf", id: "leaf-b", pane_id: "pane-2" },
            { type: "leaf", id: "leaf-c", pane_id: "pane-3" },
            {
              type: "split",
              id: "split-right",
              axis: "horizontal",
              ratio: 0.5,
              first_id: "leaf-b",
              second_id: "leaf-c",
            },
            {
              type: "split",
              id: "split-root",
              axis: "vertical",
              ratio: 0.5,
              first_id: "leaf-a",
              second_id: "split-right",
            },
          ],
        },
      },
    });

    store.useTabStore.getState().focusPane("w1", "pane-3");
    store.useTabStore.getState().focusPane("w1", "pane-2");

    await store.useTabStore.getState().close("b");

    expect(store.useTabStore.getState().focusedPaneByWorktree.w1).toBe(
      "pane-3",
    );
    expect(store.useTabStore.getState().activeTabId).toBe("c");
    expect(
      store.useTabStore.getState().focusedPaneHistoryByWorktree.w1,
    ).toEqual(["pane-3", "pane-1"]);
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

  it("closing the active tab in a pane picks the next pane-local MRU tab", async () => {
    const store = await getStore();
    mockDeleteTab.mockResolvedValue(undefined);

    mockEvents.emit("snapshot", {
      tabs: [
        makeTab({ id: "a", worktree_id: "w1", pane_id: "pane-1", position: 1 }),
        makeTab({ id: "b", worktree_id: "w1", pane_id: "pane-1", position: 2 }),
        makeTab({ id: "c", worktree_id: "w1", pane_id: "pane-1", position: 3 }),
      ],
    });

    store.useTabStore.getState().activate("b");
    store.useTabStore.getState().activate("a");

    await store.useTabStore.getState().close("a");

    expect(store.useTabStore.getState().activeTabId).toBe("b");
    expect(store.useTabStore.getState().activeTabByPane["pane-1"]).toBe("b");
  });

  it("closing a non-active tab leaves the current pane selection alone", async () => {
    const store = await getStore();
    mockDeleteTab.mockResolvedValue(undefined);

    mockEvents.emit("snapshot", {
      tabs: [
        makeTab({ id: "a", worktree_id: "w1", pane_id: "pane-1", position: 1 }),
        makeTab({ id: "b", worktree_id: "w1", pane_id: "pane-1", position: 2 }),
        makeTab({ id: "c", worktree_id: "w1", pane_id: "pane-1", position: 3 }),
      ],
    });

    store.useTabStore.getState().activate("b");
    await store.useTabStore.getState().close("c");

    expect(store.useTabStore.getState().activeTabId).toBe("b");
    expect(store.useTabStore.getState().activeTabByPane["pane-1"]).toBe("b");
  });

  it("snapshot hydrate prefers backend pane and tab MRU over stale local fallback", async () => {
    localStorage.setItem(
      "hubris-pane-mru-by-worktree",
      JSON.stringify({ w1: ["pane-2", "pane-1"] }),
    );
    localStorage.setItem(
      "hubris-tab-mru-by-pane",
      JSON.stringify({ "pane-1": ["c", "a"] }),
    );
    useWorktreeStore.setState({ selectedWorktreeId: "w1" });

    const store = await getStore();

    mockEvents.emit("snapshot", {
      tabs: [
        makeTab({ id: "a", worktree_id: "w1", pane_id: "pane-1", position: 1 }),
        makeTab({ id: "b", worktree_id: "w1", pane_id: "pane-1", position: 2 }),
        makeTab({ id: "c", worktree_id: "w1", pane_id: "pane-2", position: 1 }),
      ],
      tab_layouts: {
        w1: {
          rootId: "split-root",
          nodes: [
            { type: "leaf", id: "leaf-1", pane_id: "pane-1" },
            { type: "leaf", id: "leaf-2", pane_id: "pane-2" },
            {
              type: "split",
              id: "split-root",
              axis: "vertical",
              ratio: 0.5,
              first_id: "leaf-1",
              second_id: "leaf-2",
            },
          ],
        },
      },
      worktree_restore_state: {
        w1: {
          focusedPaneId: "pane-1",
          paneMru: ["pane-1", "pane-2"],
          tabMruByPane: { "pane-1": ["b", "a"] },
        },
      },
    });

    expect(
      store.useTabStore.getState().focusedPaneHistoryByWorktree.w1,
    ).toEqual(["pane-1", "pane-2"]);
    expect(store.useTabStore.getState().tabMruByPane["pane-1"]).toEqual([
      "b",
      "a",
    ]);
    expect(store.useTabStore.getState().activeTabByPane["pane-1"]).toBe("b");
  });

  it("resetTabStoreForTests unsubscribes SSE handlers", () => {
    resetTabStoreForTests();
    initializeTabStore();

    expect(mockEvents.handlerCount("snapshot")).toBe(1);

    resetTabStoreForTests();

    expect(mockEvents.handlerCount("snapshot")).toBe(0);
  });

  it("persists restore state when selection changes outside explicit action hooks", async () => {
    vi.useFakeTimers();
    try {
      useWorktreeStore.setState({
        worktreesByProject: {
          p1: [
            {
              id: "w1",
              project_id: "p1",
              name: "local",
              branch: "main",
              path: "/repo",
              source_ref: null,
              ui_mode: "hubris",
              is_local: true,
              position: 1,
            },
          ],
        },
        projectErrors: {},
        selectedWorktreeId: "w1",
      });
      const store = await getStore();

      mockEvents.emit("snapshot", {
        tabs: [
          makeTab({
            id: "a",
            worktree_id: "w1",
            pane_id: "pane-1",
            position: 1,
          }),
          makeTab({
            id: "b",
            worktree_id: "w1",
            pane_id: "pane-1",
            position: 2,
          }),
        ],
        tab_layouts: {
          w1: {
            rootId: "root",
            nodes: [{ type: "leaf", id: "root", pane_id: "pane-1" }],
          },
        },
        worktree_restore_state: {
          w1: {
            activeTabId: "b",
            focusedPaneId: "pane-1",
            paneMru: ["pane-1"],
            tabMruByPane: { "pane-1": ["b", "a"] },
          },
        },
      });

      store.useTabStore.getState().removeLocal("b");
      await vi.advanceTimersByTimeAsync(250);

      expect(mockUpdateWorktreeRestoreState).toHaveBeenCalledWith("p1", "w1", {
        activeTabId: "a",
        focusedPaneId: "pane-1",
        paneMru: ["pane-1"],
        tabMruByPane: { "pane-1": ["a"] },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("openFile dedupes a raced tab_created event", async () => {
    const store = await getStore();
    const tab = makeFileTab({
      id: "file-1",
      worktree_id: "w1",
      path: "src/main.ts",
      preview: true,
    });
    mockCreateTab.mockImplementation(async () => {
      mockEvents.emit("tab_created", {
        session_id: "default",
        tab,
      });
      return tab;
    });

    await store.useTabStore.getState().openFile({
      worktreeId: "w1",
      path: "src/main.ts",
      preview: true,
    });

    expect(
      store.tabsForWorktree("w1").map((candidate) => candidate.id),
    ).toEqual(["file-1"]);
  });

  it("preview replacement disposes Monaco models before removing the old tab", async () => {
    const store = await getStore();
    const previewTab = makeFileTab({
      id: "preview-1",
      worktree_id: "w1",
      path: "src/old.ts",
      preview: true,
    });
    const nextTab = makeFileTab({
      id: "preview-2",
      worktree_id: "w1",
      path: "src/new.ts",
      preview: true,
      position: 2,
    });
    mockCreateTab.mockResolvedValue(nextTab);
    mockDeleteTab.mockResolvedValue(undefined);

    mockEvents.emit("snapshot", {
      tabs: [previewTab],
    });

    await store.useTabStore.getState().openFile({
      worktreeId: "w1",
      path: "src/new.ts",
      preview: true,
    });

    expect(mockScheduleDisposeTabModels).toHaveBeenCalledWith(previewTab);
    expect(mockDeleteTab).toHaveBeenCalledWith(previewTab.id);
    expect(store.tabsForWorktree("w1").map((tab) => tab.id)).toEqual([
      nextTab.id,
    ]);
  });

  it("openGitDiff dedupes commit diff tabs by commit_id", async () => {
    const store = await getStore();
    const existing = makeGitDiffTab({
      id: "diff-1",
      worktree_id: "w1",
      path: "src/main.ts",
      scope: "commit",
      commit_id: "abcdef123456",
      preview: false,
    });

    mockEvents.emit("snapshot", {
      tabs: [existing],
    });

    const tab = await store.useTabStore.getState().openGitDiff({
      worktreeId: "w1",
      path: "src/main.ts",
      scope: "commit",
      commitId: "abcdef123456",
      preview: true,
    });

    expect(mockCreateTab).not.toHaveBeenCalled();
    expect(tab.id).toBe(existing.id);
  });

  it("openGitDiff keeps same-path commit diffs distinct across commits", async () => {
    const store = await getStore();
    const created = makeGitDiffTab({
      id: "diff-2",
      worktree_id: "w1",
      path: "src/main.ts",
      scope: "commit",
      commit_id: "fedcba654321",
      preview: false,
      position: 2,
    });
    mockCreateTab.mockResolvedValue(created);

    mockEvents.emit("snapshot", {
      tabs: [
        makeGitDiffTab({
          id: "diff-1",
          worktree_id: "w1",
          path: "src/main.ts",
          scope: "commit",
          commit_id: "abcdef123456",
          preview: false,
        }),
      ],
    });

    const tab = await store.useTabStore.getState().openGitDiff({
      worktreeId: "w1",
      path: "src/main.ts",
      scope: "commit",
      commitId: "fedcba654321",
      preview: false,
    });

    expect(mockCreateTab).toHaveBeenCalledWith({
      type: "git_diff",
      worktree_id: "w1",
      pane_id: "pane-1",
      path: "src/main.ts",
      scope: "commit",
      original_path: undefined,
      commit_id: "fedcba654321",
      preview: false,
    });
    expect(tab.id).toBe("diff-2");
    expect(
      store.tabsForWorktree("w1").map((candidate) => candidate.id),
    ).toEqual(["diff-1", "diff-2"]);
  });

  it("openGitDiff dedupes concurrent creates for the same diff", async () => {
    const store = await getStore();
    let resolveCreate!: (tab: GitDiffTab) => void;
    mockCreateTab.mockImplementation(
      () =>
        new Promise<GitDiffTab>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const firstPromise = store.useTabStore.getState().openGitDiff({
      worktreeId: "w1",
      path: "src/main.ts",
      scope: "commit",
      commitId: "abcdef123456",
      preview: true,
    });
    const secondPromise = store.useTabStore.getState().openGitDiff({
      worktreeId: "w1",
      path: "src/main.ts",
      scope: "commit",
      commitId: "abcdef123456",
      preview: true,
    });

    await vi.waitFor(() => {
      expect(mockCreateTab).toHaveBeenCalledTimes(1);
    });

    resolveCreate(
      makeGitDiffTab({
        id: "diff-3",
        worktree_id: "w1",
        path: "src/main.ts",
        scope: "commit",
        commit_id: "abcdef123456",
        preview: true,
      }),
    );

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.id).toBe("diff-3");
    expect(second.id).toBe("diff-3");
    expect(
      store.tabsForWorktree("w1").map((candidate) => candidate.id),
    ).toEqual(["diff-3"]);
  });

  it("openAgentChat dedupes concurrent new chat creates", async () => {
    const store = await getStore();
    let resolveCreate!: (tab: AgentChatTab) => void;
    mockCreateTab.mockImplementation(
      () =>
        new Promise<AgentChatTab>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const firstPromise = store.useTabStore
      .getState()
      .openAgentChat({ worktreeId: "w1" });
    const secondPromise = store.useTabStore
      .getState()
      .openAgentChat({ worktreeId: "w1" });

    await vi.waitFor(() => {
      expect(mockCreateTab).toHaveBeenCalledTimes(1);
    });

    resolveCreate(
      makeAgentChatTab({
        id: "chat-tab-1",
        worktree_id: "w1",
        conversation_id: "chat-1",
      }),
    );

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.id).toBe("chat-tab-1");
    expect(second.id).toBe("chat-tab-1");
    expect(
      store.tabsForWorktree("w1").map((candidate) => candidate.id),
    ).toEqual(["chat-tab-1"]);
  });

  it("openAgentChat dedupes concurrent existing chat opens across panes", async () => {
    const store = await getStore();
    let resolveCreate!: (tab: AgentChatTab) => void;
    mockCreateTab.mockImplementation(
      () =>
        new Promise<AgentChatTab>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const firstPromise = store.useTabStore.getState().openAgentChat({
      conversationId: "chat-1",
      paneId: "pane-1",
      worktreeId: "w1",
    });
    const secondPromise = store.useTabStore.getState().openAgentChat({
      conversationId: "chat-1",
      paneId: "pane-2",
      worktreeId: "w1",
    });

    await vi.waitFor(() => {
      expect(mockCreateTab).toHaveBeenCalledTimes(1);
    });

    resolveCreate(
      makeAgentChatTab({
        id: "chat-tab-1",
        pane_id: "pane-1",
        worktree_id: "w1",
        conversation_id: "chat-1",
      }),
    );

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.id).toBe("chat-tab-1");
    expect(second.id).toBe("chat-tab-1");
  });

  it("openGitDiff upgrades an in-flight preview create to pinned", async () => {
    const store = await getStore();
    let resolveCreate!: (tab: GitDiffTab) => void;
    mockCreateTab.mockImplementation(
      () =>
        new Promise<GitDiffTab>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    mockUpdateTab.mockResolvedValue(
      makeGitDiffTab({
        id: "diff-4",
        worktree_id: "w1",
        path: "src/main.ts",
        scope: "commit",
        commit_id: "abcdef123456",
        preview: false,
      }),
    );

    const previewPromise = store.useTabStore.getState().openGitDiff({
      worktreeId: "w1",
      path: "src/main.ts",
      scope: "commit",
      commitId: "abcdef123456",
      preview: true,
    });
    const pinPromise = store.useTabStore.getState().openGitDiff({
      worktreeId: "w1",
      path: "src/main.ts",
      scope: "commit",
      commitId: "abcdef123456",
      preview: false,
    });

    await vi.waitFor(() => {
      expect(mockCreateTab).toHaveBeenCalledTimes(1);
    });

    resolveCreate(
      makeGitDiffTab({
        id: "diff-4",
        worktree_id: "w1",
        path: "src/main.ts",
        scope: "commit",
        commit_id: "abcdef123456",
        preview: true,
      }),
    );

    const [previewTab, pinnedTab] = await Promise.all([
      previewPromise,
      pinPromise,
    ]);

    expect(mockCreateTab).toHaveBeenCalledTimes(1);
    expect(mockUpdateTab).toHaveBeenCalledWith("diff-4", { preview: false });
    expect(previewTab.preview).toBe(false);
    expect(pinnedTab.preview).toBe(false);
    expect(store.tabsForWorktree("w1")[0]?.preview).toBe(false);
  });

  it("openBrowser creates and activates a browser tab", async () => {
    const store = await getStore();
    const tab = makeBrowserTab({
      id: "browser-1",
      worktree_id: "w1",
      position: 1,
      label: "New Browser",
      url: "about:blank",
      history: ["about:blank"],
    });
    mockCreateTab.mockResolvedValue(tab);

    const created = await store.useTabStore
      .getState()
      .openBrowser({ worktreeId: "w1" });

    expect(mockCreateTab).toHaveBeenCalledWith({
      type: "browser",
      worktree_id: "w1",
      pane_id: "pane-1",
      url: "about:blank",
    });
    expect(created).toEqual(tab);
    expect(store.useTabStore.getState().activeTabId).toBe(tab.id);
    expect(store.tabsForWorktree("w1")).toEqual([tab]);
  });

  it("setBrowserState normalizes and persists browser navigation", async () => {
    const store = await getStore();
    const browserTab = makeBrowserTab({
      id: "browser-2",
      worktree_id: "w1",
      url: "http://localhost:3000/",
    });
    const updated = makeBrowserTab({
      ...browserTab,
      label: "docs",
      url: "https://example.com/docs",
      history: ["http://localhost:3000/", "https://example.com/docs"],
      history_index: 1,
    });
    mockUpdateTab.mockResolvedValue(updated);

    mockEvents.emit("snapshot", {
      tabs: [browserTab],
    });

    const result = await store.useTabStore
      .getState()
      .setBrowserState(browserTab.id, {
        label: "docs",
        url: "https://example.com/docs",
        history: ["localhost:3000", "https://example.com/docs"],
        historyIndex: 1,
      });

    expect(mockUpdateTab).toHaveBeenCalledWith(browserTab.id, {
      label: "docs",
      url: "https://example.com/docs",
      history: ["http://localhost:3000/", "https://example.com/docs"],
      history_index: 1,
    });
    expect(result).toEqual(updated);
    expect(store.tabsForWorktree("w1")[0]).toMatchObject({
      url: "https://example.com/docs",
      history: ["http://localhost:3000/", "https://example.com/docs"],
      history_index: 1,
    });
  });

  it("destroys desktop browser views when browser tabs close", async () => {
    const store = await getStore();
    const browserTab = makeBrowserTab({
      id: "browser-3",
      worktree_id: "w1",
      url: "http://localhost:3000/",
    });
    mockDeleteTab.mockResolvedValue(undefined);

    mockEvents.emit("snapshot", {
      tabs: [browserTab],
    });

    await store.useTabStore.getState().close(browserTab.id);

    expect(mockDesktopBrowserDestroy).toHaveBeenCalledWith({
      tabId: browserTab.id,
    });
  });

  it("destroys desktop browser views when browser tabs close via SSE", async () => {
    const store = await getStore();
    const browserTab = makeBrowserTab({
      id: "browser-4",
      worktree_id: "w1",
      url: "http://localhost:3000/",
    });

    mockEvents.emit("snapshot", {
      tabs: [browserTab],
    });
    mockDesktopBrowserDestroy.mockClear();

    mockEvents.emit("tab_closed", {
      tab_id: browserTab.id,
    });

    expect(mockDesktopBrowserDestroy).toHaveBeenCalledWith({
      tabId: browserTab.id,
    });
    expect(store.tabsForWorktree("w1")).toEqual([]);
  });
});
