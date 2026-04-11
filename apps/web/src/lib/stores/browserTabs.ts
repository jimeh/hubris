import { create } from "zustand";

type BrowserTabSession = {
  draftUrl: string;
  loading: boolean;
  error: string | null;
  showEmbedHelp: boolean;
  reloadKey: number;
  canGoBack: boolean;
  canGoForward: boolean;
};

type BrowserTabStore = {
  sessions: Record<string, BrowserTabSession>;
  ensureSession: (
    tabId: string,
    url: string,
    canGoBack: boolean,
    canGoForward: boolean,
  ) => void;
  syncNavigationState: (
    tabId: string,
    canGoBack: boolean,
    canGoForward: boolean,
  ) => void;
  setDraftUrl: (tabId: string, draftUrl: string) => void;
  setLoading: (tabId: string, loading: boolean) => void;
  setError: (tabId: string, error: string | null) => void;
  setShowEmbedHelp: (tabId: string, showEmbedHelp: boolean) => void;
  bumpReloadKey: (tabId: string) => void;
  removeSession: (tabId: string) => void;
};

function defaultSession(
  url: string,
  canGoBack: boolean,
  canGoForward: boolean,
): BrowserTabSession {
  return {
    draftUrl: url,
    loading: false,
    error: null,
    showEmbedHelp: false,
    reloadKey: 0,
    canGoBack,
    canGoForward,
  };
}

export const useBrowserTabStore = create<BrowserTabStore>((set) => ({
  sessions: {},
  ensureSession(tabId, url, canGoBack, canGoForward) {
    set((state) => {
      const existing = state.sessions[tabId];
      if (existing) {
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
      }

      return {
        sessions: {
          ...state.sessions,
          [tabId]: defaultSession(url, canGoBack, canGoForward),
        },
      };
    });
  },
  syncNavigationState(tabId, canGoBack, canGoForward) {
    set((state) => {
      const existing = state.sessions[tabId];
      if (!existing) {
        return state;
      }

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
          ...(state.sessions[tabId] ?? defaultSession("", false, false)),
          draftUrl,
        },
      },
    }));
  },
  setLoading(tabId, loading) {
    set((state) => {
      const existing = state.sessions[tabId];
      if (!existing || existing.loading === loading) {
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
      const existing = state.sessions[tabId];
      if (!existing || existing.error === error) {
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
      const existing = state.sessions[tabId];
      if (!existing || existing.showEmbedHelp === showEmbedHelp) {
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
      const existing = state.sessions[tabId];
      if (!existing) {
        return state;
      }

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
