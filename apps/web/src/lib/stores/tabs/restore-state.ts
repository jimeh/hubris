import { updateWorktreeRestoreState } from "@/lib/api";
import { tabsForPane } from "@/lib/tabLayout";
import {
  paneIdsForWorktree,
  preferredPaneTabId,
  promoteTabMru,
  tabsForWorktreeInternal,
} from "@/lib/stores/tabs/pane-layout";
import { selectAllTabs } from "@/lib/stores/tabs/selectors";
import type { TabsState } from "@/lib/stores/tabs/types";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import type { Tab, WorktreeTabLayout } from "@/lib/types";

type WorktreeRestoreSelection = {
  activeTabId?: string | null;
  focusedPaneId?: string | null;
  paneMru?: string[] | null;
  tabMruByPane?: Record<string, string[]> | null;
};

function projectIdForWorktree(worktreeId: string): string | null {
  for (const [projectId, worktrees] of Object.entries(
    useWorktreeStore.getState().worktreesByProject,
  )) {
    if (worktrees.some((worktree) => worktree.id === worktreeId)) {
      return projectId;
    }
  }
  return null;
}

const restoreStatePersistTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

export function buildRestoreStatePayload(
  state: TabsState,
  worktreeId: string,
): WorktreeRestoreSelection {
  const activeTabId = state.activeTabByWorktree[worktreeId] ?? null;
  const focusedPaneId = state.focusedPaneByWorktree[worktreeId] ?? null;
  const paneIds = paneIdsForWorktree(
    state.layoutsByWorktree,
    selectAllTabs(state),
    worktreeId,
  );
  const paneMru =
    state.focusedPaneHistoryByWorktree[worktreeId]?.filter((paneId) =>
      paneIds.includes(paneId),
    ) ?? [];
  const tabMruByPane = Object.fromEntries(
    paneIds
      .map((paneId) => [
        paneId,
        (state.tabMruByPane[paneId] ?? []).filter(
          (tabId) =>
            selectAllTabs(state).find(
              (tab) =>
                tab.id === tabId &&
                tab.worktreeId === worktreeId &&
                tab.paneId === paneId,
            ) != null,
        ),
      ])
      .filter(([, tabIds]) => tabIds.length > 0),
  );

  return {
    activeTabId,
    focusedPaneId,
    paneMru,
    tabMruByPane,
  };
}

