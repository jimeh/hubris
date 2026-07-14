// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandler, SseEventName } from "@/lib/events";
import type {
  AgentChatTab,
  BrowserTab,
  FileTab,
  GitDiffTab,
  Tab,
  TerminalTab,
  WorktreeTabLayoutState,
} from "@/lib/types";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import { useWorktreeFileManagerStore } from "@/lib/stores/worktreeFileManager";
import {
  initializeTabStore,
  resetTabStoreForTests,
  selectAllTabs,
  selectTabIdsForWorktree,
  selectTabsForPane,
  selectTabsForWorktree,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

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
    worktreeId: overrides.worktreeId ?? "w1",
    paneId: overrides.paneId ?? "pane-1",
    sessionId: overrides.sessionId ?? "default",
    type: overrides.type ?? "terminal",
    createdAt: overrides.createdAt ?? 0,
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
    worktreeId: overrides.worktreeId ?? "w1",
    paneId: overrides.paneId ?? "pane-1",
    sessionId: overrides.sessionId ?? "default",
    type: "file",
    createdAt: overrides.createdAt ?? 0,
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
    worktreeId: overrides.worktreeId ?? "w1",
    paneId: overrides.paneId ?? "pane-1",
    sessionId: overrides.sessionId ?? "default",
    type: "git_diff",
    createdAt: overrides.createdAt ?? 0,
    preview: overrides.preview ?? true,
    path: overrides.path,
    scope: overrides.scope ?? "unstaged",
    originalPath: overrides.originalPath ?? null,
    commitId: overrides.commitId ?? null,
  };
}

function makeBrowserTab(
  overrides: Partial<BrowserTab> & { id: string; url: string },
): BrowserTab {
  return {
    id: overrides.id,
    label: overrides.label ?? "localhost",
    position: overrides.position ?? 1,
    worktreeId: overrides.worktreeId ?? "w1",
    paneId: overrides.paneId ?? "pane-1",
    sessionId: overrides.sessionId ?? "default",
    type: "browser",
    createdAt: overrides.createdAt ?? 0,
    preview: overrides.preview ?? false,
    url: overrides.url,
    history: overrides.history ?? [overrides.url],
    historyIndex: overrides.historyIndex ?? 0,
  };
}

function makeAgentChatTab(
  overrides: Partial<AgentChatTab> & { id: string; conversationId: string },
): AgentChatTab {
  return {
    id: overrides.id,
    label: overrides.label ?? "New Chat",
    position: overrides.position ?? 1,
    worktreeId: overrides.worktreeId ?? "w1",
    paneId: overrides.paneId ?? "pane-1",
    sessionId: overrides.sessionId ?? "default",
    type: "agent_chat",
    createdAt: overrides.createdAt ?? 0,
    preview: overrides.preview ?? false,
    conversationId: overrides.conversationId,
  };
}

function makeSplitLayoutState(ratio: number): WorktreeTabLayoutState {
  return {
    layout: {
      rootId: "split-root",
      nodes: [
        { type: "leaf", id: "leaf-a", paneId: "pane-1" },
        { type: "leaf", id: "leaf-b", paneId: "pane-2" },
        {
          type: "split",
          id: "split-root",
          axis: "vertical",
          ratio,
          firstId: "leaf-a",
          secondId: "leaf-b",
        },
      ],
    },
    tabs: [
      makeTab({ id: "a", worktreeId: "w1", paneId: "pane-1" }),
      makeTab({ id: "b", worktreeId: "w1", paneId: "pane-2" }),
    ],
  };
}

