import {
  listTabs,
  createTab,
  deleteTab,
} from '$lib/api';
import type { Tab } from '$lib/types';

let tabs = $state<Tab[]>([]);
let activeTabId = $state<string | null>(null);
let activeTabByProject = $state<Record<string, string>>(
  {},
);

export function getTabStore() {
  /** Fetch all tabs from the server. */
  async function refresh() {
    tabs = await listTabs();
    if (
      activeTabId &&
      !tabs.find((t) => t.id === activeTabId)
    ) {
      activeTabId = null;
    }
  }

  /** Create a new terminal tab for a project. */
  async function addTerminal(
    projectId: string,
  ): Promise<Tab> {
    const tab = await createTab(projectId);
    tabs = [...tabs, tab];
    activeTabId = tab.id;
    activeTabByProject[projectId] = tab.id;
    return tab;
  }

  /** Close a tab (kills the PTY on the server). */
  async function close(id: string) {
    const tab = tabs.find((t) => t.id === id);
    await deleteTab(id);
    tabs = tabs.filter((t) => t.id !== id);
    if (activeTabId === id) {
      const projectId = tab?.project_id;
      const remaining = projectId
        ? tabs.filter((t) => t.project_id === projectId)
        : tabs;
      activeTabId =
        remaining[remaining.length - 1]?.id ?? null;
      if (projectId) {
        activeTabByProject[projectId] =
          activeTabId ?? '';
      }
    }
  }

  function activate(id: string) {
    activeTabId = id;
    const tab = tabs.find((t) => t.id === id);
    if (tab) {
      activeTabByProject[tab.project_id] = id;
    }
  }

  /** Get tabs for a specific project. */
  function tabsForProject(projectId: string): Tab[] {
    return tabs.filter(
      (t) => t.project_id === projectId,
    );
  }

  /**
   * Switch to a project's tabs. Restores the previously
   * active tab for that project.
   */
  function switchToProject(projectId: string) {
    const projectTabs = tabsForProject(projectId);
    const remembered = activeTabByProject[projectId];
    if (
      remembered &&
      projectTabs.find((t) => t.id === remembered)
    ) {
      activeTabId = remembered;
    } else if (projectTabs.length > 0) {
      activeTabId = projectTabs[0].id;
    } else {
      activeTabId = null;
    }
  }

  return {
    get tabs() {
      return tabs;
    },
    get activeTabId() {
      return activeTabId;
    },
    refresh,
    addTerminal,
    close,
    activate,
    tabsForProject,
    switchToProject,
  };
}
