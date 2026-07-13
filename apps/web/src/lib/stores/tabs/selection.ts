import { collapseLayoutToTabs, sortTabs, tabsForPane } from "@/lib/tabLayout";
import {
  ensureLayoutsForTabs,
  paneIdsForWorktree,
  preferredPaneTabId,
  promoteTabMru,
  pruneTabMruByPane,
  pushPaneFocusHistory,
  tabsForWorktreeInternal,
} from "@/lib/stores/tabs/pane-layout";
import {
  persistSelection,
  type SelectionState,
} from "@/lib/stores/tabs/persistence";
import { replaceTabs, selectAllTabs } from "@/lib/stores/tabs/selectors";
import type { TabsState } from "@/lib/stores/tabs/types";
import type {
  Tab,
  WorktreeTabLayout,
  WorktreeTabLayoutState,
} from "@/lib/types";

export function focusPaneLocal(
  state: TabsState,
  worktreeId: string,
  paneId: string,
): SelectionState {
  const paneTabs = tabsForPane(
    tabsForWorktreeInternal(selectAllTabs(state), worktreeId),
    paneId,
  );
  const nextActiveTabByPane = { ...state.activeTabByPane };
  const nextFocusedPaneByWorktree = {
    ...state.focusedPaneByWorktree,
    [worktreeId]: paneId,
  };
  const nextFocusedPaneHistoryByWorktree = pushPaneFocusHistory(
    state.focusedPaneHistoryByWorktree,
    worktreeId,
    paneId,
  );
  const nextActiveTabByWorktree = { ...state.activeTabByWorktree };
  const activeTabId = preferredPaneTabId(
    paneTabs,
    state.tabMruByPane[paneId],
    "last",
  );
  const nextTabMruByPane =
    activeTabId != null
      ? promoteTabMru(state.tabMruByPane, paneId, activeTabId)
      : state.tabMruByPane;

  if (activeTabId) {
    nextActiveTabByPane[paneId] = activeTabId;
    nextActiveTabByWorktree[worktreeId] = activeTabId;
  } else {
    delete nextActiveTabByPane[paneId];
    delete nextActiveTabByWorktree[worktreeId];
  }

  const selection = {
    activeTabId,
    activeTabByWorktree: nextActiveTabByWorktree,
    activeTabByPane: nextActiveTabByPane,
    focusedPaneByWorktree: nextFocusedPaneByWorktree,
    focusedPaneHistoryByWorktree: nextFocusedPaneHistoryByWorktree,
    tabMruByPane: nextTabMruByPane,
  };
  persistSelection(selection);
  return selection;
}

export function activateLocal(state: TabsState, id: string): SelectionState {
  const tab = selectAllTabs(state).find((candidate) => candidate.id === id);
  if (!tab) {
    const selection = {
      activeTabId: state.activeTabId,
      activeTabByWorktree: state.activeTabByWorktree,
      activeTabByPane: state.activeTabByPane,
      focusedPaneByWorktree: state.focusedPaneByWorktree,
      focusedPaneHistoryByWorktree: state.focusedPaneHistoryByWorktree,
      tabMruByPane: state.tabMruByPane,
    };
    persistSelection(selection);
    return selection;
  }

  const nextFocusedPaneHistoryByWorktree = pushPaneFocusHistory(
    state.focusedPaneHistoryByWorktree,
    tab.worktreeId,
    tab.paneId,
  );
  const nextTabMruByPane = promoteTabMru(state.tabMruByPane, tab.paneId, id);
  const selection = {
    activeTabId: id,
    activeTabByWorktree: {
      ...state.activeTabByWorktree,
      [tab.worktreeId]: id,
    },
    activeTabByPane: {
      ...state.activeTabByPane,
      [tab.paneId]: id,
    },
    focusedPaneByWorktree: {
      ...state.focusedPaneByWorktree,
      [tab.worktreeId]: tab.paneId,
    },
    focusedPaneHistoryByWorktree: nextFocusedPaneHistoryByWorktree,
    tabMruByPane: nextTabMruByPane,
  };
  persistSelection(selection);
  return selection;
}

