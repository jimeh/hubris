// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandler, SseEventName } from "@/lib/events";
import type { Worktree } from "@/lib/types";
import { updateProjectWorktree } from "@/lib/api";
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
  overrides: Partial<Worktree> & { id: string; project_id: string },
): Worktree {
  return {
    id: overrides.id,
    project_id: overrides.project_id,
    name: overrides.name ?? "worktree",
    path: overrides.path ?? "/tmp/worktree",
    branch: overrides.branch ?? "main",
    source_ref: overrides.source_ref ?? null,
    ui_mode: overrides.ui_mode ?? "hubris",
    is_local: overrides.is_local ?? false,
    missing_on_disk: overrides.missing_on_disk ?? false,
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

    const list = store.useWorktreeStore.getState().worktreesByProject.p1 ?? [];
    expect(
      list.find((worktree) => worktree.id === "missing")?.missing_on_disk,
    ).toBe(true);
  });

  it("replaces and sorts worktrees on project_worktrees_updated", async () => {
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
        ],
      },
      project_errors: {},
    });

    mockEvents.emit("project_worktrees_updated", {
      project_id: "p1",
      worktrees: [
        makeWorktree({
          id: "feature-b",
          project_id: "p1",
          name: "feature-b",
          position: 3,
        }),
        makeWorktree({
          id: "local",
          project_id: "p1",
          name: "local",
          is_local: true,
          branch: "local",
          position: 1,
        }),
        makeWorktree({
          id: "feature-a",
          project_id: "p1",
          name: "feature-a",
          position: 2,
        }),
      ],
      git_error: null,
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
            project_id: "p1",
            name: "local",
            is_local: true,
            branch: "local",
            position: 1,
          }),
        ],
      },
      project_errors: {},
    });

    mockEvents.emit("project_worktrees_updated", {
      project_id: "p1",
      worktrees: [
        makeWorktree({
          id: "local",
          project_id: "p1",
          name: "local",
          is_local: true,
          branch: "local",
          position: 1,
        }),
      ],
      git_error: "repo unavailable",
    });

    expect(store.useWorktreeStore.getState().projectErrors).toEqual({
      p1: "repo unavailable",
    });

    mockEvents.emit("project_worktrees_updated", {
      project_id: "p1",
      worktrees: [
        makeWorktree({
          id: "local",
          project_id: "p1",
          name: "local",
          is_local: true,
          branch: "local",
          position: 1,
        }),
      ],
      git_error: null,
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
            project_id: "p1",
            name: "local",
            is_local: true,
            branch: "local",
            position: 1,
          }),
          makeWorktree({
            id: "a",
            project_id: "p1",
            name: "feature-a",
            position: 2,
          }),
          makeWorktree({
            id: "b",
            project_id: "p1",
            name: "feature-b",
            position: 3,
          }),
          makeWorktree({
            id: "c",
            project_id: "p1",
            name: "feature-c",
            position: 4,
          }),
        ],
      },
      project_errors: {},
    });

    await store.useWorktreeStore.getState().reorder("p1", ["c", "a"]);

    expect(
      (store.useWorktreeStore.getState().worktreesByProject.p1 ?? []).map(
        (worktree) => worktree.id,
      ),
    ).toEqual(["local", "c", "a", "b"]);
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
        project_id: "p1",
        ui_mode: "vscode",
      }),
    );
    const store = await getStore();
    mockEvents.emit("snapshot", {
      worktrees: {
        p1: [
          makeWorktree({
            id: "w1",
            project_id: "p1",
          }),
        ],
      },
      project_errors: {},
    });

    await store.useWorktreeStore.getState().updateUiMode("p1", "w1", "vscode");

    expect(vi.mocked(updateProjectWorktree)).toHaveBeenCalledWith("p1", "w1", {
      ui_mode: "vscode",
    });
    expect(
      store.useWorktreeStore.getState().worktreesByProject.p1?.[0]?.ui_mode,
    ).toBe("vscode");
  });
});
