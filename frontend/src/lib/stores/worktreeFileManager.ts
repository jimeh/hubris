import { create } from "zustand";
import {
  ApiStatusError,
  getProjectWorktreeGitStatus,
  listProjectWorktreeFiles,
  renameProjectWorktreeFile,
  type WorktreeFile,
  type WorktreeGitStatus,
} from "@/lib/api";
import { getEventClient } from "@/lib/events";

type RequestStatus = "idle" | "loading" | "loaded" | "error";
type DirectoryRequestStatus =
  | "idle"
  | "loading-initial"
  | "loading-refresh"
  | "loaded"
  | "error-initial"
  | "error-refresh";

type DirectoryState = {
  status: DirectoryRequestStatus;
  generation: number;
  entries: WorktreeFile[];
  error: string | null;
  stale: boolean;
};

type WorktreeFileManagerSlice = {
  directories: Record<string, DirectoryState>;
  expandedPaths: string[];
  selectedPath: string | null;
  renamePath: string | null;
  gitStatus: WorktreeGitStatus | null;
  gitStatusStatus: RequestStatus;
  gitError: string | null;
  pendingGeneration: number;
  pendingGitGeneration: number;
  pendingChangedPaths: string[];
  pendingListingPaths: string[];
};

type LoadOptions = {
  force?: boolean;
};

const DIRECTORY_NOT_FOUND_RETRY_DELAY_MS = 500;

const PRELOAD_SKIP_DIRECTORY_NAMES = new Set([
  "node_modules",
  "tmp",
  "temp",
  "dist",
  "build",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
]);

type WorktreeFileManagerState = {
  worktrees: Record<string, WorktreeFileManagerSlice>;
  setExpanded: (worktreeId: string, path: string, expanded: boolean) => void;
  setSelectedPath: (worktreeId: string, path: string | null) => void;
  setRenamePath: (worktreeId: string, path: string | null) => void;
  loadDirectory: (
    projectId: string,
    worktreeId: string,
    path: string,
    options?: LoadOptions,
  ) => Promise<void>;
  loadGitStatus: (
    projectId: string,
    worktreeId: string,
    options?: LoadOptions,
  ) => Promise<void>;
  preloadVisibleDirectories: (
    projectId: string,
    worktreeId: string,
  ) => Promise<void>;
  refreshPendingPaths: (projectId: string, worktreeId: string) => Promise<void>;
  refreshPaths: (
    projectId: string,
    worktreeId: string,
    paths: string[],
  ) => Promise<void>;
  refreshVisiblePaths: (
    projectId: string,
    worktreeId: string,
    options?: LoadOptions,
  ) => Promise<void>;
  renameEntry: (
    projectId: string,
    worktreeId: string,
    path: string,
    newName: string,
  ) => Promise<string>;
};

function createDirectoryState(): DirectoryState {
  return {
    status: "idle",
    generation: 0,
    entries: [],
    error: null,
    stale: false,
  };
}

function hasLoadedDirectoryContents(directory: DirectoryState): boolean {
  return directory.generation > 0;
}

function isDirectoryLoading(status: DirectoryRequestStatus): boolean {
  return status === "loading-initial" || status === "loading-refresh";
}

function createWorktreeSlice(): WorktreeFileManagerSlice {
  return {
    directories: {},
    expandedPaths: [],
    selectedPath: null,
    renamePath: null,
    gitStatus: null,
    gitStatusStatus: "idle",
    gitError: null,
    pendingGeneration: 0,
    pendingGitGeneration: 0,
    pendingChangedPaths: [],
    pendingListingPaths: [],
  };
}

function getSlice(
  worktrees: Record<string, WorktreeFileManagerSlice>,
  worktreeId: string,
): WorktreeFileManagerSlice {
  return worktrees[worktreeId] ?? createWorktreeSlice();
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function normalizePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function parentPath(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  if (index === -1) {
    return "";
  }
  return normalized.slice(0, index);
}

function baseName(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized) {
    return "";
  }
  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? "";
}

function shouldSkipPreloadDirectory(name: string): boolean {
  return PRELOAD_SKIP_DIRECTORY_NAMES.has(name);
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof ApiStatusError && error.status === 404;
}

