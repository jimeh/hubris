import { create } from "zustand";
import {
  createTab,
  createTerminalTab,
  deleteTab,
  reorderTabs,
  updateTab,
} from "@/lib/api";
import { getEventClient } from "@/lib/events";
import { scheduleDisposeTabModels } from "@/lib/monaco";
import type { GitDiffScope, GitDiffTab, Tab } from "@/lib/types";

const LS_ACTIVE_TAB = "hubris-active-tab";
const LS_TAB_BY_WORKTREE = "hubris-active-tab-by-worktree";
// Shares one createTab request across click+double-click for the same diff,
// letting the later event upgrade the eventual tab from preview to pinned.
const pendingGitDiffOpens = new Map<string, PendingGitDiffOpen>();

type OpenFileOptions = {
  worktreeId: string;
  path: string;
  preview: boolean;
};

type OpenGitDiffOptions = {
  worktreeId: string;
  path: string;
  scope: GitDiffScope;
  originalPath?: string | null;
  commitId?: string | null;
  preview: boolean;
};

type PendingGitDiffOpen = {
  state: {
    shouldPin: boolean;
  };
  promise: Promise<Tab>;
};

type TabsState = {
  tabs: Tab[];
  activeTabId: string | null;
  activeTabByWorktree: Record<string, string>;
  addTerminal: (worktreeId: string) => Promise<Tab>;
  openFile: (options: OpenFileOptions) => Promise<Tab>;
  openGitDiff: (options: OpenGitDiffOptions) => Promise<Tab>;
  pin: (id: string) => Promise<Tab | null>;
  close: (id: string) => Promise<void>;
  removeLocal: (id: string) => void;
  activate: (id: string) => void;
  reorder: (worktreeId: string, orderedIds: string[]) => Promise<void>;
  switchToWorktree: (worktreeId: string) => void;
};

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsGetJson<T>(key: string): T | null {
  const raw = lsGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: unknown): void {
  try {
    if (value == null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      );
    }
  } catch {
    // localStorage unavailable
  }
}

function persistSelection(
  activeTabId: string | null,
  activeTabByWorktree: Record<string, string>,
): void {
  lsSet(LS_ACTIVE_TAB, activeTabId);
  lsSet(LS_TAB_BY_WORKTREE, activeTabByWorktree);
}

function sortedTabs(list: Tab[]): Tab[] {
  return [...list].sort((a, b) => a.position - b.position);
}

function tabKey(tab: Tab): string {
  switch (tab.type) {
    case "terminal":
      return [
        tab.id,
        tab.label,
        tab.position,
        tab.worktree_id,
        tab.preview,
        tab.type,
        tab.has_notification ?? false,
      ].join("|");
    case "file":
      return [
        tab.id,
        tab.label,
        tab.position,
        tab.worktree_id,
        tab.preview,
        tab.type,
        tab.path,
      ].join("|");
    case "git_diff":
      return [
        tab.id,
        tab.label,
        tab.position,
        tab.worktree_id,
        tab.preview,
        tab.type,
        tab.path,
        tab.scope,
        tab.original_path ?? "",
        tab.commit_id ?? "",
      ].join("|");
  }
}

function tabsEqual(a: Tab[], b: Tab[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (tabKey(a[index]) !== tabKey(b[index])) {
      return false;
    }
  }
  return true;
}

function activeTabMapEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const aEntries = Object.entries(a).filter(([, value]) => value);
  const bEntries = Object.entries(b).filter(([, value]) => value);
  if (aEntries.length !== bEntries.length) {
    return false;
  }
  return aEntries.every(([key, value]) => b[key] === value);
}

function tabsForWorktreeInternal(tabs: Tab[], worktreeId: string): Tab[] {
  return tabs.filter((tab) => tab.worktree_id === worktreeId);
}

function setTabPreviewLocal(tabs: Tab[], id: string, preview: boolean): Tab[] {
  return tabs.map((tab) => (tab.id === id ? { ...tab, preview } : tab));
}

function addTabIfMissing(tabs: Tab[], tab: Tab): Tab[] {
  return tabs.some((candidate) => candidate.id === tab.id)
    ? tabs
    : sortedTabs([...tabs, tab]);
}

