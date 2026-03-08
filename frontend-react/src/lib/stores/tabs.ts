import { create } from "zustand";
import { createTab, deleteTab, reorderTabs } from "@/lib/api";
import { getEventClient } from "@/lib/events";
import type { Tab } from "@/lib/types";

const LS_ACTIVE_TAB = "hubris-active-tab";
const LS_TAB_BY_WORKTREE = "hubris-active-tab-by-worktree";

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

function sortedTabs(list: Tab[]): Tab[] {
  return [...list].sort((a, b) => a.position - b.position);
}

function tabsEqual(a: Tab[], b: Tab[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].id !== b[i].id ||
      a[i].label !== b[i].label ||
      a[i].position !== b[i].position ||
      a[i].worktree_id !== b[i].worktree_id
    ) {
      return false;
    }
  }
  return true;
}

interface TabState {
  tabs: Tab[];
  activeTabId: string | null;
  activeTabByWorktree: Record<string, string>;

  addTerminal: (worktreeId: string) => Promise<Tab>;
  close: (id: string) => Promise<void>;
  removeLocal: (id: string) => void;
  activate: (id: string) => void;
  reorder: (worktreeId: string, orderedIds: string[]) => Promise<void>;
  tabsForWorktree: (worktreeId: string) => Tab[];
  switchToWorktree: (worktreeId: string) => void;
}

function persistSelection(state: {
  activeTabId: string | null;
  activeTabByWorktree: Record<string, string>;
}): void {
  lsSet(LS_ACTIVE_TAB, state.activeTabId);
  lsSet(LS_TAB_BY_WORKTREE, state.activeTabByWorktree);
}

function removeFromState(
  get: () => TabState,
  set: (partial: Partial<TabState>) => void,
  id: string,
): void {
  const { tabs, activeTabId, activeTabByWorktree } = get();
  const tab = tabs.find((t) => t.id === id);
  const nextTabs = tabs.filter((t) => t.id !== id);

  let nextActiveTabId = activeTabId;
  const nextByWorktree = { ...activeTabByWorktree };

  if (activeTabId === id) {
    const worktreeId = tab?.worktree_id;
    const remaining = worktreeId
      ? nextTabs.filter((t) => t.worktree_id === worktreeId)
      : nextTabs;
    nextActiveTabId = remaining[remaining.length - 1]?.id ?? null;
    if (worktreeId) {
      nextByWorktree[worktreeId] = nextActiveTabId ?? "";
    }
  }

  const nextState = {
    tabs: nextTabs,
    activeTabId: nextActiveTabId,
    activeTabByWorktree: nextByWorktree,
  };
  set(nextState);
  persistSelection(nextState);
}

export const useTabStore = create<TabState>((set, get) => {
  const events = getEventClient();

  events.on("snapshot", (data) => {
    const incoming = sortedTabs(data.tabs);
    const { tabs, activeTabId, activeTabByWorktree } = get();
    if (tabsEqual(tabs, incoming)) return;

    let nextActiveTabId = activeTabId;
    if (activeTabId && !incoming.find((tab) => tab.id === activeTabId)) {
      nextActiveTabId = null;
    }

    const nextState = {
      tabs: incoming,
      activeTabId: nextActiveTabId,
      activeTabByWorktree,
    };
    set(nextState);
    if (nextActiveTabId !== activeTabId) {
      persistSelection(nextState);
    }
  });

  events.on("tab_created", (tab) => {
    const { tabs } = get();
    if (!tabs.find((t) => t.id === tab.id)) {
      set({ tabs: sortedTabs([...tabs, tab]) });
    }
  });

  events.on("tab_closed", ({ tab_id }) => {
    removeFromState(get, set, tab_id);
  });

  events.on("tab_updated", (tab) => {
    const { tabs } = get();
    set({
      tabs: sortedTabs(tabs.map((t) => (t.id === tab.id ? tab : t))),
    });
  });

  events.on("tabs_reordered", ({ tabs: reordered }) => {
    const { tabs } = get();
    const reorderedIds = reordered.map((t) => t.id);
    const other = tabs.filter((t) => !reorderedIds.includes(t.id));
    set({ tabs: sortedTabs([...other, ...reordered]) });
  });

  return {
    tabs: [],
    activeTabId: lsGet(LS_ACTIVE_TAB),
    activeTabByWorktree:
      lsGetJson<Record<string, string>>(LS_TAB_BY_WORKTREE) ?? {},

    async addTerminal(worktreeId: string): Promise<Tab> {
      const tab = await createTab(worktreeId);
      const { tabs, activeTabByWorktree } = get();
      if (!tabs.find((t) => t.id === tab.id)) {
        set({ tabs: sortedTabs([...tabs, tab]) });
      }
      const nextState = {
        activeTabId: tab.id,
        activeTabByWorktree: {
          ...activeTabByWorktree,
          [worktreeId]: tab.id,
        },
      };
      set(nextState);
      persistSelection({ ...get(), ...nextState });
      return tab;
    },

    async close(id: string): Promise<void> {
      const { tabs } = get();
      if (!tabs.find((t) => t.id === id)) return;
      removeFromState(get, set, id);
      try {
        await deleteTab(id);
      } catch {
        // Already gone
      }
    },

    removeLocal(id: string): void {
      removeFromState(get, set, id);
    },

    activate(id: string): void {
      const { tabs, activeTabByWorktree } = get();
      const tab = tabs.find((t) => t.id === id);
      const nextByWorktree = { ...activeTabByWorktree };
      if (tab) {
        nextByWorktree[tab.worktree_id] = id;
      }
      const nextState = {
        activeTabId: id,
        activeTabByWorktree: nextByWorktree,
      };
      set(nextState);
      persistSelection({ ...get(), ...nextState });
    },

    tabsForWorktree(worktreeId: string): Tab[] {
      return get().tabs.filter((tab) => tab.worktree_id === worktreeId);
    },

    async reorder(worktreeId: string, orderedIds: string[]): Promise<void> {
      const { tabs } = get();
      // Optimistic local update
      const byId = Object.fromEntries(tabs.map((t) => [t.id, t])) as Record<
        string,
        Tab
      >;
      const reordered: Tab[] = [];
      for (let i = 0; i < orderedIds.length; i++) {
        const t = byId[orderedIds[i]];
        if (t) {
          reordered.push({ ...t, position: i + 1 });
        }
      }
      const otherTabs = tabs.filter((t) => t.worktree_id !== worktreeId);
      set({ tabs: sortedTabs([...otherTabs, ...reordered]) });

      await reorderTabs(worktreeId, orderedIds);
    },

    switchToWorktree(worktreeId: string): void {
      const { tabs, activeTabId, activeTabByWorktree } = get();

      // If the active tab already belongs to this worktree, keep it.
      if (activeTabId) {
        const current = tabs.find((t) => t.id === activeTabId);
        if (current?.worktree_id === worktreeId) return;
      }

      const worktreeTabs = tabs.filter((t) => t.worktree_id === worktreeId);
      const remembered = activeTabByWorktree[worktreeId];
      let nextActiveTabId: string | null = null;
      if (remembered && worktreeTabs.find((tab) => tab.id === remembered)) {
        nextActiveTabId = remembered;
      } else if (worktreeTabs.length > 0) {
        nextActiveTabId = worktreeTabs[0].id;
      }

      const nextState = {
        activeTabId: nextActiveTabId,
        activeTabByWorktree,
      };
      set(nextState);
      persistSelection(nextState);
    },
  };
});
