// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListProjectWorktreeFiles = vi.fn();
const mockGetProjectWorktreeGitStatus = vi.fn();
const mockRenameProjectWorktreeFile = vi.fn();

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

vi.mock("@/lib/events", () => ({
  getEventClient: () => ({
    on: vi.fn(() => () => {}),
  }),
}));

async function getStore() {
  const mod = await import("./worktreeFileManager");
  mod.resetWorktreeFileManagerStoreForTests();
  return mod.useWorktreeFileManagerStore;
}

describe("worktree file manager store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
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

  it("refreshes expanded paths and then rehydrates visible descendant preload", async () => {
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

    await store.getState().refreshVisiblePaths("p1", "w1", { force: true });

    expect(mockGetProjectWorktreeGitStatus).toHaveBeenCalledWith("p1", "w1");
    expect(mockListProjectWorktreeFiles.mock.calls).toEqual([
      ["p1", "w1", ""],
      ["p1", "w1", "src"],
      ["p1", "w1", ""],
      ["p1", "w1", "src"],
      ["p1", "w1", "src/nested"],
    ]);
  });
});