export function schedulePersistRestoreState(
  worktreeId: string,
  state: TabsState,
): void {
  const projectId = projectIdForWorktree(worktreeId);
  if (!projectId) {
    return;
  }

  const payload = buildRestoreStatePayload(state, worktreeId);

  const existingTimer = restoreStatePersistTimers.get(worktreeId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  restoreStatePersistTimers.set(
    worktreeId,
    setTimeout(() => {
      restoreStatePersistTimers.delete(worktreeId);
      void updateWorktreeRestoreState(projectId, worktreeId, payload).catch(
        () => {},
      );
    }, 250),
  );
}

export function restoreStateWorktreeIds(state: TabsState): string[] {
  const worktreeIds = new Set([
    ...Object.keys(state.layoutsByWorktree),
    ...Object.keys(state.activeTabByWorktree),
    ...Object.keys(state.focusedPaneByWorktree),
    ...Object.keys(state.focusedPaneHistoryByWorktree),
  ]);
  for (const tab of selectAllTabs(state)) {
    worktreeIds.add(tab.worktreeId);
  }
  return [...worktreeIds];
}

export function seedSelectionFromBackendRestore(
  state: TabsState,
  tabs: Tab[],
  layoutsByWorktree: Record<string, WorktreeTabLayout>,
  restoreStateByWorktree: Record<string, WorktreeRestoreSelection>,
): TabsState {
  const nextActiveTabByWorktree = { ...state.activeTabByWorktree };
  const nextActiveTabByPane = { ...state.activeTabByPane };
  const nextFocusedPaneByWorktree = { ...state.focusedPaneByWorktree };
  const nextFocusedPaneHistoryByWorktree = {
    ...state.focusedPaneHistoryByWorktree,
  };
  let nextTabMruByPane = { ...state.tabMruByPane };

  for (const [worktreeId, restoreState] of Object.entries(
    restoreStateByWorktree,
  )) {
    const worktreeTabs = tabsForWorktreeInternal(tabs, worktreeId);
    const paneIds = paneIdsForWorktree(layoutsByWorktree, tabs, worktreeId);
    if (paneIds.length === 0) {
      continue;
    }

    const activeTab = restoreState.activeTabId
      ? (tabs.find(
          (tab) =>
            tab.id === restoreState.activeTabId &&
            tab.worktreeId === worktreeId,
        ) ?? null)
      : null;
    const paneMru = (
      restoreState.paneMru?.filter((paneId) => paneIds.includes(paneId)) ?? []
    ).filter((paneId, index, list) => list.indexOf(paneId) === index);
    const focusedPaneId =
      paneMru[0] ||
      (restoreState.focusedPaneId &&
      paneIds.includes(restoreState.focusedPaneId)
        ? restoreState.focusedPaneId
        : null) ||
      activeTab?.paneId ||
      paneIds[0];

    const focusedPaneHistory = [
      focusedPaneId,
      ...paneMru.filter((paneId) => paneId !== focusedPaneId),
    ];

    nextFocusedPaneByWorktree[worktreeId] = focusedPaneId;
    nextFocusedPaneHistoryByWorktree[worktreeId] = focusedPaneHistory;

    for (const paneId of paneIds) {
      const paneTabs = tabsForPane(worktreeTabs, paneId);
      const paneTabIds = new Set(paneTabs.map((tab) => tab.id));
      const paneMruTabs = (
        restoreState.tabMruByPane?.[paneId]?.filter((tabId) =>
          paneTabIds.has(tabId),
        ) ?? []
      ).filter((tabId, index, list) => list.indexOf(tabId) === index);
      if (paneMruTabs.length > 0) {
        nextTabMruByPane[paneId] = paneMruTabs;
        nextActiveTabByPane[paneId] = paneMruTabs[0];
      }
    }

    if (activeTab) {
      nextTabMruByPane = promoteTabMru(
        nextTabMruByPane,
        activeTab.paneId,
        activeTab.id,
      );
      nextActiveTabByWorktree[worktreeId] = activeTab.id;
      nextActiveTabByPane[activeTab.paneId] = activeTab.id;
    } else {
      const activePaneTabId = preferredPaneTabId(
        tabsForPane(worktreeTabs, focusedPaneId),
        nextTabMruByPane[focusedPaneId],
        "first",
      );
      if (activePaneTabId) {
        nextActiveTabByWorktree[worktreeId] = activePaneTabId;
        nextActiveTabByPane[focusedPaneId] = activePaneTabId;
      }
    }
  }

  const selectedWorktreeId = useWorktreeStore.getState().selectedWorktreeId;
  const activeTabId =
    (selectedWorktreeId &&
      nextActiveTabByWorktree[selectedWorktreeId] &&
      nextActiveTabByWorktree[selectedWorktreeId]) ||
    state.activeTabId;

  return {
    ...state,
    activeTabId,
    activeTabByWorktree: nextActiveTabByWorktree,
    activeTabByPane: nextActiveTabByPane,
    focusedPaneByWorktree: nextFocusedPaneByWorktree,
    focusedPaneHistoryByWorktree: nextFocusedPaneHistoryByWorktree,
    tabMruByPane: nextTabMruByPane,
  };
}

export function clearRestoreStatePersistTimers(): void {
  for (const timer of restoreStatePersistTimers.values()) {
    clearTimeout(timer);
  }
  restoreStatePersistTimers.clear();
}
