import { create } from "zustand";
import {
  ApiStatusError,
  getProjectWorktreeGitDiff,
  saveProjectWorktreeFileContent,
} from "@/lib/api";
import { getEventClient } from "@/lib/events";
import {
  selectTabById,
  selectTabsForWorktree,
  useTabStore,
} from "@/lib/stores/tabs";
import type { GitDiffTab } from "@/lib/types";

type LoadStatus = "idle" | "loading" | "loaded" | "error";
type SaveStatus = "idle" | "saving" | "error";

export type GitDiffSession = {
  tabId: string;
  path: string;
  originalPath: string | null;
  scope: GitDiffTab["scope"];
  originalContent: string;
  draft: string;
  savedContent: string;
  modifiedVersionToken: string | null;
  language: string;
  readOnly: boolean;
  unsupportedReason: string | null;
  dirty: boolean;
  externalChange: boolean;
  loadStatus: LoadStatus;
  saveStatus: SaveStatus;
  reloadGeneration: number;
  error: string | null;
};

type GitDiffStoreState = {
  sessions: Record<string, GitDiffSession>;
  ensureLoaded: (
    projectId: string,
    worktreeId: string,
    tab: GitDiffTab,
  ) => Promise<void>;
  updateDraft: (tabId: string, draft: string) => void;
  save: (projectId: string, worktreeId: string, tabId: string) => Promise<void>;
  reload: (
    projectId: string,
    worktreeId: string,
    tabId: string,
    options?: { preserveDirty?: boolean },
  ) => Promise<void>;
  markExternalChange: (tabId: string) => void;
  clearExternalChange: (tabId: string) => void;
  discardSession: (tabId: string) => void;
};

