import { createTab, deleteTab } from '$lib/api';
import { getEventClient } from '$lib/events';
import type { Tab } from '$lib/types';

const LS_ACTIVE_TAB = 'hubris-active-tab';
const LS_TAB_BY_PROJECT = 'hubris-active-tab-by-project';

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
    // localStorage full or unavailable
  }
}

function persistSelection(): void {
  lsSet(LS_ACTIVE_TAB, activeTabId);
  lsSet(LS_TAB_BY_PROJECT, activeTabByProject);
}

let tabs = $state<Tab[]>([]);
let activeTabId = $state<string | null>(lsGet(LS_ACTIVE_TAB));
const activeTabByProject = $state<Record<string, string>>(
  lsGetJson<Record<string, string>>(LS_TAB_BY_PROJECT) ?? {},
);
let initialized = false;

function sortedTabs(list: Tab[]): Tab[] {
  return [...list].sort((a, b) => a.position - b.position);
}

/** Shallow equality check to skip no-op snapshot updates. */
function tabsEqual(a: Tab[], b: Tab[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].id !== b[i].id ||
      a[i].label !== b[i].label ||
      a[i].position !== b[i].position ||
      a[i].project_id !== b[i].project_id
    )
      return false;
  }
  return true;
}

export function getTabStore() {
  if (!initialized) {
    initialized = true;
    const events = getEventClient();

    events.on<{ tabs: Tab[] }>('snapshot', (data) => {
      const incoming = sortedTabs(data.tabs);
      // Skip update when tabs are unchanged (common on
      // SSE reconnect). Avoids reactive cascade / flash.
      if (tabsEqual(tabs, incoming)) return;

      tabs = incoming;
      // Validate activeTabId still exists
      if (activeTabId && !tabs.find((t) => t.id === activeTabId)) {
        activeTabId = null;
        persistSelection();
      }
    });

    events.on<Tab>('tab_created', (tab) => {
      if (!tabs.find((t) => t.id === tab.id)) {
        tabs = sortedTabs([...tabs, tab]);
      }
    });

    events.on<{ tab_id: string }>('tab_closed', ({ tab_id }) => {
      removeFromState(tab_id);
    });

    events.on<Tab>('tab_updated', (tab) => {
      tabs = sortedTabs(tabs.map((t) => (t.id === tab.id ? tab : t)));
    });
  }

  function removeFromState(id: string) {
    const tab = tabs.find((t) => t.id === id);
    tabs = tabs.filter((t) => t.id !== id);
    if (activeTabId === id) {
      const projectId = tab?.project_id;
      const remaining = projectId
        ? tabs.filter((t) => t.project_id === projectId)
        : tabs;
      activeTabId = remaining[remaining.length - 1]?.id ?? null;
      if (projectId) {
        activeTabByProject[projectId] = activeTabId ?? '';
      }
      persistSelection();
    }
  }

  /** Remove tab locally (server already closed it). */
  function removeLocal(id: string) {
    removeFromState(id);
  }

  /** Create a new terminal tab for a project. */
  async function addTerminal(projectId: string): Promise<Tab> {
    const tab = await createTab(projectId);
    // Optimistic: add immediately, SSE event deduplicates
    if (!tabs.find((t) => t.id === tab.id)) {
      tabs = sortedTabs([...tabs, tab]);
    }
    activeTabId = tab.id;
    activeTabByProject[projectId] = tab.id;
    persistSelection();
    return tab;
  }

  /** Close a tab (tells server to kill PTY). */
  async function close(id: string) {
    if (!tabs.find((t) => t.id === id)) return;
    // Optimistic remove
    removeFromState(id);
    try {
      await deleteTab(id);
    } catch {
      // Already gone (shell exited, other browser)
    }
  }

  function activate(id: string) {
    activeTabId = id;
    const tab = tabs.find((t) => t.id === id);
    if (tab) {
      activeTabByProject[tab.project_id] = id;
    }
    persistSelection();
  }

  /** Get tabs for a specific project. */
  function tabsForProject(projectId: string): Tab[] {
    return tabs.filter((t) => t.project_id === projectId);
  }

  /**
   * Switch to a project's tabs. Restores the previously
   * active tab for that project.
   */
  function switchToProject(projectId: string) {
    const projectTabs = tabsForProject(projectId);
    const remembered = activeTabByProject[projectId];
    if (remembered && projectTabs.find((t) => t.id === remembered)) {
      activeTabId = remembered;
    } else if (projectTabs.length > 0) {
      activeTabId = projectTabs[0].id;
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
    tabsForProject,
    switchToProject,
  };
}