function makeSinglePaneLayoutState(
  orderedIds: string[] = ["a", "b"],
): WorktreeTabLayoutState {
  return {
    layout: {
      rootId: "leaf-a",
      nodes: [{ type: "leaf", id: "leaf-a", paneId: "pane-1" }],
    },
    tabs: orderedIds.map((id, index) =>
      makeTab({ id, paneId: "pane-1", position: index + 1 }),
    ),
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
    useWorktreeFileManagerStore.setState({ worktrees: {} });
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

    expect(
      selectAllTabs(store.useTabStore.getState()).map((tab) => tab.id),
    ).toEqual(["b", "a"]);
  });

  it("switches the active tab when the selected worktree changes", async () => {
    const store = await getStore();
    mockEvents.emit("snapshot", {
      tabs: [
        makeTab({ id: "one", worktreeId: "w1" }),
        makeTab({ id: "two", worktreeId: "w2" }),
      ],
    });
    store.useTabStore.getState().activate("one");

    useWorktreeStore.setState({ selectedWorktreeId: "w2" });

    expect(store.useTabStore.getState().activeTabId).toBe("two");
  });

  it("syncs the active editor path to the file manager store", async () => {
    const store = await getStore();
    mockEvents.emit("snapshot", {
      tabs: [makeFileTab({ id: "file", path: "src/main.ts" })],
    });

    store.useTabStore.getState().activate("file");

    expect(
      useWorktreeFileManagerStore.getState().worktrees.w1?.selectedPath,
    ).toBe("src/main.ts");
  });

  it("keeps scoped selector references stable for unrelated updates", async () => {
    const store = await getStore();
    mockEvents.emit("snapshot", {
      tabs: [
        makeTab({ id: "a", worktreeId: "w1", paneId: "pane-1" }),
        makeTab({ id: "b", worktreeId: "w2", paneId: "pane-2" }),
      ],
    });
    const state = store.useTabStore.getState();
    const worktreeIds = selectTabIdsForWorktree(state, "w1");
    const worktreeTabs = selectTabsForWorktree(state, "w1");
    const paneTabs = selectTabsForPane(state, "pane-1");

    mockEvents.emit("tab_updated", {
      tab: makeTab({
        id: "b",
        label: "updated",
        worktreeId: "w2",
        paneId: "pane-2",
      }),
    });
    const nextState = store.useTabStore.getState();

    expect(selectTabIdsForWorktree(nextState, "w1")).toBe(worktreeIds);
    expect(selectTabsForWorktree(nextState, "w1")).toBe(worktreeTabs);
    expect(selectTabsForPane(nextState, "pane-1")).toBe(paneTabs);
  });

  it("persists the normalized terminal custom label", async () => {
    const store = await getStore();
    const tab = makeTab({ id: "terminal-1" });
    mockUpdateTab.mockResolvedValue({ ...tab, customLabel: "build" });
    mockEvents.emit("snapshot", { tabs: [tab] });

    await store.useTabStore
      .getState()
      .setTerminalCustomLabel(tab.id, "  build  ");

    expect(mockUpdateTab).toHaveBeenCalledWith(tab.id, {
      customLabel: "build",
    });
    expect(store.tabsForWorktree("w1")[0]).toMatchObject({
      customLabel: "build",
    });
  });

  it("uses an empty label payload to reset the terminal label", async () => {
    const store = await getStore();
    const tab = makeTab({ id: "terminal-1", customLabel: "build" });
    mockUpdateTab.mockResolvedValue({ ...tab, customLabel: null });
    mockEvents.emit("snapshot", { tabs: [tab] });

    await store.useTabStore.getState().setTerminalCustomLabel(tab.id, "   ");

    expect(mockUpdateTab).toHaveBeenCalledWith(tab.id, { customLabel: "" });
    expect(store.tabsForWorktree("w1")[0]).toMatchObject({
      customLabel: null,
    });
  });

  it("reorder() resequences locally and calls API", async () => {
    const store = await getStore();
    mockReorderTabs.mockResolvedValue([
      makeTab({ id: "c", position: 1, worktreeId: "w1" }),
      makeTab({ id: "a", position: 2, worktreeId: "w1" }),
      makeTab({ id: "b", position: 3, worktreeId: "w1" }),
    ]);

    mockEvents.emit("snapshot", {
      tabs: [
        makeTab({ id: "a", position: 1, worktreeId: "w1" }),
        makeTab({ id: "b", position: 2, worktreeId: "w1" }),
        makeTab({ id: "c", position: 3, worktreeId: "w1" }),
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
        makeTab({ id: "a", position: 1, worktreeId: "w1" }),
        makeTab({ id: "b", position: 2, worktreeId: "w1" }),
        makeTab({ id: "c", position: 3, worktreeId: "w1" }),
      ],
    });

    mockEvents.emit("tabs_reordered", {
      sessionId: "default",
      worktreeId: "w1",
      tabs: [
        makeTab({ id: "c", position: 1, worktreeId: "w1" }),
        makeTab({ id: "a", position: 2, worktreeId: "w1" }),
        makeTab({ id: "b", position: 3, worktreeId: "w1" }),
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
        makeTab({ id: "a", position: 1, worktreeId: "w1" }),
        makeTab({ id: "b", position: 2, worktreeId: "w1" }),
        makeTab({ id: "x", position: 1, worktreeId: "w2" }),
      ],
    });

    mockEvents.emit("tabs_reordered", {
      sessionId: "default",
      worktreeId: "w1",
      tabs: [
        makeTab({ id: "b", position: 1, worktreeId: "w1" }),
        makeTab({ id: "a", position: 2, worktreeId: "w1" }),
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
          { type: "leaf", id: "leaf-a", paneId: "pane-1" },
          { type: "leaf", id: "leaf-b", paneId: "pane-2" },
          {
            type: "split",
            id: "split-root",
            axis: "vertical",
            ratio: 0.7,
            firstId: "leaf-a",
            secondId: "leaf-b",
          },
        ],
      },
      tabs: [
        makeTab({ id: "a", worktreeId: "w1", paneId: "pane-1" }),
        makeTab({ id: "b", worktreeId: "w1", paneId: "pane-2" }),
      ],
    });

    mockEvents.emit("snapshot", {
      tabs: [
        makeTab({ id: "a", worktreeId: "w1", paneId: "pane-1" }),
        makeTab({ id: "b", worktreeId: "w1", paneId: "pane-2" }),
      ],
      tabLayouts: {
        w1: {
          rootId: "split-root",
          nodes: [
            { type: "leaf", id: "leaf-a", paneId: "pane-1" },
            { type: "leaf", id: "leaf-b", paneId: "pane-2" },
            {
              type: "split",
              id: "split-root",
              axis: "vertical",
              ratio: 0.5,
              firstId: "leaf-a",
              secondId: "leaf-b",
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
        { type: "leaf", id: "leaf-a", paneId: "pane-1" },
        { type: "leaf", id: "leaf-b", paneId: "pane-2" },
        {
          type: "split",
          id: "split-root",
          axis: "vertical",
          ratio: 0.7,
          firstId: "leaf-a",
          secondId: "leaf-b",
        },
      ],
      panes: [
        { paneId: "pane-1", tabIds: ["a"] },
        { paneId: "pane-2", tabIds: ["b"] },
      ],
    });
  });

  it("does not let an older layout failure roll back a newer write", async () => {
    const store = await getStore();
    const firstWrite = deferred<WorktreeTabLayoutState>();
    const secondWrite = deferred<WorktreeTabLayoutState>();
    mockUpdateWorktreeTabLayout
      .mockReturnValueOnce(firstWrite.promise)
      .mockReturnValueOnce(secondWrite.promise);
    const initial = makeSplitLayoutState(0.5);
    mockEvents.emit("snapshot", {
      tabs: initial.tabs,
      tabLayouts: { w1: initial.layout },
    });

    store.useTabStore.getState().setSplitRatio("w1", "split-root", 0.6);
    const firstPersist = store.useTabStore.getState().persistLayout("p1", "w1");
    store.useTabStore.getState().setSplitRatio("w1", "split-root", 0.7);
    const secondPersist = store.useTabStore
      .getState()
      .persistLayout("p1", "w1");

    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(1);
    });
    firstWrite.reject(new Error("first write failed"));
    await expect(firstPersist).rejects.toThrow("first write failed");
    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(2);
    });
    expect(
      store.useTabStore.getState().layoutsByWorktree.w1.nodes,
    ).toContainEqual(expect.objectContaining({ id: "split-root", ratio: 0.7 }));

    secondWrite.resolve(makeSplitLayoutState(0.7));
    await secondPersist;
    expect(
      store.useTabStore.getState().layoutsByWorktree.w1.nodes,
    ).toContainEqual(expect.objectContaining({ id: "split-root", ratio: 0.7 }));
  });

  it("rolls the latest failed layout write back to confirmed state", async () => {
    const store = await getStore();
    const firstWrite = deferred<WorktreeTabLayoutState>();
    const secondWrite = deferred<WorktreeTabLayoutState>();
    mockUpdateWorktreeTabLayout
      .mockReturnValueOnce(firstWrite.promise)
      .mockReturnValueOnce(secondWrite.promise);
    const initial = makeSplitLayoutState(0.5);
    mockEvents.emit("snapshot", {
      tabs: initial.tabs,
      tabLayouts: { w1: initial.layout },
    });

    store.useTabStore.getState().setSplitRatio("w1", "split-root", 0.6);
    const firstPersist = store.useTabStore.getState().persistLayout("p1", "w1");
    store.useTabStore.getState().setSplitRatio("w1", "split-root", 0.7);
    const secondPersist = store.useTabStore
      .getState()
      .persistLayout("p1", "w1");

    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(1);
    });
    firstWrite.resolve(makeSplitLayoutState(0.6));
    await firstPersist;
    expect(
      store.useTabStore.getState().layoutsByWorktree.w1.nodes,
    ).toContainEqual(expect.objectContaining({ id: "split-root", ratio: 0.7 }));

    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(2);
    });
    secondWrite.reject(new Error("second write failed"));
    await expect(secondPersist).rejects.toThrow("second write failed");
    expect(
      store.useTabStore.getState().layoutsByWorktree.w1.nodes,
    ).toContainEqual(expect.objectContaining({ id: "split-root", ratio: 0.6 }));
  });

  it("matches a delayed acknowledgement to its serialized write", async () => {
    const store = await getStore();
    const firstWrite = deferred<WorktreeTabLayoutState>();
    const secondWrite = deferred<WorktreeTabLayoutState>();
    mockUpdateWorktreeTabLayout
      .mockReturnValueOnce(firstWrite.promise)
      .mockReturnValueOnce(secondWrite.promise);
    const initial = makeSplitLayoutState(0.5);
    mockEvents.emit("snapshot", {
      tabs: initial.tabs,
      tabLayouts: { w1: initial.layout },
    });

    store.useTabStore.getState().setSplitRatio("w1", "split-root", 0.6);
    const firstPersist = store.useTabStore.getState().persistLayout("p1", "w1");
    store.useTabStore.getState().setSplitRatio("w1", "split-root", 0.7);
    const secondPersist = store.useTabStore
      .getState()
      .persistLayout("p1", "w1");

    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(1);
    });
    firstWrite.resolve(makeSplitLayoutState(0.6));
    await firstPersist;
    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(2);
    });

    mockEvents.emit("worktree_tab_layout_updated", {
      worktreeId: "w1",
      state: makeSplitLayoutState(0.6),
    });
    expect(
      store.useTabStore.getState().layoutsByWorktree.w1.nodes,
    ).toContainEqual(expect.objectContaining({ id: "split-root", ratio: 0.7 }));

    secondWrite.resolve(makeSplitLayoutState(0.7));
    await secondPersist;
    mockEvents.emit("worktree_tab_layout_updated", {
      worktreeId: "w1",
      state: makeSplitLayoutState(0.7),
    });
    expect(
      store.useTabStore.getState().layoutsByWorktree.w1.nodes,
    ).toContainEqual(expect.objectContaining({ id: "split-root", ratio: 0.7 }));
  });

  it("confirms a newer HTTP result after an older delayed acknowledgement", async () => {
    const store = await getStore();
    const firstWrite = deferred<WorktreeTabLayoutState>();
    const secondWrite = deferred<WorktreeTabLayoutState>();
    const thirdWrite = deferred<WorktreeTabLayoutState>();
    mockUpdateWorktreeTabLayout
      .mockReturnValueOnce(firstWrite.promise)
      .mockReturnValueOnce(secondWrite.promise)
      .mockReturnValueOnce(thirdWrite.promise);
    const initial = makeSplitLayoutState(0.5);
    mockEvents.emit("snapshot", {
      tabs: initial.tabs,
      tabLayouts: { w1: initial.layout },
    });

    store.useTabStore.getState().setSplitRatio("w1", "split-root", 0.6);
    const firstPersist = store.useTabStore.getState().persistLayout("p1", "w1");
    store.useTabStore.getState().setSplitRatio("w1", "split-root", 0.7);
    const secondPersist = store.useTabStore
      .getState()
      .persistLayout("p1", "w1");

    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(1);
    });
    firstWrite.resolve(makeSplitLayoutState(0.6));
    await firstPersist;
    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(2);
    });
    mockEvents.emit("worktree_tab_layout_updated", {
      worktreeId: "w1",
      state: makeSplitLayoutState(0.6),
    });

    secondWrite.resolve(makeSplitLayoutState(0.7));
    await secondPersist;
    store.useTabStore.getState().setSplitRatio("w1", "split-root", 0.8);
    const thirdPersist = store.useTabStore.getState().persistLayout("p1", "w1");
    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(3);
    });
    thirdWrite.reject(new Error("third write failed"));
    await expect(thirdPersist).rejects.toThrow("third write failed");

    expect(
      store.useTabStore.getState().layoutsByWorktree.w1.nodes,
    ).toContainEqual(expect.objectContaining({ id: "split-root", ratio: 0.7 }));
    mockEvents.emit("worktree_tab_layout_updated", {
      worktreeId: "w1",
      state: makeSplitLayoutState(0.7),
    });
    expect(
      store.useTabStore.getState().layoutsByWorktree.w1.nodes,
    ).toContainEqual(expect.objectContaining({ id: "split-root", ratio: 0.7 }));
  });

  it("keeps authoritative reorder state ahead of an older HTTP response", async () => {
    const store = await getStore();
    const write = deferred<WorktreeTabLayoutState>();
    mockUpdateWorktreeTabLayout.mockReturnValue(write.promise);
    const initial = makeSinglePaneLayoutState();
    mockEvents.emit("snapshot", {
      tabs: initial.tabs,
      tabLayouts: { w1: initial.layout },
    });

    const persist = store.useTabStore.getState().persistLayout("p1", "w1");
    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(1);
    });

    mockEvents.emit("worktree_tab_layout_updated", {
      worktreeId: "w1",
      state: initial,
    });
    const reordered = makeSinglePaneLayoutState(["b", "a"]);
    mockEvents.emit("tabs_reordered", {
      sessionId: "default",
      worktreeId: "w1",
      tabs: reordered.tabs,
    });
    write.resolve(initial);
    await persist;

    expect(store.tabsForWorktree("w1").map((tab) => tab.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("does not roll back a local reorder with an older layout failure", async () => {
    const store = await getStore();
    const write = deferred<WorktreeTabLayoutState>();
    mockUpdateWorktreeTabLayout.mockReturnValue(write.promise);
    const initial = makeSinglePaneLayoutState();
    mockReorderTabs.mockResolvedValue(
      makeSinglePaneLayoutState(["b", "a"]).tabs,
    );
    mockEvents.emit("snapshot", {
      tabs: initial.tabs,
      tabLayouts: { w1: initial.layout },
    });

    const persist = store.useTabStore.getState().persistLayout("p1", "w1");
    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(1);
    });

    await store.useTabStore.getState().reorder("w1", "pane-1", ["b", "a"]);
    write.reject(new Error("layout rejected"));
    await expect(persist).rejects.toThrow("layout rejected");

    expect(store.tabsForWorktree("w1").map((tab) => tab.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("confirms each overlapping reorder from its own response", async () => {
    const store = await getStore();
    const layoutWrite = deferred<WorktreeTabLayoutState>();
    const firstReorder = deferred<Tab[]>();
    const secondReorder = deferred<Tab[]>();
    mockUpdateWorktreeTabLayout.mockReturnValue(layoutWrite.promise);
    mockReorderTabs
      .mockReturnValueOnce(firstReorder.promise)
      .mockReturnValueOnce(secondReorder.promise);
    const initial = makeSinglePaneLayoutState();
    mockEvents.emit("snapshot", {
      tabs: initial.tabs,
      tabLayouts: { w1: initial.layout },
    });

    const persist = store.useTabStore.getState().persistLayout("p1", "w1");
    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(1);
    });
    const first = store.useTabStore
      .getState()
      .reorder("w1", "pane-1", ["b", "a"]);
    const second = store.useTabStore
      .getState()
      .reorder("w1", "pane-1", ["a", "b"]);

    await vi.waitFor(() => {
      expect(mockReorderTabs).toHaveBeenCalledTimes(1);
    });
    firstReorder.resolve(makeSinglePaneLayoutState(["b", "a"]).tabs);
    await first;
    await vi.waitFor(() => {
      expect(mockReorderTabs).toHaveBeenCalledTimes(2);
    });
    secondReorder.reject(new Error("second reorder rejected"));
    await expect(second).rejects.toThrow("second reorder rejected");
    layoutWrite.reject(new Error("layout rejected"));
    await expect(persist).rejects.toThrow("layout rejected");

    expect(store.tabsForWorktree("w1").map((tab) => tab.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("does not rebase another pane from an older reorder response", async () => {
    const store = await getStore();
    const layoutWrite = deferred<WorktreeTabLayoutState>();
    const firstPaneReorder = deferred<Tab[]>();
    const secondPaneReorder = deferred<Tab[]>();
    mockUpdateWorktreeTabLayout.mockReturnValue(layoutWrite.promise);
    mockReorderTabs
      .mockReturnValueOnce(firstPaneReorder.promise)
      .mockReturnValueOnce(secondPaneReorder.promise);
    const initial = makeSplitLayoutState(0.5);
    initial.tabs = [
      makeTab({ id: "a", paneId: "pane-1", position: 1 }),
      makeTab({ id: "c", paneId: "pane-1", position: 2 }),
      makeTab({ id: "b", paneId: "pane-2", position: 1 }),
      makeTab({ id: "d", paneId: "pane-2", position: 2 }),
    ];
    mockEvents.emit("snapshot", {
      tabs: initial.tabs,
      tabLayouts: { w1: initial.layout },
    });

    const persist = store.useTabStore.getState().persistLayout("p1", "w1");
    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(1);
    });
    const first = store.useTabStore
      .getState()
      .reorder("w1", "pane-1", ["c", "a"]);
    const second = store.useTabStore
      .getState()
      .reorder("w1", "pane-2", ["d", "b"]);
    await vi.waitFor(() => {
      expect(mockReorderTabs).toHaveBeenCalledTimes(2);
    });

    secondPaneReorder.resolve([
      makeTab({ id: "a", paneId: "pane-1", position: 1 }),
      makeTab({ id: "c", paneId: "pane-1", position: 2 }),
      makeTab({ id: "d", paneId: "pane-2", position: 1 }),
      makeTab({ id: "b", paneId: "pane-2", position: 2 }),
    ]);
    await second;
    firstPaneReorder.resolve([
      makeTab({ id: "c", paneId: "pane-1", position: 1 }),
      makeTab({ id: "a", paneId: "pane-1", position: 2 }),
      makeTab({ id: "b", paneId: "pane-2", position: 1 }),
      makeTab({ id: "d", paneId: "pane-2", position: 2 }),
    ]);
    await first;
    layoutWrite.reject(new Error("layout rejected"));
    await expect(persist).rejects.toThrow("layout rejected");

    const tabs = store.tabsForWorktree("w1");
    expect(
      tabs.filter((tab) => tab.paneId === "pane-1").map((tab) => tab.id),
    ).toEqual(["c", "a"]);
    expect(
      tabs.filter((tab) => tab.paneId === "pane-2").map((tab) => tab.id),
    ).toEqual(["d", "b"]);
  });

  it("does not confirm a rejected reorder as the rollback baseline", async () => {
    const store = await getStore();
    const write = deferred<WorktreeTabLayoutState>();
    mockUpdateWorktreeTabLayout.mockReturnValue(write.promise);
    mockReorderTabs.mockRejectedValue(new Error("reorder rejected"));
    const initial = makeSinglePaneLayoutState();
    mockEvents.emit("snapshot", {
      tabs: initial.tabs,
      tabLayouts: { w1: initial.layout },
    });

    const persist = store.useTabStore.getState().persistLayout("p1", "w1");
    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(1);
    });

    await expect(
      store.useTabStore.getState().reorder("w1", "pane-1", ["b", "a"]),
    ).rejects.toThrow("reorder rejected");
    write.reject(new Error("layout rejected"));
    await expect(persist).rejects.toThrow("layout rejected");

    expect(store.tabsForWorktree("w1").map((tab) => tab.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("does not confirm a pending pane move when a reorder lands", async () => {
    const store = await getStore();
    const write = deferred<WorktreeTabLayoutState>();
    mockUpdateWorktreeTabLayout.mockReturnValue(write.promise);
    const initial = makeSplitLayoutState(0.5);
    mockReorderTabs.mockResolvedValue([
      makeTab({ id: "b", paneId: "pane-2", position: 1 }),
      makeTab({ id: "a", paneId: "pane-2", position: 2 }),
    ]);
    mockEvents.emit("snapshot", {
      tabs: initial.tabs,
      tabLayouts: { w1: initial.layout },
    });

    const move = store.useTabStore
      .getState()
      .moveTab("p1", "w1", "a", "pane-2", "center");
    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(1);
    });

    await store.useTabStore.getState().reorder("w1", "pane-2", ["b", "a"]);
    write.reject(new Error("move rejected"));
    await expect(move).rejects.toThrow("move rejected");

    expect(store.tabsForWorktree("w1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "a", paneId: "pane-1" }),
        expect.objectContaining({ id: "b", paneId: "pane-2" }),
      ]),
    );
  });

  it("rebases an equal snapshot before a lost response rolls back", async () => {
    const store = await getStore();
    const write = deferred<WorktreeTabLayoutState>();
    mockUpdateWorktreeTabLayout.mockReturnValue(write.promise);
    const initial = makeSplitLayoutState(0.5);
    mockEvents.emit("snapshot", {
      tabs: initial.tabs,
      tabLayouts: { w1: initial.layout },
    });

    store.useTabStore.getState().setSplitRatio("w1", "split-root", 0.7);
    const persist = store.useTabStore.getState().persistLayout("p1", "w1");
    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(1);
    });

    const authoritative = makeSplitLayoutState(0.7);
    mockEvents.emit("snapshot", {
      tabs: authoritative.tabs,
      tabLayouts: { w1: authoritative.layout },
    });
    write.reject(new Error("response lost"));
    await expect(persist).rejects.toThrow("response lost");

    expect(
      store.useTabStore.getState().layoutsByWorktree.w1.nodes,
    ).toContainEqual(expect.objectContaining({ id: "split-root", ratio: 0.7 }));
  });

  it("does not resurrect a tab closed while a layout write is pending", async () => {
    const store = await getStore();
    const write = deferred<WorktreeTabLayoutState>();
    mockUpdateWorktreeTabLayout.mockReturnValue(write.promise);
    const initial = makeSplitLayoutState(0.5);
    mockEvents.emit("snapshot", {
      tabs: initial.tabs,
      tabLayouts: { w1: initial.layout },
    });

    store.useTabStore.getState().setSplitRatio("w1", "split-root", 0.7);
    const persist = store.useTabStore.getState().persistLayout("p1", "w1");
    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(1);
    });

    mockEvents.emit("tab_closed", { tabId: "b" });
    write.reject(new Error("layout rejected"));
    await expect(persist).rejects.toThrow("layout rejected");

    expect(store.tabsForWorktree("w1").map((tab) => tab.id)).toEqual(["a"]);
    expect(store.useTabStore.getState().layoutsByWorktree.w1).toEqual({
      rootId: "leaf-a",
      nodes: [{ type: "leaf", id: "leaf-a", paneId: "pane-1" }],
    });
  });

  it("keeps a tab created while a layout write is pending", async () => {
    const store = await getStore();
    const write = deferred<WorktreeTabLayoutState>();
    mockUpdateWorktreeTabLayout.mockReturnValue(write.promise);
    const initial = makeSplitLayoutState(0.5);
    mockEvents.emit("snapshot", {
      tabs: initial.tabs,
      tabLayouts: { w1: initial.layout },
    });

    store.useTabStore.getState().setSplitRatio("w1", "split-root", 0.7);
    const persist = store.useTabStore.getState().persistLayout("p1", "w1");
    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(1);
    });

    mockEvents.emit("tab_created", {
      sessionId: "default",
      tab: makeTab({ id: "c", paneId: "pane-1", position: 2 }),
    });
    write.reject(new Error("layout rejected"));
    await expect(persist).rejects.toThrow("layout rejected");

    expect(store.tabsForWorktree("w1").map((tab) => tab.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect(
      store.useTabStore.getState().layoutsByWorktree.w1.nodes,
    ).toContainEqual(expect.objectContaining({ id: "split-root", ratio: 0.5 }));
  });

  it("keeps newer authoritative layout state after an older response", async () => {
    const store = await getStore();
    const write = deferred<WorktreeTabLayoutState>();
    mockUpdateWorktreeTabLayout.mockReturnValue(write.promise);
    const initial = makeSplitLayoutState(0.5);
    mockEvents.emit("snapshot", {
      tabs: initial.tabs,
      tabLayouts: { w1: initial.layout },
    });

    store.useTabStore.getState().setSplitRatio("w1", "split-root", 0.6);
    const persist = store.useTabStore.getState().persistLayout("p1", "w1");
    await vi.waitFor(() => {
      expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(1);
    });

    mockEvents.emit("worktree_tab_layout_updated", {
      worktreeId: "w1",
      state: makeSplitLayoutState(0.6),
    });
    mockEvents.emit("worktree_tab_layout_updated", {
      worktreeId: "w1",
      state: makeSplitLayoutState(0.8),
    });
    write.resolve(makeSplitLayoutState(0.6));
    await persist;

    expect(
      store.useTabStore.getState().layoutsByWorktree.w1.nodes,
    ).toContainEqual(expect.objectContaining({ id: "split-root", ratio: 0.8 }));
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
          { type: "leaf", id: "leaf-a", paneId: "pane-1" },
          {
            type: "leaf",
            id: "leaf-b",
            paneId: "00000000-0000-4000-8000-000000000000",
          },
          {
            type: "split",
            id: "split-root",
            axis: "vertical",
            ratio: 0.5,
            firstId: "leaf-a",
            secondId: "leaf-b",
          },
        ],
      },
      tabs: [makeTab({ id: "a", worktreeId: "w1", paneId: "pane-1" })],
    });
    mockCreateTerminalTab.mockResolvedValue(
      makeTab({
        id: "b",
        worktreeId: "w1",
        paneId: "00000000-0000-4000-8000-000000000000",
      }),
    );

    mockEvents.emit("snapshot", {
      tabs: [makeTab({ id: "a", worktreeId: "w1", paneId: "pane-1" })],
      tabLayouts: {
        w1: {
          rootId: "leaf-a",
          nodes: [{ type: "leaf", id: "leaf-a", paneId: "pane-1" }],
        },
      },
    });

    await store.useTabStore.getState().splitPane("p1", "w1", "pane-1", "right");

    const layoutRequest = mockUpdateWorktreeTabLayout.mock.calls[0]?.[2];
    expect(layoutRequest).toEqual({
      rootId: expect.any(String),
      nodes: expect.arrayContaining([
        expect.objectContaining({ type: "leaf", paneId: "pane-1" }),
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
            { type: "leaf", id: "leaf-a", paneId: "pane-1" },
            {
              type: "leaf",
              id: "leaf-b",
              paneId: "00000000-0000-4000-8000-000000000000",
            },
            {
              type: "split",
              id: "split-root",
              axis: "vertical",
              ratio: 0.5,
              firstId: "leaf-a",
              secondId: "leaf-b",
            },
          ],
        },
        tabs: [makeTab({ id: "a", worktreeId: "w1", paneId: "pane-1" })],
      })
      .mockResolvedValueOnce({
        layout: {
          rootId: "leaf-a",
          nodes: [{ type: "leaf", id: "leaf-a", paneId: "pane-1" }],
        },
        tabs: [makeTab({ id: "a", worktreeId: "w1", paneId: "pane-1" })],
      });
    mockCreateTerminalTab.mockRejectedValue(new Error("boom"));

    mockEvents.emit("snapshot", {
      tabs: [makeTab({ id: "a", worktreeId: "w1", paneId: "pane-1" })],
      tabLayouts: {
        w1: {
          rootId: "leaf-a",
          nodes: [{ type: "leaf", id: "leaf-a", paneId: "pane-1" }],
        },
      },
    });

    await expect(
      store.useTabStore.getState().splitPane("p1", "w1", "pane-1", "right"),
    ).rejects.toThrow("boom");

    expect(mockUpdateWorktreeTabLayout).toHaveBeenCalledTimes(2);
    expect(mockUpdateWorktreeTabLayout.mock.calls[1]?.[2]).toEqual({
      rootId: "leaf-a",
      nodes: [{ type: "leaf", id: "leaf-a", paneId: "pane-1" }],
      panes: [{ paneId: "pane-1", tabIds: ["a"] }],
    });
    expect(store.useTabStore.getState().layoutsByWorktree.w1).toEqual({
      rootId: "leaf-a",
      nodes: [{ type: "leaf", id: "leaf-a", paneId: "pane-1" }],
    });
  });

  it("closing the focused pane falls back to the previously focused pane", async () => {
    const store = await getStore();
    mockDeleteTab.mockResolvedValue(undefined);

    mockEvents.emit("snapshot", {
      tabs: [
        makeTab({ id: "a", worktreeId: "w1", paneId: "pane-1" }),
        makeTab({ id: "b", worktreeId: "w1", paneId: "pane-2" }),
        makeTab({ id: "c", worktreeId: "w1", paneId: "pane-3" }),
      ],
      tabLayouts: {
        w1: {
          rootId: "split-root",
          nodes: [
            { type: "leaf", id: "leaf-a", paneId: "pane-1" },
            { type: "leaf", id: "leaf-b", paneId: "pane-2" },
            { type: "leaf", id: "leaf-c", paneId: "pane-3" },
            {
              type: "split",
              id: "split-right",
              axis: "horizontal",
              ratio: 0.5,
              firstId: "leaf-b",
              secondId: "leaf-c",
            },
            {
              type: "split",
              id: "split-root",
              axis: "vertical",
              ratio: 0.5,
              firstId: "leaf-a",
              secondId: "split-right",
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
      tabs: [makeTab({ id: "a", worktreeId: "w1", position: 1 })],
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
        makeTab({ id: "a", worktreeId: "w1", paneId: "pane-1", position: 1 }),
        makeTab({ id: "b", worktreeId: "w1", paneId: "pane-1", position: 2 }),
        makeTab({ id: "c", worktreeId: "w1", paneId: "pane-1", position: 3 }),
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
        makeTab({ id: "a", worktreeId: "w1", paneId: "pane-1", position: 1 }),
        makeTab({ id: "b", worktreeId: "w1", paneId: "pane-1", position: 2 }),
        makeTab({ id: "c", worktreeId: "w1", paneId: "pane-1", position: 3 }),
      ],
    });

    store.useTabStore.getState().activate("b");
    await store.useTabStore.getState().close("c");

    expect(store.useTabStore.getState().activeTabId).toBe("b");
    expect(store.useTabStore.getState().activeTabByPane["pane-1"]).toBe("b");
  });

  it("keeps a tab and its resources when deletion fails", async () => {
    const store = await getStore();
    const tab = makeFileTab({
      id: "file-1",
      path: "src/main.ts",
      preview: false,
    });
    mockDeleteTab.mockRejectedValue(new Error("delete failed"));
    mockEvents.emit("snapshot", { tabs: [tab] });

    await expect(store.useTabStore.getState().close(tab.id)).rejects.toThrow(
      "delete failed",
    );

    expect(store.tabsForWorktree("w1")).toEqual([tab]);
    expect(mockScheduleDisposeTabModels).not.toHaveBeenCalled();
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
        makeTab({ id: "a", worktreeId: "w1", paneId: "pane-1", position: 1 }),
        makeTab({ id: "b", worktreeId: "w1", paneId: "pane-1", position: 2 }),
        makeTab({ id: "c", worktreeId: "w1", paneId: "pane-2", position: 1 }),
      ],
      tabLayouts: {
        w1: {
          rootId: "split-root",
          nodes: [
            { type: "leaf", id: "leaf-1", paneId: "pane-1" },
            { type: "leaf", id: "leaf-2", paneId: "pane-2" },
            {
              type: "split",
              id: "split-root",
              axis: "vertical",
              ratio: 0.5,
              firstId: "leaf-1",
              secondId: "leaf-2",
            },
          ],
        },
      },
      worktreeRestoreState: {
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
              projectId: "p1",
              name: "local",
              branch: "main",
              path: "/repo",
              sourceRef: null,
              uiMode: "hubris",
              isLocal: true,
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
            worktreeId: "w1",
            paneId: "pane-1",
            position: 1,
          }),
          makeTab({
            id: "b",
            worktreeId: "w1",
            paneId: "pane-1",
            position: 2,
          }),
        ],
        tabLayouts: {
          w1: {
            rootId: "root",
            nodes: [{ type: "leaf", id: "root", paneId: "pane-1" }],
          },
        },
        worktreeRestoreState: {
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

  it("retries restore-state failures with the latest payload", async () => {
    vi.useFakeTimers();
    try {
      useWorktreeStore.setState({
        worktreesByProject: {
          p1: [
            {
              id: "w1",
              projectId: "p1",
              name: "local",
              branch: "main",
              path: "/repo",
              sourceRef: null,
              uiMode: "hubris",
              isLocal: true,
              position: 1,
            },
          ],
        },
        projectErrors: {},
        selectedWorktreeId: "w1",
      });
      const store = await getStore();
      mockUpdateWorktreeRestoreState
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValue(undefined);

      mockEvents.emit("snapshot", {
        tabs: [
          makeTab({ id: "a", position: 1 }),
          makeTab({ id: "b", position: 2 }),
          makeTab({ id: "c", position: 3 }),
        ],
        worktreeRestoreState: {
          w1: {
            activeTabId: "a",
            focusedPaneId: "pane-1",
            paneMru: ["pane-1"],
            tabMruByPane: { "pane-1": ["a", "b", "c"] },
          },
        },
      });

      store.useTabStore.getState().activate("b");
      await vi.advanceTimersByTimeAsync(250);
      expect(mockUpdateWorktreeRestoreState).toHaveBeenLastCalledWith(
        "p1",
        "w1",
        expect.objectContaining({ activeTabId: "b" }),
      );

      store.useTabStore.getState().activate("c");
      await vi.advanceTimersByTimeAsync(250);
      expect(mockUpdateWorktreeRestoreState).toHaveBeenCalledTimes(2);
      expect(mockUpdateWorktreeRestoreState).toHaveBeenLastCalledWith(
        "p1",
        "w1",
        expect.objectContaining({ activeTabId: "c" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("openFile dedupes a raced tab_created event", async () => {
    const store = await getStore();
    const tab = makeFileTab({
      id: "file-1",
      worktreeId: "w1",
      path: "src/main.ts",
      preview: true,
    });
    mockCreateTab.mockImplementation(async () => {
      mockEvents.emit("tab_created", {
        sessionId: "default",
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

  it("only replaces a preview after its deletion is confirmed", async () => {
    const store = await getStore();
    const deletion = deferred<void>();
    const previewTab = makeFileTab({
      id: "preview-1",
      worktreeId: "w1",
      path: "src/old.ts",
      preview: true,
    });
    const nextTab = makeFileTab({
      id: "preview-2",
      worktreeId: "w1",
      path: "src/new.ts",
      preview: true,
      position: 2,
    });
    mockCreateTab.mockResolvedValue(nextTab);
    mockDeleteTab.mockReturnValue(deletion.promise);

    mockEvents.emit("snapshot", {
      tabs: [previewTab],
    });

    const opening = store.useTabStore.getState().openFile({
      worktreeId: "w1",
      path: "src/new.ts",
      preview: true,
    });

    await vi.waitFor(() => {
      expect(mockDeleteTab).toHaveBeenCalledWith(previewTab.id);
    });
    expect(mockScheduleDisposeTabModels).not.toHaveBeenCalled();
    expect(mockCreateTab).not.toHaveBeenCalled();
    expect(store.tabsForWorktree("w1")).toEqual([previewTab]);

    deletion.resolve(undefined);
    await opening;
    expect(mockScheduleDisposeTabModels).toHaveBeenCalledWith(previewTab);
    expect(store.tabsForWorktree("w1").map((tab) => tab.id)).toEqual([
      nextTab.id,
    ]);
  });

  it("preserves a preview when its deletion fails", async () => {
    const store = await getStore();
    const previewTab = makeFileTab({
      id: "preview-1",
      worktreeId: "w1",
      path: "src/old.ts",
      preview: true,
    });
    mockDeleteTab.mockRejectedValue(new Error("delete failed"));
    mockEvents.emit("snapshot", { tabs: [previewTab] });

    await expect(
      store.useTabStore.getState().openFile({
        worktreeId: "w1",
        path: "src/new.ts",
        preview: true,
      }),
    ).rejects.toThrow("delete failed");

    expect(store.tabsForWorktree("w1")).toEqual([previewTab]);
    expect(mockCreateTab).not.toHaveBeenCalled();
    expect(mockScheduleDisposeTabModels).not.toHaveBeenCalled();
  });

  it("openGitDiff dedupes commit diff tabs by commitId", async () => {
    const store = await getStore();
    const existing = makeGitDiffTab({
      id: "diff-1",
      worktreeId: "w1",
      path: "src/main.ts",
      scope: "commit",
      commitId: "abcdef123456",
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
      worktreeId: "w1",
      path: "src/main.ts",
      scope: "commit",
      commitId: "fedcba654321",
      preview: false,
      position: 2,
    });
    mockCreateTab.mockResolvedValue(created);

    mockEvents.emit("snapshot", {
      tabs: [
        makeGitDiffTab({
          id: "diff-1",
          worktreeId: "w1",
          path: "src/main.ts",
          scope: "commit",
          commitId: "abcdef123456",
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
      worktreeId: "w1",
      paneId: "pane-1",
      path: "src/main.ts",
      scope: "commit",
      originalPath: undefined,
      commitId: "fedcba654321",
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
        worktreeId: "w1",
        path: "src/main.ts",
        scope: "commit",
        commitId: "abcdef123456",
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
        worktreeId: "w1",
        conversationId: "chat-1",
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
        paneId: "pane-1",
        worktreeId: "w1",
        conversationId: "chat-1",
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
        worktreeId: "w1",
        path: "src/main.ts",
        scope: "commit",
        commitId: "abcdef123456",
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
        worktreeId: "w1",
        path: "src/main.ts",
        scope: "commit",
        commitId: "abcdef123456",
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
      worktreeId: "w1",
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
      worktreeId: "w1",
      paneId: "pane-1",
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
      worktreeId: "w1",
      url: "http://localhost:3000/",
    });
    const updated = makeBrowserTab({
      ...browserTab,
      label: "docs",
      url: "https://example.com/docs",
      history: ["http://localhost:3000/", "https://example.com/docs"],
      historyIndex: 1,
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
      historyIndex: 1,
    });
    expect(result).toEqual(updated);
    expect(store.tabsForWorktree("w1")[0]).toMatchObject({
      url: "https://example.com/docs",
      history: ["http://localhost:3000/", "https://example.com/docs"],
      historyIndex: 1,
    });
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid browser history index %s",
    async (historyIndex) => {
      const store = await getStore();
      const browserTab = makeBrowserTab({
        id: "browser-invalid-history",
        worktreeId: "w1",
        url: "https://example.com/",
      });
      mockEvents.emit("snapshot", { tabs: [browserTab] });

      await expect(
        store.useTabStore
          .getState()
          .setBrowserState(browserTab.id, { historyIndex }),
      ).rejects.toThrow("historyIndex must point at an entry in history.");
      expect(mockUpdateTab).not.toHaveBeenCalled();
    },
  );

  it("destroys desktop browser views when browser tabs close", async () => {
    const store = await getStore();
    const browserTab = makeBrowserTab({
      id: "browser-3",
      worktreeId: "w1",
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
      worktreeId: "w1",
      url: "http://localhost:3000/",
    });

    mockEvents.emit("snapshot", {
      tabs: [browserTab],
    });
    mockDesktopBrowserDestroy.mockClear();

    mockEvents.emit("tab_closed", {
      tabId: browserTab.id,
    });

    expect(mockDesktopBrowserDestroy).toHaveBeenCalledWith({
      tabId: browserTab.id,
    });
    expect(store.tabsForWorktree("w1")).toEqual([]);
  });
});
