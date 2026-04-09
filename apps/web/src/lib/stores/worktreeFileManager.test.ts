// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandler, SseEventData, SseEventName } from "@/lib/events";
import { ApiStatusError } from "@/lib/api";
import {
  initializeWorktreeFileManagerStore,
  resetWorktreeFileManagerStoreForTests,
  useWorktreeFileManagerStore,
} from "./worktreeFileManager";

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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function getStore() {
  initializeWorktreeFileManagerStore();
  resetWorktreeFileManagerStoreForTests();
  initializeWorktreeFileManagerStore();
  return useWorktreeFileManagerStore;
}

describe("worktree file manager store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

  it("uses loading-initial for a first directory load", async () => {
    const store = await getStore();
    const listing = createDeferred<{
      generation: number;
      path: string;
      entries: Array<{
        name: string;
        path: string;
        kind: "file" | "directory";
      }>;
    }>();

    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "") {
          return listing.promise;
        }
        return { generation: 1, path, entries: [] };
      },
    );

    const loadPromise = store.getState().loadDirectory("p1", "w1", "");

    expect(store.getState().worktrees["w1"]?.directories[""]?.status).toBe(
      "loading-initial",
    );

    listing.resolve({
      generation: 1,
      path: "",
      entries: [],
    });
    await loadPromise;

    expect(store.getState().worktrees["w1"]?.directories[""]?.status).toBe(
      "loaded",
    );
  });

  it("uses loading-refresh and preserves cached entries during refresh", async () => {
    const store = await getStore();
    const refreshListing = createDeferred<{
      generation: number;
      path: string;
      entries: Array<{
        name: string;
        path: string;
        kind: "file" | "directory";
      }>;
    }>();

    mockListProjectWorktreeFiles
      .mockResolvedValueOnce({
        generation: 1,
        path: "",
        entries: [{ name: "src", path: "src", kind: "directory" }],
      })
      .mockResolvedValueOnce({
        generation: 1,
        path: "src",
        entries: [{ name: "before.txt", path: "src/before.txt", kind: "file" }],
      })
      .mockImplementationOnce(async () => refreshListing.promise);

    await store.getState().loadDirectory("p1", "w1", "");
    await store.getState().loadDirectory("p1", "w1", "src");

    const refreshPromise = store
      .getState()
      .loadDirectory("p1", "w1", "src", { force: true });

    expect(store.getState().worktrees["w1"]?.directories["src"]).toMatchObject({
      status: "loading-refresh",
      entries: [{ name: "before.txt", path: "src/before.txt", kind: "file" }],
    });

    refreshListing.resolve({
      generation: 2,
      path: "src",
      entries: [{ name: "after.txt", path: "src/after.txt", kind: "file" }],
    });
    await refreshPromise;

    expect(store.getState().worktrees["w1"]?.directories["src"]).toMatchObject({
      status: "loaded",
      entries: [{ name: "after.txt", path: "src/after.txt", kind: "file" }],
    });
  });

  it("uses error-refresh and preserves cached entries when refresh fails", async () => {
    const store = await getStore();

    mockListProjectWorktreeFiles
      .mockResolvedValueOnce({
        generation: 1,
        path: "",
        entries: [{ name: "empty", path: "empty", kind: "directory" }],
      })
      .mockResolvedValueOnce({
        generation: 1,
        path: "empty",
        entries: [],
      })
      .mockRejectedValueOnce(new Error("refresh failed"));

    await store.getState().loadDirectory("p1", "w1", "");
    await store.getState().loadDirectory("p1", "w1", "empty");
    await store.getState().loadDirectory("p1", "w1", "empty", { force: true });

    expect(
      store.getState().worktrees["w1"]?.directories["empty"],
    ).toMatchObject({
      status: "error-refresh",
      entries: [],
      error: "refresh failed",
    });
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
      changed_paths: ["src/nested"],
      listing_paths: ["", "src"],
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
      changed_paths: ["src/nested", "src/nested/watch-me.txt"],
      listing_paths: ["src/nested"],
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
      changed_paths: ["src/lib.rs"],
      listing_paths: ["src"],
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

  it("refreshes only the parent listing for nested file renames", async () => {
    const store = await getStore();
    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "tmp2") {
          return {
            generation: 1,
            path: "tmp2",
            entries: [
              { name: "bar.txt", path: "tmp2/bar.txt", kind: "file" },
              { name: "nested", path: "tmp2/nested", kind: "directory" },
            ],
          };
        }
        if (path === "tmp2/nested") {
          return {
            generation: 1,
            path: "tmp2/nested",
            entries: [
              { name: "deep.txt", path: "tmp2/nested/deep.txt", kind: "file" },
            ],
          };
        }
        return {
          generation: 1,
          path: "",
          entries: [{ name: "tmp2", path: "tmp2", kind: "directory" }],
        };
      },
    );

    await store.getState().loadDirectory("p1", "w1", "");
    await store.getState().loadDirectory("p1", "w1", "tmp2");
    await store.getState().loadDirectory("p1", "w1", "tmp2/nested");
    store.getState().setExpanded("w1", "tmp2", true);
    store.getState().setExpanded("w1", "tmp2/nested", true);

    emitEvent("worktree_files_updated", {
      project_id: "p1",
      worktree_id: "w1",
      generation: 2,
      changed_paths: ["tmp2/bar.txt", "tmp2/bar2.txt"],
      listing_paths: ["tmp2"],
    });

    expect(store.getState().worktrees["w1"]?.directories["tmp2"]?.stale).toBe(
      true,
    );
    expect(
      store.getState().worktrees["w1"]?.directories["tmp2/nested"]?.stale,
    ).toBe(false);

    mockListProjectWorktreeFiles.mockResolvedValueOnce({
      generation: 2,
      path: "tmp2",
      entries: [
        { name: "bar2.txt", path: "tmp2/bar2.txt", kind: "file" },
        { name: "nested", path: "tmp2/nested", kind: "directory" },
      ],
    });

    await store.getState().refreshPendingPaths("p1", "w1");

    expect(mockListProjectWorktreeFiles.mock.calls).toEqual([
      ["p1", "w1", ""],
      ["p1", "w1", "tmp2"],
      ["p1", "w1", "tmp2/nested"],
      ["p1", "w1", "tmp2"],
    ]);
    expect(
      store.getState().worktrees["w1"]?.directories["tmp2/nested"]?.entries,
    ).toEqual([
      {
        name: "deep.txt",
        path: "tmp2/nested/deep.txt",
        kind: "file",
      },
    ]);
  });

  it("prunes removed direct child subtrees when a parent listing refreshes", async () => {
    const store = await getStore();
    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "tmp2") {
          return {
            generation: 1,
            path: "tmp2",
            entries: [
              { name: "stuff", path: "tmp2/stuff", kind: "directory" },
              { name: "keep", path: "tmp2/keep", kind: "directory" },
            ],
          };
        }
        if (path === "tmp2/stuff") {
          return {
            generation: 1,
            path: "tmp2/stuff",
            entries: [
              {
                name: "gone.txt",
                path: "tmp2/stuff/gone.txt",
                kind: "file",
              },
            ],
          };
        }
        if (path === "tmp2/keep") {
          return {
            generation: 1,
            path: "tmp2/keep",
            entries: [
              {
                name: "stay.txt",
                path: "tmp2/keep/stay.txt",
                kind: "file",
              },
            ],
          };
        }
        return {
          generation: 1,
          path: "",
          entries: [{ name: "tmp2", path: "tmp2", kind: "directory" }],
        };
      },
    );

    await store.getState().loadDirectory("p1", "w1", "");
    await store.getState().loadDirectory("p1", "w1", "tmp2");
    await store.getState().loadDirectory("p1", "w1", "tmp2/stuff");
    await store.getState().loadDirectory("p1", "w1", "tmp2/keep");
    store.getState().setExpanded("w1", "tmp2", true);
    store.getState().setExpanded("w1", "tmp2/stuff", true);
    store.getState().setExpanded("w1", "tmp2/keep", true);
    store.getState().setSelectedPath("w1", "tmp2/stuff/gone.txt");

    emitEvent("worktree_files_updated", {
      project_id: "p1",
      worktree_id: "w1",
      generation: 2,
      changed_paths: ["tmp2/stuff", "tmp2/stuff-old"],
      listing_paths: ["tmp2"],
    });

    mockListProjectWorktreeFiles.mockReset();
    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "tmp2") {
          return {
            generation: 2,
            path: "tmp2",
            entries: [
              { name: "stuff-old", path: "tmp2/stuff-old", kind: "directory" },
              { name: "keep", path: "tmp2/keep", kind: "directory" },
            ],
          };
        }
        if (path === "tmp2/stuff") {
          throw new ApiStatusError(404, "Directory not found");
        }
        if (path === "tmp2/keep") {
          return {
            generation: 2,
            path: "tmp2/keep",
            entries: [
              {
                name: "stay.txt",
                path: "tmp2/keep/stay.txt",
                kind: "file",
              },
            ],
          };
        }
        if (path === "tmp2/stuff-old") {
          return {
            generation: 2,
            path: "tmp2/stuff-old",
            entries: [],
          };
        }
        return {
          generation: 2,
          path,
          entries: [],
        };
      },
    );

    await store.getState().refreshPendingPaths("p1", "w1");

    const next = store.getState().worktrees["w1"];
    expect(next?.directories["tmp2/stuff"]).toBeUndefined();
    expect(next?.directories["tmp2/keep"]).toMatchObject({
      entries: [{ name: "stay.txt", path: "tmp2/keep/stay.txt", kind: "file" }],
    });
    expect(next?.selectedPath).toBeNull();
    expect(next?.expandedPaths).toEqual(["tmp2", "tmp2/keep"]);
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
    expect(next?.pendingChangedPaths).toEqual([]);
    expect(next?.pendingListingPaths).toEqual([]);
    expect(mockListProjectWorktreeFiles.mock.calls).toEqual([
      ["p1", "w1", "src"],
      ["p1", "w1", "src"],
    ]);
  });
});
