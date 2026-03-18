import { create } from "zustand";
import {
  getProjectWorktreeGitStatus,
  listProjectWorktreeFiles,
  renameProjectWorktreeFile,
  type WorktreeFile,
  type WorktreeGitStatus,
} from "@/lib/api";
import { getEventClient } from "@/lib/events";

type RequestStatus = "idle" | "loading" | "loaded" | "error";

type DirectoryState = {
  status: RequestStatus;
  generation: number;
  entries: WorktreeFile[];
  error: string | null;
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
};

type LoadOptions = {
  force?: boolean;
};

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
  };
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
      if (
        directory.status === "loading" ||
        (!options.force &&
          directory.status === "loaded" &&
          directory.generation >= current.pendingGeneration)
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
                  status: "loading",
                  error: null,
                },
              },
            },
          },
        };
      });

      try {
        const response = await listProjectWorktreeFiles(
          projectId,
          worktreeId,
          normalizedPath,
        );
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
                    status: "loaded",
                    generation: response.generation,
                    entries: response.entries,
                    error: null,
                  },
                },
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
                directories: {
                  ...next.directories,
                  [normalizedPath]: {
                    ...directory,
                    status: "error",
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
      if (
        current.gitStatusStatus === "loading" ||
        (!options.force &&
          current.gitStatus &&
          current.gitStatus.generation >= current.pendingGeneration)
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
        if (directory?.status !== "loaded") {
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
            next.directories[entry.path]?.status === "loaded"
          ) {
            queue.push(entry.path);
          }
        }
      }
    },
    async refreshVisiblePaths(projectId, worktreeId, options = {}) {
      const current = getSlice(get().worktrees, worktreeId);
      const targetGeneration = current.pendingGeneration;
      const visiblePaths = uniquePaths(
        ["", ...current.expandedPaths].filter((path) => {
          if (path === "") {
            return true;
          }
          return current.directories[path]?.status === "loaded";
        }),
      );

      await Promise.all([
        get().loadGitStatus(projectId, worktreeId, { force: true }),
        ...visiblePaths.map((path) =>
          get().loadDirectory(projectId, worktreeId, path, {
            force: options.force ?? true,
          }),
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
            },
          },
        };
      });
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
        return {
          worktrees: {
            ...state.worktrees,
            [worktreeId]: {
              ...current,
              pendingGeneration: Math.max(
                current.pendingGeneration,
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