function removeFromState(state: TabsState, id: string): Partial<TabsState> {
  const removed = state.tabs.find((candidate) => candidate.id === id);
  const tabs = state.tabs.filter((candidate) => candidate.id !== id);

  const activeTabByWorktree = { ...state.activeTabByWorktree };
  if (removed) {
    const rememberedId = activeTabByWorktree[removed.worktree_id];
    if (rememberedId === id) {
      const nextWorktreeTab =
        tabs
          .filter((candidate) => candidate.worktree_id === removed.worktree_id)
          .at(-1)?.id ?? "";
      activeTabByWorktree[removed.worktree_id] = nextWorktreeTab;
    }
  }

  if (state.activeTabId !== id) {
    persistSelection(state.activeTabId, activeTabByWorktree);
    return { tabs, activeTabByWorktree };
  }

  const worktreeId = removed?.worktree_id;
  const remaining = worktreeId
    ? tabs.filter((candidate) => candidate.worktree_id === worktreeId)
    : tabs;
  const activeTabId = remaining.at(-1)?.id ?? null;
  if (worktreeId) {
    activeTabByWorktree[worktreeId] = activeTabId ?? "";
  }
  persistSelection(activeTabId, activeTabByWorktree);
  return { tabs, activeTabId, activeTabByWorktree };
}

function removedTabs(previous: Tab[], next: Tab[]): Tab[] {
  const nextIds = new Set(next.map((tab) => tab.id));
  return previous.filter((tab) => !nextIds.has(tab.id));
}

function findFileTab(
  tabs: Tab[],
  worktreeId: string,
  path: string,
): Tab | null {
  return (
    tabs.find(
      (tab) =>
        tab.worktree_id === worktreeId &&
        tab.type === "file" &&
        tab.path === path,
    ) ?? null
  );
}

function findGitDiffTab(
  tabs: Tab[],
  worktreeId: string,
  path: string,
  scope: GitDiffScope,
  originalPath?: string | null,
  commitId?: string | null,
): GitDiffTab | null {
  return (
    tabs.find(
      (tab): tab is GitDiffTab =>
        tab.worktree_id === worktreeId &&
        tab.type === "git_diff" &&
        tab.path === path &&
        tab.scope === scope &&
        (tab.original_path ?? null) === (originalPath ?? null) &&
        (tab.commit_id ?? null) === (commitId ?? null),
    ) ?? null
  );
}

function findPreviewTab(tabs: Tab[], worktreeId: string): Tab | null {
  return (
    tabs.find(
      (tab) =>
        tab.worktree_id === worktreeId &&
        tab.preview &&
        tab.type !== "terminal",
    ) ?? null
  );
}

function gitDiffOpenKey(options: OpenGitDiffOptions): string {
  return [
    options.worktreeId,
    options.path,
    options.scope,
    options.originalPath ?? "",
    options.commitId ?? "",
  ].join("|");
}

function activateLocal(
  state: TabsState,
  id: string,
): Pick<TabsState, "activeTabId" | "activeTabByWorktree"> {
  const tab = state.tabs.find((candidate) => candidate.id === id);
  const activeTabByWorktree = { ...state.activeTabByWorktree };
  if (tab) {
    activeTabByWorktree[tab.worktree_id] = id;
  }
  persistSelection(id, activeTabByWorktree);
  return {
    activeTabId: id,
    activeTabByWorktree,
  };
}

async function replacePreviewIfNeeded(
  state: TabsState,
  worktreeId: string,
): Promise<void> {
  const previewTab = findPreviewTab(state.tabs, worktreeId);
  if (!previewTab) {
    return;
  }

  scheduleDisposeTabModels(previewTab);
  useTabStore.setState((current) => removeFromState(current, previewTab.id));
  try {
    await deleteTab(previewTab.id);
  } catch {
    // Preview tab may already be gone.
  }
}