function createSession(tab: GitDiffTab): GitDiffSession {
  return {
    tabId: tab.id,
    path: tab.path,
    originalPath: tab.originalPath ?? null,
    scope: tab.scope,
    originalContent: "",
    draft: "",
    savedContent: "",
    modifiedVersionToken: null,
    language: "plaintext",
    readOnly: true,
    unsupportedReason: null,
    dirty: false,
    externalChange: false,
    loadStatus: "idle",
    saveStatus: "idle",
    reloadGeneration: 0,
    error: null,
  };
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function isPathAffected(
  path: string,
  changedPaths: string[],
  listingPaths: string[],
): boolean {
  return (
    changedPaths.includes(path) ||
    listingPaths.includes(path) ||
    listingPaths.includes(parentPath(path))
  );
}

function isDiffPathAffected(
  path: string,
  originalPath: string | null,
  changedPaths: string[],
  listingPaths: string[],
): boolean {
  return (
    isPathAffected(path, changedPaths, listingPaths) ||
    (originalPath !== null &&
      isPathAffected(originalPath, changedPaths, listingPaths))
  );
}

export const useGitDiffStore = create<GitDiffStoreState>((set, get) => ({
  sessions: {},
  async ensureLoaded(projectId, worktreeId, tab) {
    const existing = get().sessions[tab.id];
    if (
      existing?.loadStatus === "loading" ||
      existing?.loadStatus === "loaded"
    ) {
      return;
    }

    set((state) => ({
      sessions: {
        ...state.sessions,
        [tab.id]: {
          ...(state.sessions[tab.id] ?? createSession(tab)),
          path: tab.path,
          originalPath: tab.originalPath ?? null,
          scope: tab.scope,
          loadStatus: "loading",
          error: null,
        },
      },
    }));

    try {
      const response = await getProjectWorktreeGitDiff(
        projectId,
        worktreeId,
        tab.path,
        tab.scope,
        tab.originalPath ?? undefined,
        tab.commitId ?? undefined,
      );
      set((state) => {
        const current = state.sessions[tab.id];
        if (!current) {
          return state;
        }

        return {
          sessions: {
            ...state.sessions,
            [tab.id]: {
              ...current,
              path: tab.path,
              originalPath: tab.originalPath ?? null,
              scope: tab.scope,
              originalContent: response.leftContent,
              draft: response.rightContent,
              savedContent: response.rightContent,
              modifiedVersionToken: response.modifiedVersionToken ?? null,
              language: response.language,
              readOnly: response.readOnly,
              unsupportedReason: response.unsupportedReason ?? null,
              dirty: false,
              externalChange: false,
              loadStatus: "loaded",
              saveStatus: "idle",
              error: null,
            },
          },
        };
      });
    } catch (error) {
      set((state) => {
        const current = state.sessions[tab.id];
        if (!current) {
          return state;
        }

        return {
          sessions: {
            ...state.sessions,
            [tab.id]: {
              ...current,
              loadStatus: "error",
              error:
                error instanceof Error ? error.message : "Failed to load diff",
            },
          },
        };
      });
    }
  },
  updateDraft(tabId, draft) {
    set((state) => {
      const current = state.sessions[tabId];
      if (!current || current.draft === draft) {
        return state;
      }

      return {
        sessions: {
          ...state.sessions,
          [tabId]: {
            ...current,
            draft,
            dirty: draft !== current.savedContent,
            error: null,
          },
        },
      };
    });
  },
  async save(projectId, worktreeId, tabId) {
    const session = get().sessions[tabId];
    if (
      !session ||
      session.readOnly ||
      session.loadStatus !== "loaded" ||
      session.modifiedVersionToken === null ||
      !session.dirty ||
      session.saveStatus === "saving"
    ) {
      return;
    }

    const savePath = session.path;
    const saveDraft = session.draft;
    const expectedVersionToken = session.modifiedVersionToken;

    set((state) => ({
      sessions: {
        ...state.sessions,
        [tabId]: {
          ...state.sessions[tabId],
          saveStatus: "saving",
          error: null,
        },
      },
    }));

    try {
      const response = await saveProjectWorktreeFileContent(
        projectId,
        worktreeId,
        savePath,
        saveDraft,
        expectedVersionToken,
      );
      set((state) => {
        const current = state.sessions[tabId];
        if (!current) {
          return state;
        }

        return {
          sessions: {
            ...state.sessions,
            [tabId]: {
              ...current,
              savedContent: saveDraft,
              modifiedVersionToken: response.versionToken,
              dirty: current.draft !== saveDraft,
              externalChange: false,
              saveStatus: "idle",
              error: null,
            },
          },
        };
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save diff";
      set((state) => {
        const current = state.sessions[tabId];
        if (!current) {
          return state;
        }

        return {
          sessions: {
            ...state.sessions,
            [tabId]: {
              ...current,
              saveStatus: "error",
              externalChange:
                error instanceof ApiStatusError && error.status === 409
                  ? true
                  : current.externalChange,
              error: message,
            },
          },
        };
      });
      throw error;
    }
  },
  async reload(projectId, worktreeId, tabId, options) {
    const session = get().sessions[tabId];
    const candidate = selectTabById(useTabStore.getState(), tabId);
    const tab = candidate?.type === "git_diff" ? candidate : undefined;
    if (!session || !tab) {
      return;
    }

    const generation = session.reloadGeneration + 1;
    set((state) => {
      const current = state.sessions[tabId];
      if (!current) {
        return state;
      }
      return {
        sessions: {
          ...state.sessions,
          [tabId]: { ...current, reloadGeneration: generation },
        },
      };
    });

    try {
      const response = await getProjectWorktreeGitDiff(
        projectId,
        worktreeId,
        tab.path,
        tab.scope,
        tab.originalPath ?? undefined,
        tab.commitId ?? undefined,
      );
      set((state) => {
        const current = state.sessions[tabId];
        if (!current || current.reloadGeneration !== generation) {
          return state;
        }

        const preserveDirty = options?.preserveDirty ?? false;
        return {
          sessions: {
            ...state.sessions,
            [tabId]: {
              ...current,
              path: tab.path,
              originalPath: tab.originalPath ?? null,
              scope: tab.scope,
              originalContent: response.leftContent,
              draft:
                preserveDirty && current.dirty
                  ? current.draft
                  : response.rightContent,
              savedContent: response.rightContent,
              modifiedVersionToken: response.modifiedVersionToken ?? null,
              language: response.language,
              readOnly: response.readOnly,
              unsupportedReason: response.unsupportedReason ?? null,
              dirty: preserveDirty ? current.dirty : false,
              externalChange: preserveDirty ? current.externalChange : false,
              loadStatus: "loaded",
              saveStatus: "idle",
              error: null,
            },
          },
        };
      });
    } catch (error) {
      set((state) => {
        const current = state.sessions[tabId];
        if (!current || current.reloadGeneration !== generation) {
          return state;
        }

        return {
          sessions: {
            ...state.sessions,
            [tabId]: {
              ...current,
              loadStatus: "error",
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to reload diff",
            },
          },
        };
      });
    }
  },
  markExternalChange(tabId) {
    set((state) => {
      const current = state.sessions[tabId];
      if (!current) {
        return state;
      }

      return {
        sessions: {
          ...state.sessions,
          [tabId]: {
            ...current,
            externalChange: true,
          },
        },
      };
    });
  },
  clearExternalChange(tabId) {
    set((state) => {
      const current = state.sessions[tabId];
      if (!current) {
        return state;
      }

      return {
        sessions: {
          ...state.sessions,
          [tabId]: {
            ...current,
            externalChange: false,
          },
        },
      };
    });
  },
  discardSession(tabId) {
    set((state) => {
      const next = { ...state.sessions };
      delete next[tabId];
      return { sessions: next };
    });
  },
}));

let initialized = false;
let eventUnsubscribers: Array<() => void> = [];

export function initializeGitDiffStore(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  const events = getEventClient();
  eventUnsubscribers = [
    events.on("snapshot", ({ tabs }) => {
      const activeIds = new Set(
        tabs.filter((tab) => tab.type === "git_diff").map((tab) => tab.id),
      );
      useGitDiffStore.setState((state) => {
        let nextSessions: Record<string, GitDiffSession> | null = null;
        for (const tabId of Object.keys(state.sessions)) {
          if (activeIds.has(tabId)) {
            continue;
          }
          nextSessions ??= { ...state.sessions };
          delete nextSessions[tabId];
        }
        return nextSessions === null
          ? state
          : {
              sessions: nextSessions,
            };
      });
    }),
    events.on(
      "worktree_files_updated",
      ({ projectId, worktreeId, changedPaths, listingPaths }) => {
        const gitDiffTabs = selectTabsForWorktree(
          useTabStore.getState(),
          worktreeId,
        ).filter(
          (tab): tab is GitDiffTab =>
            tab.type === "git_diff" &&
            tab.worktreeId === worktreeId &&
            tab.scope === "unstaged",
        );
        const store = useGitDiffStore.getState();

        for (const tab of gitDiffTabs) {
          if (
            !isDiffPathAffected(
              tab.path,
              tab.originalPath ?? null,
              changedPaths,
              listingPaths,
            )
          ) {
            continue;
          }

          const session = store.sessions[tab.id];
          if (!session) {
            continue;
          }

          if (session.dirty) {
            store.markExternalChange(tab.id);
          } else {
            void store.reload(projectId, worktreeId, tab.id);
          }
        }
      },
    ),
    events.on("tab_closed", ({ tabId }) => {
      useGitDiffStore.getState().discardSession(tabId);
    }),
  ];
}

export function resetGitDiffStoreForTests(): void {
  for (const unsubscribe of eventUnsubscribers) {
    unsubscribe();
  }
  eventUnsubscribers = [];
  initialized = false;
  useGitDiffStore.setState({ sessions: {} });
}
