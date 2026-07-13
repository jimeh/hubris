// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandler, SseEventName } from "@/lib/events";
import type { Worktree } from "@/lib/types";
import { deleteProjectWorktree, updateProjectWorktree } from "@/lib/api";
import {
  resetHubrisWorkbenchStoreForTests,
  useHubrisWorkbenchStore,
} from "@/lib/stores/hubrisWorkbench";
import {
  resetVscodeWorkbenchStoreForTests,
  useVscodeWorkbenchStore,
} from "@/lib/stores/vscodeWorkbench";
import {
  initializeWorktreeStore,
  resetWorktreeStoreForTests,
  useWorktreeStore,
} from "./worktrees";

vi.mock("@/lib/api", () => ({
  createProjectWorktree: vi.fn(),
  deleteProjectWorktree: vi.fn(),
  reorderProjectWorktrees: vi.fn(),
  updateProjectWorktree: vi.fn(),
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

function makeWorktree(
  overrides: Partial<Worktree> & { id: string; projectId: string },
): Worktree {
  return {
    id: overrides.id,
    projectId: overrides.projectId,
    name: overrides.name ?? "worktree",
    path: overrides.path ?? "/tmp/worktree",
    branch: overrides.branch ?? "main",
    sourceRef: overrides.sourceRef ?? null,
    uiMode: overrides.uiMode ?? "hubris",
    isLocal: overrides.isLocal ?? false,
    missingOnDisk: overrides.missingOnDisk ?? false,
    position: overrides.position ?? 1,
  };
}

function getStore() {
  resetWorktreeStoreForTests();
  initializeWorktreeStore();
  return {
    initializeWorktreeStore,
    resetWorktreeStoreForTests,
    useWorktreeStore,
  };
}

describe("Worktree store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    mockEvents = new MockEventClient();
    resetHubrisWorkbenchStoreForTests();
    resetVscodeWorkbenchStoreForTests();
  });

  it("preserves missingOnDisk from snapshot payload", async () => {
    const store = await getStore();
    mockEvents.emit("snapshot", {
      worktrees: {
        p1: [
          makeWorktree({
            id: "local",
            projectId: "p1",
            name: "local",
            isLocal: true,
            branch: "local",
            position: 1,
          }),
          makeWorktree({
            id: "missing",
            projectId: "p1",
            name: "feature-a",
            missingOnDisk: true,
            position: 2,
          }),
        ],
      },
      projectErrors: {},
    });

    const list = store.useWorktreeStore.getState().worktreesByProject.p1 ?? [];
    expect(
      list.find((worktree) => worktree.id === "missing")?.missingOnDisk,
    ).toBe(true);
  });

  it("replaces and sorts worktrees on project_worktrees_updated", async () => {
    const store = await getStore();
    mockEvents.emit("snapshot", {
      worktrees: {
        p1: [
          makeWorktree({
            id: "local",
            projectId: "p1",
            name: "local",
            isLocal: true,
            branch: "local",
            position: 1,
          }),
        ],
      },
      projectErrors: {},
    });

    mockEvents.emit("project_worktrees_updated", {
      projectId: "p1",
      worktrees: [
        makeWorktree({
          id: "feature-b",
          projectId: "p1",
          name: "feature-b",
          position: 3,
        }),
        makeWorktree({
          id: "local",
          projectId: "p1",
          name: "local",
          isLocal: true,
          branch: "local",
          position: 1,
        }),
        makeWorktree({
          id: "feature-a",
          projectId: "p1",
          name: "feature-a",
          position: 2,
        }),
      ],
      gitError: null,
    });

    expect(
      (store.useWorktreeStore.getState().worktreesByProject.p1 ?? []).map(
        (worktree) => worktree.id,
      ),
    ).toEqual(["local", "feature-a", "feature-b"]);
  });

  it("updates and clears project errors from project_worktrees_updated", async () => {
    const store = await getStore();
    mockEvents.emit("snapshot", {
      worktrees: {
        p1: [
          makeWorktree({
            id: "local",
            projectId: "p1",
            name: "local",
            isLocal: true,
            branch: "local",
            position: 1,
          }),
        ],
      },
      projectErrors: {},
    });

    mockEvents.emit("project_worktrees_updated", {
      projectId: "p1",
      worktrees: [
        makeWorktree({
          id: "local",
          projectId: "p1",
          name: "local",
          isLocal: true,
          branch: "local",
          position: 1,
        }),
      ],
      gitError: "repo unavailable",
    });

    expect(store.useWorktreeStore.getState().projectErrors).toEqual({
      p1: "repo unavailable",
    });

    mockEvents.emit("project_worktrees_updated", {
      projectId: "p1",
      worktrees: [
        makeWorktree({
          id: "local",
          projectId: "p1",
          name: "local",
          isLocal: true,
          branch: "local",
          position: 1,
        }),
      ],
      gitError: null,
    });

    expect(store.useWorktreeStore.getState().projectErrors).toEqual({});
  });

  it("reorder() preserves omitted non-local worktrees", async () => {
    const store = await getStore();
    mockEvents.emit("snapshot", {
      worktrees: {
        p1: [
          makeWorktree({
            id: "local",
            projectId: "p1",
            name: "local",
            isLocal: true,
            branch: "local",
            position: 1,
          }),
          makeWorktree({
            id: "a",
            projectId: "p1",
            name: "feature-a",
            position: 2,
          }),
          makeWorktree({
            id: "b",
            projectId: "p1",
            name: "feature-b",
            position: 3,
          }),
          makeWorktree({
            id: "c",
            projectId: "p1",
            name: "feature-c",
            position: 4,
          }),
        ],
      },
      projectErrors: {},
    });

    await store.useWorktreeStore.getState().reorder("p1", ["c", "a"]);

    expect(
      (store.useWorktreeStore.getState().worktreesByProject.p1 ?? []).map(
        (worktree) => worktree.id,
      ),
    ).toEqual(["local", "c", "a", "b"]);
  });

  it("tracks worktree back and forward navigation", async () => {
    const store = await getStore();
    mockEvents.emit("snapshot", {
      worktrees: {
        p1: [
          makeWorktree({
            id: "local",
            projectId: "p1",
            name: "local",
            isLocal: true,
            position: 1,
          }),
          makeWorktree({
            id: "feature",
            projectId: "p1",
            name: "feature",
            position: 2,
          }),
          makeWorktree({
            id: "release",
            projectId: "p1",
            name: "release",
            position: 3,
          }),
        ],
      },
      projectErrors: {},
    });

    store.useWorktreeStore.getState().select("feature");
    store.useWorktreeStore.getState().select("release");

    expect(store.useWorktreeStore.getState()).toMatchObject({
      navigationBackIds: ["feature", "local"],
      navigationForwardIds: [],
      selectedWorktreeId: "release",
    });

    store.useWorktreeStore.getState().navigateBack();
    expect(store.useWorktreeStore.getState()).toMatchObject({
      navigationBackIds: ["local"],
      navigationForwardIds: ["release"],
      selectedWorktreeId: "feature",
    });

    store.useWorktreeStore.getState().navigateForward();
    expect(store.useWorktreeStore.getState()).toMatchObject({
      navigationBackIds: ["feature", "local"],
      navigationForwardIds: [],
      selectedWorktreeId: "release",
    });
  });

  it("retains workbenches at worktree selection actions", async () => {
    const store = await getStore();
    mockEvents.emit("snapshot", {
      worktrees: {
        p1: [
          makeWorktree({
            id: "local",
            projectId: "p1",
            isLocal: true,
            position: 1,
          }),
          makeWorktree({
            id: "feature",
            projectId: "p1",
            uiMode: "vscode",
            position: 2,
          }),
        ],
      },
      projectErrors: {},
    });

    expect(useHubrisWorkbenchStore.getState().loadedWorktreeIds).toEqual([
      "local",
    ]);

    store.useWorktreeStore.getState().select("feature");

    expect(useVscodeWorkbenchStore.getState().loadedWorktreeIds).toEqual([
      "feature",
    ]);
  });

  it("prunes workbench caches from authoritative worktree events", async () => {
    const store = await getStore();
    mockEvents.emit("snapshot", {
      worktrees: {
        p1: [
          makeWorktree({ id: "local", projectId: "p1", position: 1 }),
          makeWorktree({ id: "feature", projectId: "p1", position: 2 }),
        ],
      },
      projectErrors: {},
    });
    useHubrisWorkbenchStore.getState().markLoaded("feature");
    useVscodeWorkbenchStore.getState().markLoaded("local");
    useVscodeWorkbenchStore.getState().markLoaded("feature");

    mockEvents.emit("project_worktrees_updated", {
      projectId: "p1",
      worktrees: [
        makeWorktree({ id: "feature", projectId: "p1", position: 1 }),
      ],
      gitError: null,
    });

    expect(useHubrisWorkbenchStore.getState().loadedWorktreeIds).toEqual([
      "feature",
    ]);
    // "feature" is hubris-mode, so the vscode cache entry is evicted
    // too: an id may only be cached in its current mode's store.
    expect(useVscodeWorkbenchStore.getState().loadedWorktreeIds).toEqual([]);
    expect(store.useWorktreeStore.getState().selectedWorktreeId).toBe(
      "feature",
    );
  });

  it("evicts the previous mode's cache when uiMode changes", async () => {
    await getStore();
    mockEvents.emit("snapshot", {
      worktrees: {
        p1: [
          makeWorktree({ id: "local", projectId: "p1", position: 1 }),
          makeWorktree({
            id: "feature",
            projectId: "p1",
            position: 2,
            uiMode: "vscode",
          }),
        ],
      },
      projectErrors: {},
    });
    useHubrisWorkbenchStore.getState().markLoaded("local");
    useVscodeWorkbenchStore.getState().markLoaded("feature");

    mockEvents.emit("project_worktrees_updated", {
      projectId: "p1",
      worktrees: [
        makeWorktree({ id: "local", projectId: "p1", position: 1 }),
        makeWorktree({
          id: "feature",
          projectId: "p1",
          position: 2,
          uiMode: "hubris",
        }),
      ],
      gitError: null,
    });

    expect(useHubrisWorkbenchStore.getState().loadedWorktreeIds).toEqual([
      "local",
    ]);
    expect(useVscodeWorkbenchStore.getState().loadedWorktreeIds).toEqual([]);
  });

  it("prunes stale worktree navigation entries after updates", async () => {
    const store = await getStore();
    mockEvents.emit("snapshot", {
      worktrees: {
        p1: [
          makeWorktree({
            id: "local",
            projectId: "p1",
            name: "local",
            isLocal: true,
            position: 1,
          }),
          makeWorktree({
            id: "feature",
            projectId: "p1",
            name: "feature",
            position: 2,
          }),
        ],
      },
      projectErrors: {},
    });
    store.useWorktreeStore.getState().select("feature");

    mockEvents.emit("worktree_deleted", {
      projectId: "p1",
      worktreeId: "local",
    });

    expect(store.useWorktreeStore.getState()).toMatchObject({
      navigationBackIds: [],
      selectedWorktreeId: "feature",
    });
  });

  it("restores navigation state when optimistic worktree remove fails", async () => {
    vi.mocked(deleteProjectWorktree).mockRejectedValueOnce(
      new Error("delete failed"),
    );
    const store = await getStore();
    mockEvents.emit("snapshot", {
      worktrees: {
        p1: [
          makeWorktree({
            id: "local",
            projectId: "p1",
            name: "local",
            isLocal: true,
            position: 1,
          }),
          makeWorktree({
            id: "feature",
            projectId: "p1",
            name: "feature",
            position: 2,
          }),
          makeWorktree({
            id: "release",
            projectId: "p1",
            name: "release",
            position: 3,
          }),
        ],
      },
      projectErrors: {},
    });
    store.useWorktreeStore.getState().select("feature");
    store.useWorktreeStore.getState().select("release");

    await expect(
      store.useWorktreeStore.getState().remove("p1", "release"),
    ).rejects.toThrow("delete failed");

    expect(store.useWorktreeStore.getState()).toMatchObject({
      navigationBackIds: ["feature", "local"],
      navigationForwardIds: [],
      selectedWorktreeId: "release",
    });
    expect(
      (store.useWorktreeStore.getState().worktreesByProject.p1 ?? []).map(
        (worktree) => worktree.id,
      ),
    ).toEqual(["local", "feature", "release"]);
  });

  it("resetWorktreeStoreForTests unsubscribes SSE handlers", () => {
    resetWorktreeStoreForTests();
    initializeWorktreeStore();

    expect(mockEvents.handlerCount("snapshot")).toBe(1);

    resetWorktreeStoreForTests();

    expect(mockEvents.handlerCount("snapshot")).toBe(0);
  });

  it("optimistically updates and persists worktree ui mode", async () => {
    vi.mocked(updateProjectWorktree).mockResolvedValue(
      makeWorktree({
        id: "w1",
        projectId: "p1",
        uiMode: "vscode",
      }),
    );
    const store = await getStore();
    mockEvents.emit("snapshot", {
      worktrees: {
        p1: [
          makeWorktree({
            id: "w1",
            projectId: "p1",
          }),
        ],
      },
      projectErrors: {},
    });

    await store.useWorktreeStore.getState().updateUiMode("p1", "w1", "vscode");

    expect(vi.mocked(updateProjectWorktree)).toHaveBeenCalledWith("p1", "w1", {
      uiMode: "vscode",
    });
    expect(
      store.useWorktreeStore.getState().worktreesByProject.p1?.[0]?.uiMode,
    ).toBe("vscode");
  });
});