export const useTabStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: lsGet(LS_ACTIVE_TAB),
  activeTabByWorktree:
    lsGetJson<Record<string, string>>(LS_TAB_BY_WORKTREE) ?? {},
  async addTerminal(worktreeId) {
    const tab = await createTerminalTab(worktreeId);
    set((state) => {
      const tabs = addTabIfMissing(state.tabs, tab);
      const activeTabByWorktree = {
        ...state.activeTabByWorktree,
        [worktreeId]: tab.id,
      };
      persistSelection(tab.id, activeTabByWorktree);
      return {
        tabs,
        activeTabId: tab.id,
        activeTabByWorktree,
      };
    });
    return tab;
  },
  async openFile(options) {
    const existing = findFileTab(get().tabs, options.worktreeId, options.path);
    if (existing) {
      if (!options.preview && existing.preview) {
        set((state) => ({
          tabs: sortedTabs(setTabPreviewLocal(state.tabs, existing.id, false)),
          ...activateLocal(state, existing.id),
        }));
        try {
          return await updateTab(existing.id, { preview: false });
        } catch {
          return { ...existing, preview: false };
        }
      }

      set((state) => activateLocal(state, existing.id));
      return existing;
    }

    if (options.preview) {
      await replacePreviewIfNeeded(get(), options.worktreeId);
    }

    const tab = await createTab({
      type: "file",
      worktree_id: options.worktreeId,
      path: options.path,
      preview: options.preview,
    });
    set((state) => {
      const tabs = addTabIfMissing(state.tabs, tab);
      return {
        tabs,
        ...activateLocal(
          {
            ...state,
            tabs,
          } as TabsState,
          tab.id,
        ),
      };
    });
    return tab;
  },
  async openGitDiff(options) {
    const existing = findGitDiffTab(
      get().tabs,
      options.worktreeId,
      options.path,
      options.scope,
      options.originalPath,
      options.commitId,
    );
    if (existing) {
      if (!options.preview && existing.preview) {
        set((state) => ({
          tabs: sortedTabs(setTabPreviewLocal(state.tabs, existing.id, false)),
          ...activateLocal(state, existing.id),
        }));
        try {
          return await updateTab(existing.id, { preview: false });
        } catch {
          return { ...existing, preview: false };
        }
      }

      set((state) => activateLocal(state, existing.id));
      return existing;
    }

    const pendingKey = gitDiffOpenKey(options);
    const pending = pendingGitDiffOpens.get(pendingKey);
    if (pending) {
      if (!options.preview) {
        pending.state.shouldPin = true;
      }
      return pending.promise;
    }

    const pendingState = {
      shouldPin: !options.preview,
    };
    const pendingPromise = (async () => {
      if (options.preview) {
        await replacePreviewIfNeeded(get(), options.worktreeId);
      }

      const tab = await createTab({
        type: "git_diff",
        worktree_id: options.worktreeId,
        path: options.path,
        scope: options.scope,
        original_path: options.originalPath ?? undefined,
        commit_id: options.commitId ?? undefined,
        preview: options.preview,
      });
      set((state) => {
        const tabs = addTabIfMissing(state.tabs, tab);
        return {
          tabs,
          ...activateLocal(
            {
              ...state,
              tabs,
            } as TabsState,
            tab.id,
          ),
        };
      });

      if (!pendingState.shouldPin || !tab.preview) {
        return tab;
      }

      set((state) => ({
        tabs: sortedTabs(setTabPreviewLocal(state.tabs, tab.id, false)),
        ...activateLocal(state, tab.id),
      }));
      try {
        return await updateTab(tab.id, { preview: false });
      } catch {
        return { ...tab, preview: false };
      }
    })().finally(() => {
      pendingGitDiffOpens.delete(pendingKey);
    });

    pendingGitDiffOpens.set(pendingKey, {
      state: pendingState,
      promise: pendingPromise,
    });

    return pendingPromise;
  },
  async pin(id) {
    const existing = get().tabs.find((tab) => tab.id === id) ?? null;
    if (!existing || !existing.preview) {
      return existing;
    }

    set((state) => ({
      tabs: sortedTabs(setTabPreviewLocal(state.tabs, id, false)),
    }));

    try {
      return await updateTab(id, { preview: false });
    } catch {
      return { ...existing, preview: false };
    }
  },
  async close(id) {
    const closingTab = get().tabs.find((candidate) => candidate.id === id);
    if (!closingTab) {
      return;
    }

    set((state) => removeFromState(state, id));

    try {
      await deleteTab(id);
    } catch {
      // Already gone.
    }

    scheduleDisposeTabModels(closingTab);
  },
  removeLocal(id) {
    const closingTab = get().tabs.find((candidate) => candidate.id === id);
    set((state) => removeFromState(state, id));
    if (closingTab) {
      scheduleDisposeTabModels(closingTab);
    }
  },
  activate(id) {
    set((state) => activateLocal(state, id));
  },
  async reorder(worktreeId, orderedIds) {
    set((state) => {
      const byId = Object.fromEntries(
        state.tabs.map((tab) => [tab.id, tab]),
      ) as Record<string, Tab>;
      const reordered: Tab[] = [];
      for (let index = 0; index < orderedIds.length; index += 1) {
        const tab = byId[orderedIds[index]];
        if (tab) {
          reordered.push({ ...tab, position: index + 1 });
        }
      }
      const otherTabs = state.tabs.filter(
        (tab) => tab.worktree_id !== worktreeId,
      );
      return {
        tabs: sortedTabs([...otherTabs, ...reordered]),
      };
    });

    await reorderTabs(worktreeId, orderedIds);
  },
  switchToWorktree(worktreeId) {
    set((state) => {
      if (state.activeTabId) {
        const current = state.tabs.find((tab) => tab.id === state.activeTabId);
        if (current?.worktree_id === worktreeId) {
          return state;
        }
      }

      const worktreeTabs = tabsForWorktreeInternal(state.tabs, worktreeId);
      const remembered = state.activeTabByWorktree[worktreeId];
      const activeTabId =
        (remembered && worktreeTabs.find((tab) => tab.id === remembered)?.id) ||
        worktreeTabs[0]?.id ||
        null;

      persistSelection(activeTabId, state.activeTabByWorktree);
      return { activeTabId };
    });
  },
}));

