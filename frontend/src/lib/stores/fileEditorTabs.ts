import { create } from "zustand";
import {
  ApiStatusError,
  getProjectWorktreeFileContent,
  saveProjectWorktreeFileContent,
} from "@/lib/api";
import { getEventClient } from "@/lib/events";
import { useTabStore } from "@/lib/stores/tabs";
import type { FileTab } from "@/lib/types";

type LoadStatus = "idle" | "loading" | "loaded" | "error";
type SaveStatus = "idle" | "saving" | "error";

export type FileEditorSession = {
  tabId: string;
  path: string;
  draft: string;
  savedContent: string;
  versionToken: string;
  language: string;
  readOnly: boolean;
  unsupportedReason: string | null;
  dirty: boolean;
  externalChange: boolean;
  loadStatus: LoadStatus;
  saveStatus: SaveStatus;
  error: string | null;
};

type FileEditorStoreState = {
  sessions: Record<string, FileEditorSession>;
  ensureLoaded: (
    projectId: string,
    worktreeId: string,
    tab: FileTab,
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

function createSession(tab: FileTab): FileEditorSession {
  return {
    tabId: tab.id,
    path: tab.path,
    draft: "",
    savedContent: "",
    versionToken: "",
    language: "plaintext",
    readOnly: false,
    unsupportedReason: null,
    dirty: false,
    externalChange: false,
    loadStatus: "idle",
    saveStatus: "idle",
    error: null,
  };
}

function isFilePathAffected(
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

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

export const useFileEditorStore = create<FileEditorStoreState>((set, get) => ({
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
          loadStatus: "loading",
          error: null,
        },
      },
    }));

    try {
      const response = await getProjectWorktreeFileContent(
        projectId,
        worktreeId,
        tab.path,
      );
      set((state) => ({
        sessions: {
          ...state.sessions,
          [tab.id]: {
            ...(state.sessions[tab.id] ?? createSession(tab)),
            path: tab.path,
            draft: response.content,
            savedContent: response.content,
            versionToken: response.version_token,
            language: response.language,
            readOnly: response.read_only,
            unsupportedReason: response.unsupported_reason ?? null,
            dirty: false,
            externalChange: false,
            loadStatus: "loaded",
            saveStatus: "idle",
            error: null,
          },
        },
      }));
    } catch (error) {
      set((state) => ({
        sessions: {
          ...state.sessions,
          [tab.id]: {
            ...(state.sessions[tab.id] ?? createSession(tab)),
            loadStatus: "error",
            error:
              error instanceof Error ? error.message : "Failed to load file",
          },
        },
      }));
    }
  },
  updateDraft(tabId, draft) {
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
            draft,
            dirty: draft !== current.savedContent,
            externalChange: current.externalChange,
            error: null,
          },
        },
      };
    });
  },
  async save(projectId, worktreeId, tabId) {
    const session = get().sessions[tabId];
    if (!session || session.readOnly || session.loadStatus !== "loaded") {
      return;
    }

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
        session.path,
        session.draft,
        session.versionToken,
      );
      set((state) => ({
        sessions: {
          ...state.sessions,
          [tabId]: {
            ...state.sessions[tabId],
            savedContent: session.draft,
            versionToken: response.version_token,
            dirty: false,
            externalChange: false,
            saveStatus: "idle",
            error: null,
          },
        },
      }));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save file";
      set((state) => ({
        sessions: {
          ...state.sessions,
          [tabId]: {
            ...state.sessions[tabId],
            saveStatus: "error",
            externalChange:
              error instanceof ApiStatusError && error.status === 409
                ? true
                : state.sessions[tabId].externalChange,
            error: message,
          },
        },
      }));
      throw error;
    }
  },
  async reload(projectId, worktreeId, tabId, options) {
    const session = get().sessions[tabId];
    const tab = useTabStore
      .getState()
      .tabs.find(
        (candidate): candidate is FileTab =>
          candidate.id === tabId && candidate.type === "file",
      );
    if (!session || !tab) {
      return;
    }

    try {
      const response = await getProjectWorktreeFileContent(
        projectId,
        worktreeId,
        session.path,
      );
      set((state) => {
        const current = state.sessions[tabId];
        if (!current) {
          return state;
        }

        const preserveDirty = options?.preserveDirty ?? false;
        return {
          sessions: {
            ...state.sessions,
            [tabId]: {
              ...current,
              path: tab.path,
              draft:
                preserveDirty && current.dirty
                  ? current.draft
                  : response.content,
              savedContent: response.content,
              versionToken: response.version_token,
              language: response.language,
              readOnly: response.read_only,
              unsupportedReason: response.unsupported_reason ?? null,
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
      set((state) => ({
        sessions: {
          ...state.sessions,
          [tabId]: {
            ...state.sessions[tabId],
            loadStatus: "error",
            error:
              error instanceof Error ? error.message : "Failed to reload file",
          },
        },
      }));
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

export function initializeFileEditorStore(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  const events = getEventClient();
  eventUnsubscribers = [
    events.on("snapshot", ({ tabs }) => {
      const activeIds = new Set(
        tabs.filter((tab) => tab.type === "file").map((tab) => tab.id),
      );
      useFileEditorStore.setState((state) => {
        const nextSessions = Object.fromEntries(
          Object.entries(state.sessions).filter(([tabId]) =>
            activeIds.has(tabId),
          ),
        );
        return nextSessions === state.sessions
          ? state
          : {
              sessions: nextSessions,
            };
      });
    }),
    events.on(
      "worktree_files_updated",
      ({ project_id, worktree_id, changed_paths, listing_paths }) => {
        const fileTabs = useTabStore
          .getState()
          .tabs.filter(
            (tab): tab is FileTab =>
              tab.type === "file" && tab.worktree_id === worktree_id,
          );
        const store = useFileEditorStore.getState();

        for (const tab of fileTabs) {
          if (!isFilePathAffected(tab.path, changed_paths, listing_paths)) {
            continue;
          }

          const session = store.sessions[tab.id];
          if (!session) {
            continue;
          }

          if (session.dirty) {
            store.markExternalChange(tab.id);
          } else {
            void store.reload(project_id, worktree_id, tab.id);
          }
        }
      },
    ),
    events.on("tab_closed", ({ tab_id }) => {
      useFileEditorStore.getState().discardSession(tab_id);
    }),
  ];
}

export function resetFileEditorStoreForTests(): void {
  for (const unsubscribe of eventUnsubscribers) {
    unsubscribe();
  }
  eventUnsubscribers = [];
  initialized = false;
  useFileEditorStore.setState({ sessions: {} });
}