function isSubpath(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

function markDirectoriesStale(
  slice: WorktreeFileManagerSlice,
  listingPaths: string[],
  changedPaths: string[],
): Record<string, DirectoryState> {
  const stalePaths = new Set([
    ...listingPaths.map(normalizePath),
    ...changedPaths
      .map(normalizePath)
      .filter((path) => path === "" || path in slice.directories),
  ]);

  if (stalePaths.size === 0) {
    return slice.directories;
  }

  const nextDirectories: Record<string, DirectoryState> = {};
  for (const [path, directory] of Object.entries(slice.directories)) {
    nextDirectories[path] =
      hasLoadedDirectoryContents(directory) && stalePaths.has(path)
        ? {
            ...directory,
            stale: true,
          }
        : directory;
  }
  return nextDirectories;
}

function mergePendingPaths(existing: string[], next: string[]): string[] {
  return uniquePaths([...existing, ...next.map(normalizePath)]);
}

function pruneRemovedPaths(
  slice: WorktreeFileManagerSlice,
  removedPaths: string[],
): WorktreeFileManagerSlice {
  return removedPaths.reduce((nextSlice, removedPath) => {
    if (!removedPath) {
      return nextSlice;
    }
    return pruneMissingDirectory(nextSlice, removedPath);
  }, slice);
}

function reconcileDirectoryEntries(
  slice: WorktreeFileManagerSlice,
  directoryPath: string,
  nextEntries: WorktreeFile[],
): WorktreeFileManagerSlice {
  const previousDirectory = slice.directories[directoryPath];
  if (!previousDirectory) {
    return slice;
  }

  const nextEntryPaths = new Set(nextEntries.map((entry) => entry.path));
  const removedPaths = previousDirectory.entries
    .map((entry) => entry.path)
    .filter((path) => !nextEntryPaths.has(path));

  if (removedPaths.length === 0) {
    return slice;
  }

  return pruneRemovedPaths(slice, removedPaths);
}

function getVisiblePaths(
  slice: WorktreeFileManagerSlice,
  predicate?: (directory: DirectoryState, path: string) => boolean,
): string[] {
  return uniquePaths(
    ["", ...slice.expandedPaths].filter((path) => {
      const directory = slice.directories[path];
      if (path !== "" && !directory) {
        return false;
      }
      return predicate
        ? predicate(directory ?? createDirectoryState(), path)
        : true;
    }),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function listDirectoryWithNotFoundRetry(
  projectId: string,
  worktreeId: string,
  path: string,
): Promise<Awaited<ReturnType<typeof listProjectWorktreeFiles>>> {
  try {
    return await listProjectWorktreeFiles(projectId, worktreeId, path);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    await delay(DIRECTORY_NOT_FOUND_RETRY_DELAY_MS);
    return listProjectWorktreeFiles(projectId, worktreeId, path);
  }
}

function pruneMissingDirectory(
  slice: WorktreeFileManagerSlice,
  missingPath: string,
): WorktreeFileManagerSlice {
  if (!missingPath) {
    return slice;
  }

  const parent = parentPath(missingPath);
  const nextDirectories = Object.fromEntries(
    Object.entries(slice.directories).filter(
      ([path]) => !isSubpath(path, missingPath),
    ),
  );
  const parentDirectory = nextDirectories[parent];
  if (parentDirectory?.status === "loaded") {
    nextDirectories[parent] = {
      ...parentDirectory,
      entries: parentDirectory.entries.filter(
        (entry) => entry.path !== missingPath,
      ),
    };
  }

  const shouldClearPath = (path: string | null): path is string =>
    path !== null && isSubpath(path, missingPath);

  return {
    ...slice,
    directories: nextDirectories,
    expandedPaths: slice.expandedPaths.filter(
      (path) => !isSubpath(path, missingPath),
    ),
    selectedPath: shouldClearPath(slice.selectedPath)
      ? null
      : slice.selectedPath,
    renamePath: shouldClearPath(slice.renamePath) ? null : slice.renamePath,
    pendingChangedPaths: slice.pendingChangedPaths.filter(
      (path) => !isSubpath(path, missingPath),
    ),
    pendingListingPaths: slice.pendingListingPaths.filter(
      (path) => !isSubpath(path, missingPath),
    ),
  };
}

export const useWorktreeFileManagerStore = create<WorktreeFileManagerState>(
  (set, get) => ({
    worktrees: {},
    setExpanded(worktreeId, path, expanded) {
      const normalizedPath = normalizePath(path);
      set((state) => {
        const current = getSlice(state.worktrees, worktreeId);
        const nextExpandedPaths = expanded
          ? uniquePaths([...current.expandedPaths, normalizedPath])
          : current.expandedPaths.filter((value) => value !== normalizedPath);
        return {
          worktrees: {
            ...state.worktrees,
            [worktreeId]: {
              ...current,
              expandedPaths: nextExpandedPaths,
            },
          },
        };
      });
    },
    setSelectedPath(worktreeId, path) {
      set((state) => {
        const current = getSlice(state.worktrees, worktreeId);
        return {
          worktrees: {
            ...state.worktrees,
            [worktreeId]: {
              ...current,
              selectedPath: path,
            },
          },
        };
      });
    },
    setRenamePath(worktreeId, path) {
      set((state) => {
        const current = getSlice(state.worktrees, worktreeId);
        return {
          worktrees: {
            ...state.worktrees,
            [worktreeId]: {
              ...current,
              renamePath: path,
            },
          },
        };
      });
    },
    async loadDirectory(projectId, worktreeId, path, options = {}) {
      const normalizedPath = normalizePath(path);
      const current = getSlice(get().worktrees, worktreeId);
      const directory =
        current.directories[normalizedPath] ?? createDirectoryState();
      const isRefresh = hasLoadedDirectoryContents(directory);
      if (
        isDirectoryLoading(directory.status) ||
        (!options.force && directory.status === "loaded" && !directory.stale)
      ) {
        return;
      }

      set((state) => {
        const next = getSlice(state.worktrees, worktreeId);
        return {
          worktrees: {
            ...state.worktrees,
            [worktreeId]: {
              ...next,
              directories: {
                ...next.directories,
                [normalizedPath]: {
                  ...directory,
                  status: isRefresh ? "loading-refresh" : "loading-initial",
                  error: null,
                },
              },
            },
          },
        };
      });

      try {
        const response = await listDirectoryWithNotFoundRetry(
          projectId,
          worktreeId,
          normalizedPath,
        );
        set((state) => {
          let next = getSlice(state.worktrees, worktreeId);
          next = reconcileDirectoryEntries(
            next,
            normalizedPath,
            response.entries,
          );
          const stale = response.generation < next.pendingGeneration;
          return {
            worktrees: {
              ...state.worktrees,
              [worktreeId]: {
                ...next,
                directories: {
                  ...next.directories,
                  [normalizedPath]: {
                    ...directory,
                    status: "loaded",
                    generation: response.generation,
                    entries: response.entries,
                    error: null,
                    stale,
                  },
                },
              },
            },
          };
        });
      } catch (error) {
        if (isNotFoundError(error) && normalizedPath) {
          set((state) => {
            const next = getSlice(state.worktrees, worktreeId);
            return {
              worktrees: {
                ...state.worktrees,
                [worktreeId]: pruneMissingDirectory(next, normalizedPath),
              },
            };
          });
          return;
        }

        set((state) => {
          const next = getSlice(state.worktrees, worktreeId);
          return {
            worktrees: {
              ...state.worktrees,
              [worktreeId]: {
                ...next,
                directories: {
                  ...next.directories,
                  [normalizedPath]: {
                    ...directory,
                    status: isRefresh ? "error-refresh" : "error-initial",
                    error: (error as Error).message,
                  },
                },
              },
            },
          };
        });
      }
    },
    async loadGitStatus(projectId, worktreeId, options = {}) {
      const current = getSlice(get().worktrees, worktreeId);
      const targetGitGeneration = Math.max(
        current.pendingGeneration,
        current.pendingGitGeneration,
      );
      if (
        current.gitStatusStatus === "loading" ||
        (!options.force &&
          current.gitStatus &&
          current.gitStatus.generation >= targetGitGeneration)
      ) {
        return;
      }

      set((state) => {
        const next = getSlice(state.worktrees, worktreeId);
        return {
          worktrees: {
            ...state.worktrees,
            [worktreeId]: {
              ...next,
              gitStatusStatus: "loading",
              gitError: null,
            },
          },
        };
      });

      try {
        const gitStatus = await getProjectWorktreeGitStatus(
          projectId,
          worktreeId,
        );
        set((state) => {
          const next = getSlice(state.worktrees, worktreeId);
          return {
            worktrees: {
              ...state.worktrees,
              [worktreeId]: {
                ...next,
                gitStatus,
                gitStatusStatus: "loaded",
                gitError: null,
                pendingGitGeneration:
                  gitStatus.generation >= next.pendingGitGeneration
                    ? 0
                    : next.pendingGitGeneration,
              },
            },
          };
        });
      } catch (error) {
        set((state) => {
          const next = getSlice(state.worktrees, worktreeId);
          return {
            worktrees: {
              ...state.worktrees,
              [worktreeId]: {
                ...next,
                gitStatusStatus: "error",
                gitError: (error as Error).message,
              },
            },
          };
        });
      }
    },
    async preloadVisibleDirectories(projectId, worktreeId) {
      const visited = new Set<string>();
      const queue = [""];

      while (queue.length > 0) {
        const path = queue.shift() ?? "";
        if (visited.has(path)) {
          continue;
        }
        visited.add(path);

        if (path && shouldSkipPreloadDirectory(baseName(path))) {
          continue;
        }

        const current = getSlice(get().worktrees, worktreeId);
        const directory = current.directories[path];
        if (directory?.status !== "loaded" || directory.stale) {
          continue;
        }

        const childDirectories = directory.entries.filter(
          (entry) =>
            entry.kind === "directory" &&
            !shouldSkipPreloadDirectory(entry.name),
        );

        await Promise.all(
          childDirectories.map((entry) =>
            get().loadDirectory(projectId, worktreeId, entry.path),
          ),
        );

        const next = getSlice(get().worktrees, worktreeId);
        for (const entry of childDirectories) {
          if (
            next.expandedPaths.includes(entry.path) &&
            next.directories[entry.path]?.status === "loaded" &&
            !next.directories[entry.path]?.stale
          ) {
            queue.push(entry.path);
          }
        }
      }
    },
    async refreshPendingPaths(projectId, worktreeId) {
      const current = getSlice(get().worktrees, worktreeId);
      const targetGeneration = current.pendingGeneration;
      const targetChangedPaths = current.pendingChangedPaths;
      const targetListingPaths = current.pendingListingPaths;
      if (
        targetGeneration === 0 ||
        (targetChangedPaths.length === 0 && targetListingPaths.length === 0)
      ) {
        return;
      }

      const visiblePaths = getVisiblePaths(
        current,
        (directory, path) =>
          path === "" ||
          (hasLoadedDirectoryContents(directory) && directory.stale),
      ).filter((path) => {
        return (
          targetListingPaths.includes(path) || targetChangedPaths.includes(path)
        );
      });

      await Promise.all([
        get().loadGitStatus(projectId, worktreeId, { force: true }),
        ...visiblePaths.map((path) =>
          get().loadDirectory(projectId, worktreeId, path, { force: true }),
        ),
      ]);

      await get().preloadVisibleDirectories(projectId, worktreeId);

      set((state) => {
        const next = getSlice(state.worktrees, worktreeId);
        if (next.pendingGeneration > targetGeneration) {
          return state;
        }
        return {
          worktrees: {
            ...state.worktrees,
            [worktreeId]: {
              ...next,
              pendingGeneration: 0,
              pendingChangedPaths: [],
              pendingListingPaths: [],
            },
          },
        };
      });
    },
    async refreshPaths(projectId, worktreeId, paths) {
      const changedPaths = uniquePaths(paths.map(normalizePath));
      const listingPaths = uniquePaths(changedPaths.map(parentPath));
      if (changedPaths.length === 0 && listingPaths.length === 0) {
        await get().loadGitStatus(projectId, worktreeId, { force: true });
        return;
      }

      set((state) => {
        const current = getSlice(state.worktrees, worktreeId);
        return {
          worktrees: {
            ...state.worktrees,
            [worktreeId]: {
              ...current,
              directories: markDirectoriesStale(
                current,
                listingPaths,
                changedPaths,
              ),
            },
          },
        };
      });

      const current = getSlice(get().worktrees, worktreeId);
      const visiblePaths = getVisiblePaths(
        current,
        (directory, path) =>
          path === "" ||
          (hasLoadedDirectoryContents(directory) && directory.stale),
      ).filter((path) => {
        return listingPaths.includes(path) || changedPaths.includes(path);
      });

      await Promise.all([
        get().loadGitStatus(projectId, worktreeId, { force: true }),
        ...visiblePaths.map((path) =>
          get().loadDirectory(projectId, worktreeId, path, { force: true }),
        ),
      ]);

      await get().preloadVisibleDirectories(projectId, worktreeId);
    },
    async refreshVisiblePaths(projectId, worktreeId, options = {}) {
      const current = getSlice(get().worktrees, worktreeId);
      const visiblePaths = getVisiblePaths(current);

      await Promise.all([
        get().loadGitStatus(projectId, worktreeId, { force: true }),
        ...visiblePaths.map((path) =>
          get().loadDirectory(projectId, worktreeId, path, {
            force: options.force ?? true,
          }),
        ),
      ]);

      await get().preloadVisibleDirectories(projectId, worktreeId);
    },
    async renameEntry(projectId, worktreeId, path, newName) {
      const response = await renameProjectWorktreeFile(
        projectId,
        worktreeId,
        path,
        newName,
      );
      const nextPath = response.path;
      set((state) => {
        const current = getSlice(state.worktrees, worktreeId);
        return {
          worktrees: {
            ...state.worktrees,
            [worktreeId]: {
              ...current,
              renamePath: null,
              selectedPath: nextPath,
              expandedPaths: uniquePaths([
                ...current.expandedPaths,
                parentPath(nextPath),
              ]).filter(Boolean),
            },
          },
        };
      });
      await get().refreshVisiblePaths(projectId, worktreeId, { force: true });
      return nextPath;
    },
  }),
);

let initialized = false;
let eventUnsubscribers: Array<() => void> = [];

export function initializeWorktreeFileManagerStore(): void {
  if (initialized) return;
  initialized = true;

  const events = getEventClient();
  eventUnsubscribers = [
    events.on("snapshot", (data) => {
      const validWorktreeIds = new Set(
        Object.values(data.worktrees ?? {})
          .flat()
          .map((worktree) => worktree.id),
      );
      useWorktreeFileManagerStore.setState((state) => ({
        worktrees: Object.fromEntries(
          Object.entries(state.worktrees).filter(([worktreeId]) =>
            validWorktreeIds.has(worktreeId),
          ),
        ),
      }));
    }),
    events.on("worktree_deleted", (data) => {
      useWorktreeFileManagerStore.setState((state) => {
        const next = { ...state.worktrees };
        delete next[data.worktree_id];
        return { worktrees: next };
      });
    }),
    events.on("worktree_files_updated", (data) => {
      useWorktreeFileManagerStore.setState((state) => {
        const worktreeId = data.worktree_id;
        const current = getSlice(state.worktrees, worktreeId);
        const pendingChangedPaths = mergePendingPaths(
          current.pendingChangedPaths,
          data.changed_paths,
        );
        const pendingListingPaths = mergePendingPaths(
          current.pendingListingPaths,
          data.listing_paths,
        );
        return {
          worktrees: {
            ...state.worktrees,
            [worktreeId]: {
              ...current,
              directories: markDirectoriesStale(
                current,
                pendingListingPaths,
                pendingChangedPaths,
              ),
              pendingGeneration: Math.max(
                current.pendingGeneration,
                Number(data.generation),
              ),
              pendingChangedPaths,
              pendingListingPaths,
            },
          },
        };
      });
    }),
    events.on("worktree_git_status_updated", (data) => {
      useWorktreeFileManagerStore.setState((state) => {
        const worktreeId = data.worktree_id;
        const current = getSlice(state.worktrees, worktreeId);
        return {
          worktrees: {
            ...state.worktrees,
            [worktreeId]: {
              ...current,
              pendingGitGeneration: Math.max(
                current.pendingGitGeneration,
                Number(data.generation),
              ),
            },
          },
        };
      });
    }),
  ];
}

export function resetWorktreeFileManagerStoreForTests(): void {
  initialized = false;
  for (const unsubscribe of eventUnsubscribers) {
    unsubscribe();
  }
  eventUnsubscribers = [];
  useWorktreeFileManagerStore.setState({ worktrees: {} });
}