let initialized = false;
let eventUnsubscribers: Array<() => void> = [];
let notificationDismissTimer: ReturnType<typeof setTimeout> | null = null;

function clearNotificationDismissTimer(): void {
  if (notificationDismissTimer !== null) {
    clearTimeout(notificationDismissTimer);
    notificationDismissTimer = null;
  }
}

/** Derives the tab ID that needs notification dismissal. */
function notifiedActiveTerminalTabId(state: TabsState): string | null {
  if (!state.activeTabId) return null;
  const tab = state.tabs.find(
    (t) =>
      t.id === state.activeTabId &&
      t.type === "terminal" &&
      !!t.has_notification,
  );
  return tab ? tab.id : null;
}

export function initializeTabStore(): void {
  if (initialized) return;
  initialized = true;

  const events = getEventClient();

  eventUnsubscribers = [
    events.on("snapshot", (data) => {
      const incoming = sortedTabs(data.tabs);
      useTabStore.setState((state) => {
        const incomingIds = new Set(incoming.map((tab) => tab.id));
        const activeTabId =
          state.activeTabId && incomingIds.has(state.activeTabId)
            ? state.activeTabId
            : null;
        const activeTabByWorktree = Object.fromEntries(
          Object.entries(state.activeTabByWorktree).filter(([, tabId]) =>
            incomingIds.has(tabId),
          ),
        );

        if (
          tabsEqual(state.tabs, incoming) &&
          activeTabId === state.activeTabId &&
          activeTabMapEqual(activeTabByWorktree, state.activeTabByWorktree)
        ) {
          return state;
        }

        for (const tab of removedTabs(state.tabs, incoming)) {
          scheduleDisposeTabModels(tab);
        }

        persistSelection(activeTabId, activeTabByWorktree);
        return {
          tabs: incoming,
          activeTabId,
          activeTabByWorktree,
        };
      });
    }),
    events.on("tab_created", ({ tab }) => {
      useTabStore.setState((state) => {
        if (state.tabs.some((candidate) => candidate.id === tab.id)) {
          return state;
        }
        return {
          tabs: sortedTabs([...state.tabs, tab]),
        };
      });
    }),
    events.on("tab_closed", ({ tab_id }) => {
      useTabStore.setState((state) => {
        const closedTab = state.tabs.find((tab) => tab.id === tab_id);
        if (closedTab) {
          scheduleDisposeTabModels(closedTab);
        }
        return removeFromState(state, tab_id);
      });
    }),
    events.on("tab_updated", ({ tab }) => {
      useTabStore.setState((state) => ({
        tabs: sortedTabs(
          state.tabs.map((candidate) =>
            candidate.id === tab.id ? tab : candidate,
          ),
        ),
      }));
    }),
    events.on("tabs_reordered", ({ tabs }) => {
      useTabStore.setState((state) => {
        const reorderedIds = new Set(tabs.map((tab) => tab.id));
        const other = state.tabs.filter((tab) => !reorderedIds.has(tab.id));
        return {
          tabs: sortedTabs([...other, ...tabs]),
        };
      });
    }),
  ];

  // Auto-dismiss terminal notification after a short delay
  // when the notified tab becomes active.
  let prevNotifiedId: string | null = null;
  const unsubscribeNotification = useTabStore.subscribe((state) => {
    const nextId = notifiedActiveTerminalTabId(state);
    if (nextId === prevNotifiedId) return;
    prevNotifiedId = nextId;

    clearNotificationDismissTimer();
    if (!nextId) return;

    notificationDismissTimer = setTimeout(() => {
      notificationDismissTimer = null;
      useTabStore.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === nextId && t.type === "terminal"
            ? { ...t, has_notification: false }
            : t,
        ),
      }));
      void updateTab(nextId, { has_notification: false }).catch(() => {});
    }, 1500);
  });
  eventUnsubscribers.push(unsubscribeNotification);
}

export function resetTabStoreForTests(): void {
  clearNotificationDismissTimer();
  pendingGitDiffOpens.clear();
  for (const unsubscribe of eventUnsubscribers) {
    unsubscribe();
  }
  eventUnsubscribers = [];
  initialized = false;
  useTabStore.setState({
    tabs: [],
    activeTabId: lsGet(LS_ACTIVE_TAB),
    activeTabByWorktree:
      lsGetJson<Record<string, string>>(LS_TAB_BY_WORKTREE) ?? {},
  });
}

export function tabsForWorktree(worktreeId: string): Tab[] {
  return tabsForWorktreeInternal(useTabStore.getState().tabs, worktreeId);
}
