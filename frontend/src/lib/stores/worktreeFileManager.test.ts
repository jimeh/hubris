// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandler, SseEventData, SseEventName } from "@/lib/events";

const mockListProjectWorktreeFiles = vi.fn();
const mockGetProjectWorktreeGitStatus = vi.fn();
const mockRenameProjectWorktreeFile = vi.fn();
const eventHandlers = new Map<SseEventName, Set<EventHandler<unknown>>>();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    listProjectWorktreeFiles: (...args: unknown[]) =>
      mockListProjectWorktreeFiles(...args),
    getProjectWorktreeGitStatus: (...args: unknown[]) =>
      mockGetProjectWorktreeGitStatus(...args),
    renameProjectWorktreeFile: (...args: unknown[]) =>
      mockRenameProjectWorktreeFile(...args),
  };
});

vi.mock("@/lib/events", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/events")>("@/lib/events");
  return {
    ...actual,
    getEventClient: () => ({
      on: vi.fn(
        <K extends SseEventName>(
          event: K,
          handler: EventHandler<SseEventData<K>>,
        ) => {
          const bucket =
            eventHandlers.get(event) ?? new Set<EventHandler<unknown>>();
          bucket.add(handler as EventHandler<unknown>);
          eventHandlers.set(event, bucket);
          return () => bucket.delete(handler as EventHandler<unknown>);
        },
      ),
    }),
  };
});

function emitEvent<K extends SseEventName>(
  event: K,
  payload: SseEventData<K>,
): void {
  for (const handler of eventHandlers.get(event) ?? []) {
    (handler as EventHandler<SseEventData<K>>)(payload);
  }
}

async function getStore() {
  const mod = await import("./worktreeFileManager");
  mod.initializeWorktreeFileManagerStore();
  mod.resetWorktreeFileManagerStoreForTests();
  mod.initializeWorktreeFileManagerStore();
  return mod.useWorktreeFileManagerStore;
}

