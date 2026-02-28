import {
  listTabs,
  createTab,
  deleteTab,
  eventsUrl,
} from '$lib/api';
import type { Tab } from '$lib/types';

let tabs = $state<Tab[]>([]);
let activeTabId = $state<string | null>(null);
let activeTabByProject = $state<Record<string, string>>(
  {},
);

let eventSource: EventSource | null = null;

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
    if (!tabs.find((t) => t.id === tab.id)) {
      tabs = [...tabs, tab];
    }
    activeTabId = tab.id;
    activeTabByProject[projectId] = tab.id;
    return tab;
  }

  /** Remove tab from local state (shared logic). */
  function removeFromState(id: string) {
    const tab = tabs.find((t) => t.id === id);
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

  /** Remove tab locally (server already closed it). */
  function removeLocal(id: string) {
    removeFromState(id);
  }

  /** Close a tab (tells server to kill PTY). */
  async function close(id: string) {
    if (!tabs.find((t) => t.id === id)) return;
    try {
      await deleteTab(id);
    } catch {
      // Already gone (shell exited, other browser)
    }
    removeFromState(id);
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

  /** Connect to SSE event stream for real-time sync. */
  function connectEvents() {
    if (eventSource) return;
    eventSource = new EventSource(eventsUrl());

    eventSource.onmessage = (ev) => {
      const event = JSON.parse(ev.data);
      switch (event.type) {
        case 'tab_created': {
          const tab = event.data;
          if (!tabs.find((t) => t.id === tab.id)) {
            tabs = [...tabs, tab];
          }
          break;
        }
        case 'tab_closed': {
          removeFromState(event.data.id);
          break;
        }
      }
    };
  }

  /** Disconnect from SSE event stream. */
  function disconnectEvents() {
    eventSource?.close();
    eventSource = null;
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
    removeLocal,
    activate,
    tabsForProject,
    switchToProject,
    connectEvents,
    disconnectEvents,
  };
}