export function reconcileSelection(
  state: TabsState,
  nextTabs: Tab[],
  nextLayoutsByWorktree: Record<string, WorktreeTabLayout>,
): SelectionState {
  const tabsById = new Map(nextTabs.map((tab) => [tab.id, tab]));
  const previousActiveWorktreeId =
    state.activeTabId &&
    selectAllTabs(state).find((tab) => tab.id === state.activeTabId)
      ?.worktreeId;
  const nextActiveTabByPane = Object.fromEntries(
    Object.entries(state.activeTabByPane).filter(
      ([paneId, tabId]) => tabsById.get(tabId)?.paneId === paneId,
    ),
  );
  const nextFocusedPaneByWorktree: Record<string, string> = {};
  const nextActiveTabByWorktree: Record<string, string> = {};
  const nextFocusedPaneHistoryByWorktree = {
    ...state.focusedPaneHistoryByWorktree,
  };
  const nextTabMruByPane = pruneTabMruByPane(state.tabMruByPane, nextTabs);
  const worktreeIds = new Set([
    ...Object.keys(nextLayoutsByWorktree),
    ...nextTabs.map((tab) => tab.worktreeId),
  ]);

  for (const worktreeId of worktreeIds) {
    const paneIds = paneIdsForWorktree(
      nextLayoutsByWorktree,
      nextTabs,
      worktreeId,
    );
    if (paneIds.length === 0) {
      continue;
    }

    for (const paneId of paneIds) {
      const paneTabs = tabsForPane(
        tabsForWorktreeInternal(nextTabs, worktreeId),
        paneId,
      );
      if (paneTabs.length === 0) {
        delete nextActiveTabByPane[paneId];
        continue;
      }
      if (!paneTabs.some((tab) => tab.id === nextActiveTabByPane[paneId])) {
        const preferredTabId = preferredPaneTabId(
          paneTabs,
          nextTabMruByPane[paneId],
          "last",
        );
        if (preferredTabId) {
          nextActiveTabByPane[paneId] = preferredTabId;
        }
      }
    }

    const focusedPaneId = state.focusedPaneByWorktree[worktreeId];
    const history =
      nextFocusedPaneHistoryByWorktree[worktreeId]?.filter((paneId) =>
        paneIds.includes(paneId),
      ) ?? [];
    const nextFocusedPaneId =
      history.find(
        (paneId) =>
          tabsForPane(tabsForWorktreeInternal(nextTabs, worktreeId), paneId)
            .length > 0,
      ) ||
      (focusedPaneId && paneIds.includes(focusedPaneId) && focusedPaneId) ||
      paneIds.find(
        (paneId) =>
          tabsForPane(tabsForWorktreeInternal(nextTabs, worktreeId), paneId)
            .length > 0,
      ) ||
      paneIds[0];

    nextFocusedPaneByWorktree[worktreeId] = nextFocusedPaneId;
    nextFocusedPaneHistoryByWorktree[worktreeId] = [
      nextFocusedPaneId,
      ...history.filter((paneId) => paneId !== nextFocusedPaneId),
    ];

    const nextActiveForWorktree = nextActiveTabByPane[nextFocusedPaneId];
    if (nextActiveForWorktree) {
      nextActiveTabByWorktree[worktreeId] = nextActiveForWorktree;
    }
  }

  let activeTabId =
    (state.activeTabId &&
      tabsById.has(state.activeTabId) &&
      state.activeTabId) ||
    null;
  if (!activeTabId && previousActiveWorktreeId) {
    activeTabId = nextActiveTabByWorktree[previousActiveWorktreeId] ?? null;
  }

  if (activeTabId) {
    const activeTab = tabsById.get(activeTabId);
    if (activeTab) {
      nextActiveTabByPane[activeTab.paneId] = activeTab.id;
      nextActiveTabByWorktree[activeTab.worktreeId] = activeTab.id;
      nextFocusedPaneByWorktree[activeTab.worktreeId] = activeTab.paneId;
      nextFocusedPaneHistoryByWorktree[activeTab.worktreeId] = [
        activeTab.paneId,
        ...(
          nextFocusedPaneHistoryByWorktree[activeTab.worktreeId] ?? []
        ).filter((paneId) => paneId !== activeTab.paneId),
      ];
    }
  }

  const selection = {
    activeTabId,
    activeTabByWorktree: nextActiveTabByWorktree,
    activeTabByPane: nextActiveTabByPane,
    focusedPaneByWorktree: nextFocusedPaneByWorktree,
    focusedPaneHistoryByWorktree: nextFocusedPaneHistoryByWorktree,
    tabMruByPane: nextTabMruByPane,
  };
  persistSelection(selection);
  return selection;
}

export function nextStateAfterWorktreeLayout(
  state: TabsState,
  worktreeId: string,
  nextLayoutState: WorktreeTabLayoutState,
): Partial<TabsState> {
  const nextTabs = sortTabs([
    ...selectAllTabs(state).filter((tab) => tab.worktreeId !== worktreeId),
    ...nextLayoutState.tabs,
  ]);
  const nextLayoutsByWorktree = ensureLayoutsForTabs(nextTabs, {
    ...state.layoutsByWorktree,
    [worktreeId]: nextLayoutState.layout,
  });
  const selection = reconcileSelection(state, nextTabs, nextLayoutsByWorktree);
  return {
    ...replaceTabs(state, nextTabs),
    layoutsByWorktree: nextLayoutsByWorktree,
    ...selection,
  };
}

export function removeFromState(
  state: TabsState,
  id: string,
): Partial<TabsState> {
  const closingTab = selectAllTabs(state).find(
    (candidate) => candidate.id === id,
  );
  const nextTabs = selectAllTabs(state).filter(
    (candidate) => candidate.id !== id,
  );
  const nextLayoutsByWorktree = { ...state.layoutsByWorktree };

  if (closingTab && nextLayoutsByWorktree[closingTab.worktreeId]) {
    nextLayoutsByWorktree[closingTab.worktreeId] = collapseLayoutToTabs(
      nextLayoutsByWorktree[closingTab.worktreeId],
      tabsForWorktreeInternal(nextTabs, closingTab.worktreeId),
    );
  }

  const normalizedLayouts = ensureLayoutsForTabs(
    nextTabs,
    nextLayoutsByWorktree,
  );
  const selection = reconcileSelection(
    {
      ...state,
      tabMruByPane: pruneTabMruByPane(state.tabMruByPane, nextTabs),
    } as TabsState,
    nextTabs,
    normalizedLayouts,
  );

  return {
    ...replaceTabs(state, nextTabs),
    layoutsByWorktree: normalizedLayouts,
    ...selection,
  };
}
