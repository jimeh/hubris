import type { Tab } from '$lib/types';

let tabs = $state<Tab[]>([]);
let activeTabId = $state<string | null>(null);

export function getTabStore() {
  function addTerminal(): Tab {
    const id = crypto.randomUUID();
    const num =
      tabs.filter((t) => t.type === 'terminal').length + 1;
    const tab: Tab = {
      id,
      label: `Terminal ${num}`,
      type: 'terminal',
    };
    tabs = [...tabs, tab];
    activeTabId = id;
    return tab;
  }

  function close(id: string) {
    tabs = tabs.filter((t) => t.id !== id);
    if (activeTabId === id) {
      activeTabId = tabs[tabs.length - 1]?.id ?? null;
    }
  }

  function activate(id: string) {
    activeTabId = id;
  }

  function reset() {
    tabs = [];
    activeTabId = null;
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
    activate,
    reset,
  };
}
