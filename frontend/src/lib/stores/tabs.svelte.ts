import { createTab, deleteTab } from '$lib/api';
import { getEventClient } from '$lib/events';
import type { Tab } from '$lib/types';

const LS_ACTIVE_TAB = 'hubris-active-tab';
const LS_TAB_BY_WORKTREE = 'hubris-active-tab-by-worktree';

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
        typeof value === 'string' ? value : JSON.stringify(value),
      );
    }
  } catch {
    // localStorage unavailable
  }
}

function persistSelection(): void {
  lsSet(LS_ACTIVE_TAB, activeTabId);
  lsSet(LS_TAB_BY_WORKTREE, activeTabByWorktree);
}

let tabs = $state<Tab[]>([]);
let activeTabId = $state<string | null>(lsGet(LS_ACTIVE_TAB));
const activeTabByWorktree = $state<Record<string, string>>(
  lsGetJson<Record<string, string>>(LS_TAB_BY_WORKTREE) ?? {},
);
let initialized = false;

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

export function getTabStore() {
  if (!initialized) {
    initialized = true;
    const events = getEventClient();

    events.on('snapshot', (data) => {
      const incoming = sortedTabs(data.tabs);
      if (tabsEqual(tabs, incoming)) return;

      tabs = incoming;
      if (activeTabId && !tabs.find((tab) => tab.id === activeTabId)) {
        activeTabId = null;
        persistSelection();
      }
    });

    events.on('tab_created', (tab) => {
      if (!tabs.find((t) => t.id === tab.id)) {
        tabs = sortedTabs([...tabs, tab]);
      }
    });

    events.on('tab_closed', ({ tab_id }) => {
      removeFromState(tab_id);
    });

    events.on('tab_updated', (tab) => {
      tabs = sortedTabs(tabs.map((t) => (t.id === tab.id ? tab : t)));
    });
  }

  function removeFromState(id: string): void {
    const tab = tabs.find((t) => t.id === id);
    tabs = tabs.filter((t) => t.id !== id);
    if (activeTabId === id) {
      const worktreeId = tab?.worktree_id;
      const remaining = worktreeId
        ? tabs.filter((t) => t.worktree_id === worktreeId)
        : tabs;
      activeTabId = remaining[remaining.length - 1]?.id ?? null;
      if (worktreeId) {
        activeTabByWorktree[worktreeId] = activeTabId ?? '';
      }
      persistSelection();
    }
  }

  function removeLocal(id: string): void {
    removeFromState(id);
  }

  async function addTerminal(worktreeId: string): Promise<Tab> {
    const tab = await createTab(worktreeId);
    if (!tabs.find((t) => t.id === tab.id)) {
      tabs = sortedTabs([...tabs, tab]);
    }
    activeTabId = tab.id;
    activeTabByWorktree[worktreeId] = tab.id;
    persistSelection();
    return tab;
  }

  async function close(id: string): Promise<void> {
    if (!tabs.find((t) => t.id === id)) return;
    removeFromState(id);
    try {
      await deleteTab(id);
    } catch {
      // Already gone
    }
  }

  function activate(id: string): void {
    activeTabId = id;
    const tab = tabs.find((t) => t.id === id);
    if (tab) {
      activeTabByWorktree[tab.worktree_id] = id;
    }
    persistSelection();
  }

  function tabsForWorktree(worktreeId: string): Tab[] {
    return tabs.filter((tab) => tab.worktree_id === worktreeId);
  }

  function switchToWorktree(worktreeId: string): void {
    const worktreeTabs = tabsForWorktree(worktreeId);
    const remembered = activeTabByWorktree[worktreeId];
    if (remembered && worktreeTabs.find((tab) => tab.id === remembered)) {
      activeTabId = remembered;
    } else if (worktreeTabs.length > 0) {
      activeTabId = worktreeTabs[0].id;
    } else {
      activeTabId = null;
    }
    persistSelection();
  }

  return {
    get tabs() {
      return tabs;
    },
    get activeTabId() {
      return activeTabId;
    },
    addTerminal,
    close,
    removeLocal,
    activate,
    tabsForWorktree,
    switchToWorktree,
  };
}
