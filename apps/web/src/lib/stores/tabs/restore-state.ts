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

const RESTORE_STATE_DEBOUNCE_MS = 250;
const RESTORE_STATE_MAX_RETRY_MS = 5_000;

type RestoreStatePersist = {
  attempt: number;
  generation: number;
  payload: WorktreeRestoreSelection;
  projectId: string;
  timer: ReturnType<typeof setTimeout> | null;
};

const restoreStatePersists = new Map<string, RestoreStatePersist>();

function scheduleRestoreStateAttempt(
  worktreeId: string,
  persist: RestoreStatePersist,
  delay: number,
): void {
  persist.timer = setTimeout(() => {
    persist.timer = null;
    const generation = persist.generation;
    const payload = persist.payload;
    const projectId = persist.projectId;
    void updateWorktreeRestoreState(projectId, worktreeId, payload).then(
      () => {
        if (restoreStatePersists.get(worktreeId) !== persist) {
          return;
        }
        if (persist.generation === generation) {
          restoreStatePersists.delete(worktreeId);
          return;
        }
        persist.attempt = 0;
        scheduleRestoreStateAttempt(
          worktreeId,
          persist,
          RESTORE_STATE_DEBOUNCE_MS,
        );
      },
      () => {
        if (restoreStatePersists.get(worktreeId) !== persist) {
          return;
        }
        if (persist.generation !== generation) {
          persist.attempt = 0;
        } else {
          persist.attempt += 1;
        }
        const retryDelay = Math.min(
          RESTORE_STATE_DEBOUNCE_MS * 2 ** persist.attempt,
          RESTORE_STATE_MAX_RETRY_MS,
        );
        scheduleRestoreStateAttempt(worktreeId, persist, retryDelay);
      },
    );
  }, delay);
}

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
    const pending = restoreStatePersists.get(worktreeId);
    if (pending?.timer) {
      clearTimeout(pending.timer);
    }
    restoreStatePersists.delete(worktreeId);
    return;
  }

  const payload = buildRestoreStatePayload(state, worktreeId);

  const existing = restoreStatePersists.get(worktreeId);
  if (existing) {
    existing.projectId = projectId;
    existing.payload = payload;
    existing.generation += 1;
    existing.attempt = 0;
    if (existing.timer) {
      clearTimeout(existing.timer);
      scheduleRestoreStateAttempt(
        worktreeId,
        existing,
        RESTORE_STATE_DEBOUNCE_MS,
      );
    }
    return;
  }

  const persist: RestoreStatePersist = {
    attempt: 0,
    generation: 1,
    payload,
    projectId,
    timer: null,
  };
  restoreStatePersists.set(worktreeId, persist);
  scheduleRestoreStateAttempt(worktreeId, persist, RESTORE_STATE_DEBOUNCE_MS);
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
  for (const persist of restoreStatePersists.values()) {
    if (persist.timer) {
      clearTimeout(persist.timer);
    }
  }
  restoreStatePersists.clear();
}
