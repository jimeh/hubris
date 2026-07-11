import { create } from "zustand";

type BrowserTabSession = {
  draftUrl: string | null;
  loading: boolean;
  error: string | null;
  showEmbedHelp: boolean;
  reloadKey: number;
  canGoBack: boolean;
  canGoForward: boolean;
};

type BrowserTabStore = {
  sessions: Record<string, BrowserTabSession>;
  syncNavigationState: (
    tabId: string,
    canGoBack: boolean,
    canGoForward: boolean,
  ) => void;
  setDraftUrl: (tabId: string, draftUrl: string | null) => void;
  setLoading: (tabId: string, loading: boolean) => void;
  setError: (tabId: string, error: string | null) => void;
  setShowEmbedHelp: (tabId: string, showEmbedHelp: boolean) => void;
  bumpReloadKey: (tabId: string) => void;
  removeSession: (tabId: string) => void;
};

function defaultSession(): BrowserTabSession {
  return {
    draftUrl: null,
    loading: false,
    error: null,
    showEmbedHelp: false,
    reloadKey: 0,
    canGoBack: false,
    canGoForward: false,
  };
}

export const useBrowserTabStore = create<BrowserTabStore>((set) => ({
  sessions: {},
  syncNavigationState(tabId, canGoBack, canGoForward) {
    set((state) => {
      const existing = state.sessions[tabId] ?? defaultSession();

      if (
        existing.canGoBack === canGoBack &&
        existing.canGoForward === canGoForward
      ) {
        return state;
      }

      return {
        sessions: {
          ...state.sessions,
          [tabId]: {
            ...existing,
            canGoBack,
            canGoForward,
          },
        },
      };
    });
  },
  setDraftUrl(tabId, draftUrl) {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [tabId]: {
          ...(state.sessions[tabId] ?? defaultSession()),
          draftUrl,
        },
      },
    }));
  },
  setLoading(tabId, loading) {
    set((state) => {
      const existing = state.sessions[tabId] ?? defaultSession();
      if (existing.loading === loading && state.sessions[tabId]) {
        return state;
      }

      return {
        sessions: {
          ...state.sessions,
          [tabId]: {
            ...existing,
            loading,
          },
        },
      };
    });
  },
  setError(tabId, error) {
    set((state) => {
      const existing = state.sessions[tabId] ?? defaultSession();
      if (existing.error === error && state.sessions[tabId]) {
        return state;
      }

      return {
        sessions: {
          ...state.sessions,
          [tabId]: {
            ...existing,
            error,
          },
        },
      };
    });
  },
  setShowEmbedHelp(tabId, showEmbedHelp) {
    set((state) => {
      const existing = state.sessions[tabId] ?? defaultSession();
      if (existing.showEmbedHelp === showEmbedHelp && state.sessions[tabId]) {
        return state;
      }

      return {
        sessions: {
          ...state.sessions,
          [tabId]: {
            ...existing,
            showEmbedHelp,
          },
        },
      };
    });
  },
  bumpReloadKey(tabId) {
    set((state) => {
      const existing = state.sessions[tabId] ?? defaultSession();

      return {
        sessions: {
          ...state.sessions,
          [tabId]: {
            ...existing,
            reloadKey: existing.reloadKey + 1,
          },
        },
      };
    });
  },
  removeSession(tabId) {
    set((state) => {
      if (!(tabId in state.sessions)) {
        return state;
      }

      const sessions = { ...state.sessions };
      delete sessions[tabId];
      return { sessions };
    });
  },
}));

/** Initialize any browser-tab runtime wiring needed at app bootstrap. */
export function initializeBrowserTabStore(): void {
  // No external subscriptions to initialize yet.
}

/** Reset browser-tab runtime state between tests. */
export function resetBrowserTabStoreForTests(): void {
  useBrowserTabStore.setState({ sessions: {} });
}