describe("worktree file manager store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    eventHandlers.clear();
    mockListProjectWorktreeFiles.mockReset();
    mockGetProjectWorktreeGitStatus.mockReset();
    mockRenameProjectWorktreeFile.mockReset();
    mockGetProjectWorktreeGitStatus.mockResolvedValue({
      generation: 1,
      source_ref: "main",
      unstaged_files: [],
      staged_files: [],
      ahead_count: 0,
      ahead_commits: [],
      comparison_available: true,
      comparison_error: null,
    });
  });

  it("preloads root descendant directories after the root directory is loaded", async () => {
    const store = await getStore();
    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "src") {
          return {
            generation: 1,
            path: "src",
            entries: [{ name: "lib.rs", path: "src/lib.rs", kind: "file" }],
          };
        }
        return {
          generation: 1,
          path: "",
          entries: [
            { name: "src", path: "src", kind: "directory" },
            { name: "README.md", path: "README.md", kind: "file" },
          ],
        };
      },
    );

    await store.getState().loadDirectory("p1", "w1", "");
    await store.getState().preloadVisibleDirectories("p1", "w1");

    expect(mockListProjectWorktreeFiles.mock.calls).toEqual([
      ["p1", "w1", ""],
      ["p1", "w1", "src"],
    ]);
  });

  it("preloads newly visible descendant directories under expanded folders", async () => {
    const store = await getStore();
    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "src") {
          return {
            generation: 1,
            path: "src",
            entries: [
              {
                name: "nested",
                path: "src/nested",
                kind: "directory",
              },
              { name: "lib.rs", path: "src/lib.rs", kind: "file" },
            ],
          };
        }
        if (path === "src/nested") {
          return {
            generation: 1,
            path: "src/nested",
            entries: [
              {
                name: "deep.txt",
                path: "src/nested/deep.txt",
                kind: "file",
              },
            ],
          };
        }
        return {
          generation: 1,
          path: "",
          entries: [{ name: "src", path: "src", kind: "directory" }],
        };
      },
    );

    await store.getState().loadDirectory("p1", "w1", "");
    await store.getState().preloadVisibleDirectories("p1", "w1");

    store.getState().setExpanded("w1", "src", true);
    await store.getState().preloadVisibleDirectories("p1", "w1");

    expect(mockListProjectWorktreeFiles.mock.calls).toEqual([
      ["p1", "w1", ""],
      ["p1", "w1", "src"],
      ["p1", "w1", "src/nested"],
    ]);
  });

  it("skips noisy directories during preload but still loads them on manual open", async () => {
    const store = await getStore();
    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "src") {
          return {
            generation: 1,
            path: "src",
            entries: [{ name: "lib.rs", path: "src/lib.rs", kind: "file" }],
          };
        }
        if (path === "node_modules") {
          return {
            generation: 1,
            path: "node_modules",
            entries: [
              {
                name: "package.json",
                path: "node_modules/package.json",
                kind: "file",
              },
            ],
          };
        }
        return {
          generation: 1,
          path: "",
          entries: [
            { name: "src", path: "src", kind: "directory" },
            {
              name: "node_modules",
              path: "node_modules",
              kind: "directory",
            },
          ],
        };
      },
    );

    await store.getState().loadDirectory("p1", "w1", "");
    await store.getState().preloadVisibleDirectories("p1", "w1");

    expect(mockListProjectWorktreeFiles.mock.calls).toEqual([
      ["p1", "w1", ""],
      ["p1", "w1", "src"],
    ]);

    await store.getState().loadDirectory("p1", "w1", "node_modules");

    expect(mockListProjectWorktreeFiles.mock.calls).toEqual([
      ["p1", "w1", ""],
      ["p1", "w1", "src"],
      ["p1", "w1", "node_modules"],
    ]);
  });

  it("reuses cached directory data instead of issuing duplicate preload requests", async () => {
    const store = await getStore();
    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "src") {
          return {
            generation: 1,
            path: "src",
            entries: [{ name: "lib.rs", path: "src/lib.rs", kind: "file" }],
          };
        }
        return {
          generation: 1,
          path: "",
          entries: [{ name: "src", path: "src", kind: "directory" }],
        };
      },
    );

    await store.getState().loadDirectory("p1", "w1", "");
    await store.getState().preloadVisibleDirectories("p1", "w1");
    await store.getState().preloadVisibleDirectories("p1", "w1");

    expect(mockListProjectWorktreeFiles.mock.calls).toEqual([
      ["p1", "w1", ""],
      ["p1", "w1", "src"],
    ]);
  });

  it("refreshes only affected visible directories and rehydrates visible descendant preload", async () => {
    const store = await getStore();
    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "src") {
          return {
            generation: 2,
            path: "src",
            entries: [
              {
                name: "nested",
                path: "src/nested",
                kind: "directory",
              },
            ],
          };
        }
        if (path === "src/nested") {
          return {
            generation: 2,
            path: "src/nested",
            entries: [
              {
                name: "deep.txt",
                path: "src/nested/deep.txt",
                kind: "file",
              },
            ],
          };
        }
        return {
          generation: 2,
          path: "",
          entries: [{ name: "src", path: "src", kind: "directory" }],
        };
      },
    );

    await store.getState().loadDirectory("p1", "w1", "");
    await store.getState().preloadVisibleDirectories("p1", "w1");
    store.getState().setExpanded("w1", "src", true);
    emitEvent("worktree_files_updated", {
      project_id: "p1",
      worktree_id: "w1",
      generation: 2,
      paths: ["", "src", "src/nested"],
    });

    await store.getState().refreshPendingPaths("p1", "w1");

    expect(mockGetProjectWorktreeGitStatus).toHaveBeenCalledWith("p1", "w1");
    expect(mockListProjectWorktreeFiles.mock.calls).toEqual([
      ["p1", "w1", ""],
      ["p1", "w1", "src"],
      ["p1", "w1", ""],
      ["p1", "w1", "src"],
      ["p1", "w1", "src/nested"],
    ]);
  });

  it("marks collapsed loaded directories stale and refetches them on the next expand", async () => {
    const store = await getStore();
    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "src") {
          return {
            generation: 1,
            path: "src",
            entries: [
              {
                name: "nested",
                path: "src/nested",
                kind: "directory",
              },
            ],
          };
        }
        if (path === "src/nested") {
          return {
            generation: 1,
            path: "src/nested",
            entries: [
              {
                name: "before.txt",
                path: "src/nested/before.txt",
                kind: "file",
              },
            ],
          };
        }
        return {
          generation: 1,
          path: "",
          entries: [{ name: "src", path: "src", kind: "directory" }],
        };
      },
    );

    await store.getState().loadDirectory("p1", "w1", "");
    await store.getState().loadDirectory("p1", "w1", "src");
    await store.getState().loadDirectory("p1", "w1", "src/nested");

    emitEvent("worktree_files_updated", {
      project_id: "p1",
      worktree_id: "w1",
      generation: 2,
      paths: ["src/nested", "src/nested/watch-me.txt"],
    });

    const afterEvent = store.getState().worktrees["w1"];
    expect(afterEvent?.directories["src/nested"]?.stale).toBe(true);

    mockListProjectWorktreeFiles.mockResolvedValueOnce({
      generation: 2,
      path: "src/nested",
      entries: [
        {
          name: "after.txt",
          path: "src/nested/after.txt",
          kind: "file",
        },
      ],
    });

    await store.getState().loadDirectory("p1", "w1", "src/nested");

    const afterReload = store.getState().worktrees["w1"];
    expect(afterReload?.directories["src/nested"]?.stale).toBe(false);
    expect(afterReload?.directories["src/nested"]?.entries).toEqual([
      {
        name: "after.txt",
        path: "src/nested/after.txt",
        kind: "file",
      },
    ]);
  });

  it("keeps unaffected visible directories in place during targeted invalidation", async () => {
    const store = await getStore();
    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "src") {
          return {
            generation: 1,
            path: "src",
            entries: [{ name: "lib.rs", path: "src/lib.rs", kind: "file" }],
          };
        }
        if (path === "docs") {
          return {
            generation: 1,
            path: "docs",
            entries: [
              { name: "intro.md", path: "docs/intro.md", kind: "file" },
            ],
          };
        }
        return {
          generation: 1,
          path: "",
          entries: [
            { name: "src", path: "src", kind: "directory" },
            { name: "docs", path: "docs", kind: "directory" },
          ],
        };
      },
    );

    await store.getState().loadDirectory("p1", "w1", "");
    await store.getState().loadDirectory("p1", "w1", "src");
    await store.getState().loadDirectory("p1", "w1", "docs");
    store.getState().setExpanded("w1", "src", true);
    store.getState().setExpanded("w1", "docs", true);

    emitEvent("worktree_files_updated", {
      project_id: "p1",
      worktree_id: "w1",
      generation: 2,
      paths: ["src/lib.rs", "src"],
    });

    expect(store.getState().worktrees["w1"]?.directories["src"]?.stale).toBe(
      true,
    );
    expect(store.getState().worktrees["w1"]?.directories["docs"]?.stale).toBe(
      false,
    );

    mockListProjectWorktreeFiles.mockResolvedValueOnce({
      generation: 2,
      path: "src",
      entries: [{ name: "main.rs", path: "src/main.rs", kind: "file" }],
    });

    await store.getState().refreshPendingPaths("p1", "w1");

    expect(mockListProjectWorktreeFiles.mock.calls).toEqual([
      ["p1", "w1", ""],
      ["p1", "w1", "src"],
      ["p1", "w1", "docs"],
      ["p1", "w1", "src"],
    ]);
    expect(
      store.getState().worktrees["w1"]?.directories["docs"]?.entries,
    ).toEqual([
      {
        name: "intro.md",
        path: "docs/intro.md",
        kind: "file",
      },
    ]);
  });

  it("tracks git-only watcher invalidation without staling directories", async () => {
    const store = await getStore();
    mockListProjectWorktreeFiles.mockResolvedValue({
      generation: 1,
      path: "",
      entries: [{ name: "src", path: "src", kind: "directory" }],
    });

    await store.getState().loadDirectory("p1", "w1", "");

    emitEvent("worktree_git_status_updated", {
      project_id: "p1",
      worktree_id: "w1",
      generation: 3,
    });

    const next = store.getState().worktrees["w1"];
    expect(next?.pendingGitGeneration).toBe(3);
    expect(next?.pendingGeneration).toBe(0);
    expect(next?.directories[""]?.stale).toBe(false);
  });

  it("clears pending git invalidation after a fresh git status reload", async () => {
    const store = await getStore();
    mockGetProjectWorktreeGitStatus.mockResolvedValueOnce({
      generation: 3,
      source_ref: "main",
      unstaged_files: [],
      staged_files: [],
      ahead_count: 0,
      ahead_commits: [],
      comparison_available: true,
      comparison_error: null,
    });

    emitEvent("worktree_git_status_updated", {
      project_id: "p1",
      worktree_id: "w1",
      generation: 3,
    });

    await store.getState().loadGitStatus("p1", "w1");

    const next = store.getState().worktrees["w1"];
    expect(next?.gitStatus?.generation).toBe(3);
    expect(next?.pendingGitGeneration).toBe(0);
  });

  it("retries a transient 404 once before keeping a directory loaded", async () => {
    vi.useFakeTimers();
    const store = await getStore();
    const { ApiStatusError } = await import("@/lib/api");

    mockListProjectWorktreeFiles.mockResolvedValueOnce({
      generation: 1,
      path: "",
      entries: [{ name: "src", path: "src", kind: "directory" }],
    });
    await store.getState().loadDirectory("p1", "w1", "");

    mockListProjectWorktreeFiles
      .mockRejectedValueOnce(new ApiStatusError(404, "Directory not found"))
      .mockResolvedValueOnce({
        generation: 2,
        path: "src",
        entries: [{ name: "main.rs", path: "src/main.rs", kind: "file" }],
      });

    const loadPromise = store.getState().loadDirectory("p1", "w1", "src");
    await vi.advanceTimersByTimeAsync(500);
    await loadPromise;

    expect(mockListProjectWorktreeFiles.mock.calls).toEqual([
      ["p1", "w1", ""],
      ["p1", "w1", "src"],
      ["p1", "w1", "src"],
    ]);
    expect(store.getState().worktrees["w1"]?.directories["src"]).toMatchObject({
      status: "loaded",
      stale: false,
      entries: [{ name: "main.rs", path: "src/main.rs", kind: "file" }],
    });
  });

  it("removes a directory entry after a second 404 confirms it is gone", async () => {
    vi.useFakeTimers();
    const store = await getStore();
    const { ApiStatusError } = await import("@/lib/api");

    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "src") {
          return {
            generation: 1,
            path: "src",
            entries: [
              {
                name: "nested",
                path: "src/nested",
                kind: "directory",
              },
            ],
          };
        }
        if (path === "src/nested") {
          return {
            generation: 1,
            path: "src/nested",
            entries: [
              {
                name: "before.txt",
                path: "src/nested/before.txt",
                kind: "file",
              },
            ],
          };
        }
        return {
          generation: 1,
          path: "",
          entries: [{ name: "src", path: "src", kind: "directory" }],
        };
      },
    );

    await store.getState().loadDirectory("p1", "w1", "");
    await store.getState().loadDirectory("p1", "w1", "src");
    await store.getState().loadDirectory("p1", "w1", "src/nested");
    store.getState().setExpanded("w1", "src", true);
    store.getState().setExpanded("w1", "src/nested", true);
    store.getState().setSelectedPath("w1", "src/nested/before.txt");
    store.getState().setRenamePath("w1", "src/nested");

    mockListProjectWorktreeFiles.mockReset();
    mockListProjectWorktreeFiles
      .mockRejectedValueOnce(new ApiStatusError(404, "Directory not found"))
      .mockRejectedValueOnce(new ApiStatusError(404, "Directory not found"));

    const loadPromise = store
      .getState()
      .loadDirectory("p1", "w1", "src", { force: true });
    await vi.advanceTimersByTimeAsync(500);
    await loadPromise;

    const next = store.getState().worktrees["w1"];
    expect(next?.directories[""]).toMatchObject({
      entries: [],
    });
    expect(next?.directories["src"]).toBeUndefined();
    expect(next?.directories["src/nested"]).toBeUndefined();
    expect(next?.expandedPaths).toEqual([]);
    expect(next?.selectedPath).toBeNull();
    expect(next?.renamePath).toBeNull();
    expect(next?.pendingPaths).toEqual([]);
    expect(mockListProjectWorktreeFiles.mock.calls).toEqual([
      ["p1", "w1", "src"],
      ["p1", "w1", "src"],
    ]);
  });
});
