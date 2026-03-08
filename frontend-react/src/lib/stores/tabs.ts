import { create } from "zustand";
import { createTab, deleteTab, reorderTabs } from "@/lib/api";
import { getEventClient } from "@/lib/events";
import type { Tab } from "@/lib/types";

const LS_ACTIVE_TAB = "hubris-active-tab";
const LS_TAB_BY_WORKTREE = "hubris-active-tab-by-worktree";

type TabsState = {
  tabs: Tab[];
  activeTabId: string | null;
  activeTabByWorktree: Record<string, string>;
  addTerminal: (worktreeId: string) => Promise<Tab>;
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

function tabsEqual(a: Tab[], b: Tab[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (
      a[index].id !== b[index].id ||
      a[index].label !== b[index].label ||
      a[index].position !== b[index].position ||
      a[index].worktree_id !== b[index].worktree_id
    ) {
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

function removeFromState(state: TabsState, id: string): Partial<TabsState> {
  const tab = state.tabs.find((candidate) => candidate.id === id);
  const tabs = state.tabs.filter((candidate) => candidate.id !== id);

  if (state.activeTabId !== id) {
    return { tabs };
  }

  const worktreeId = tab?.worktree_id;
  const remaining = worktreeId
    ? tabs.filter((candidate) => candidate.worktree_id === worktreeId)
    : tabs;
  const activeTabId = remaining[remaining.length - 1]?.id ?? null;
  const activeTabByWorktree = { ...state.activeTabByWorktree };
  if (worktreeId) {
    activeTabByWorktree[worktreeId] = activeTabId ?? "";
  }
  persistSelection(activeTabId, activeTabByWorktree);
  return { tabs, activeTabId, activeTabByWorktree };
}

export const useTabStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: lsGet(LS_ACTIVE_TAB),
  activeTabByWorktree:
    lsGetJson<Record<string, string>>(LS_TAB_BY_WORKTREE) ?? {},
  async addTerminal(worktreeId) {
    const tab = await createTab(worktreeId);
    set((state) => {
      const tabs = state.tabs.some((candidate) => candidate.id === tab.id)
        ? state.tabs
        : sortedTabs([...state.tabs, tab]);
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
  async close(id) {
    if (!get().tabs.some((candidate) => candidate.id === id)) {
      return;
    }

    set((state) => removeFromState(state, id));

    try {
      await deleteTab(id);
    } catch {
      // Already gone.
    }
  },
  removeLocal(id) {
    set((state) => removeFromState(state, id));
  },
  activate(id) {
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === id);
      const activeTabByWorktree = {
        ...state.activeTabByWorktree,
      };
      if (tab) {
        activeTabByWorktree[tab.worktree_id] = id;
      }
      persistSelection(id, activeTabByWorktree);
      return {
        activeTabId: id,
        activeTabByWorktree,
      };
    });
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

        persistSelection(activeTabId, activeTabByWorktree);
        return {
          tabs: incoming,
          activeTabId,
          activeTabByWorktree,
        };
      });
    }),
    events.on("tab_created", (tab) => {
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
      useTabStore.setState((state) => removeFromState(state, tab_id));
    }),
    events.on("tab_updated", (tab) => {
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
        const reorderedIds = tabs.map((tab) => tab.id);
        const other = state.tabs.filter(
          (tab) => !reorderedIds.includes(tab.id),
        );
        return {
          tabs: sortedTabs([...other, ...tabs]),
        };
      });
    }),
  ];
}

export function resetTabStoreForTests(): void {
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
