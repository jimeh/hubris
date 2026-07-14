import type { StateCreator } from "zustand";
import { updateWorktreeTabLayout } from "@/lib/api";
import {
  collapseLayoutToTabs,
  createSinglePaneLayout,
  moveTabBetweenPanes,
  serializePaneTabs,
  splitPaneInLayout,
  sortTabs,
  tabsForPane,
} from "@/lib/tabLayout";
import {
  ensureLayoutsForTabs,
  paneIdsForWorktree,
  preferredPaneTabId,
  promoteTabMru,
  prunePaneFocusHistory,
  pushPaneFocusHistory,
  tabsForWorktreeInternal,
} from "@/lib/stores/tabs/pane-layout";
import { persistSelection } from "@/lib/stores/tabs/persistence";
import {
  activateLocal,
  nextStateAfterWorktreeLayout,
} from "@/lib/stores/tabs/selection";
import { replaceTabs, selectAllTabs } from "@/lib/stores/tabs/selectors";
import type { TabsState } from "@/lib/stores/tabs/types";
import type {
  Tab,
  WorktreeTabLayout,
  WorktreeTabLayoutState,
} from "@/lib/types";

type LayoutActions = Pick<
  TabsState,
  "moveTab" | "createSplitPane" | "splitPane" | "switchToWorktree"
>;
type TabStoreSet = Parameters<StateCreator<TabsState>>[0];
type TabStoreGet = Parameters<StateCreator<TabsState>>[1];

type LayoutSubmission = {
  acknowledged: boolean;
  generation: number;
  httpSettled: boolean;
  signature: string;
};

type LayoutSyncState = {
  confirmed: WorktreeTabLayoutState;
  dirty: boolean;
  generation: number;
  lastSubmittedGeneration: number;
  submissions: LayoutSubmission[];
  tail: Promise<void>;
};

const MAX_LAYOUT_SUBMISSION_HISTORY = 32;
const layoutSyncByWorktree = new Map<string, LayoutSyncState>();

function layoutMutationSignature(state: WorktreeTabLayoutState): string {
  return JSON.stringify({
    rootId: state.layout.rootId,
    nodes: state.layout.nodes,
    panes: serializePaneTabs(state.layout, state.tabs),
  });
}

function matchingSubmissions(
  syncState: LayoutSyncState,
  state: WorktreeTabLayoutState,
): LayoutSubmission[] {
  const signature = layoutMutationSignature(state);
  return syncState.submissions.filter(
    (submission) =>
      !submission.acknowledged && submission.signature === signature,
  );
}

function cleanupSubmissions(syncState: LayoutSyncState): void {
  syncState.submissions = syncState.submissions.filter(
    (submission) => !(submission.acknowledged && submission.httpSettled),
  );
  while (syncState.submissions.length > MAX_LAYOUT_SUBMISSION_HISTORY) {
    const settledIndex = syncState.submissions.findIndex(
      (submission) => submission.httpSettled,
    );
    if (settledIndex < 0) {
      return;
    }
    syncState.submissions.splice(settledIndex, 1);
  }
}

function reconcileLayoutState(
  state: TabsState,
  worktreeId: string,
  authoritative: WorktreeTabLayoutState,
): Partial<TabsState> {
  const authoritativeTabs = new Map(
    authoritative.tabs.map((tab) => [tab.id, tab]),
  );
  const tabs = tabsForWorktreeInternal(selectAllTabs(state), worktreeId).map(
    (tab) => {
      const authoritativeTab = authoritativeTabs.get(tab.id);
      return authoritativeTab
        ? {
            ...tab,
            paneId: authoritativeTab.paneId,
            position: authoritativeTab.position,
          }
        : tab;
    },
  );
  return nextStateAfterWorktreeLayout(state, worktreeId, {
    layout: authoritative.layout,
    tabs,
  });
}

function worktreeLayoutState(
  state: TabsState,
  worktreeId: string,
): WorktreeTabLayoutState {
  const tabs = tabsForWorktreeInternal(selectAllTabs(state), worktreeId);
  return {
    layout:
      state.layoutsByWorktree[worktreeId] ??
      createSinglePaneLayout(tabs[0]?.paneId),
    tabs,
  };
}

/** Marks a local worktree layout mutation before its optimistic state update. */
export function beginLayoutMutation(
  state: TabsState,
  worktreeId: string,
): number {
  const current = worktreeLayoutState(state, worktreeId);
  let syncState = layoutSyncByWorktree.get(worktreeId);
  if (!syncState) {
    syncState = {
      confirmed: current,
      dirty: false,
      generation: 0,
      lastSubmittedGeneration: 0,
      submissions: [],
      tail: Promise.resolve(),
    };
    layoutSyncByWorktree.set(worktreeId, syncState);
  }

  if (!syncState.dirty) {
    syncState.confirmed = current;
  }
  syncState.dirty = true;
  syncState.generation += 1;
  return syncState.generation;
}

function currentLayoutGeneration(worktreeId: string): number {
  return layoutSyncByWorktree.get(worktreeId)?.generation ?? 0;
}

/** Serializes a layout write and reconciles only its owning generation. */
export async function synchronizeLayoutChange(
  projectId: string,
  worktreeId: string,
  desired: WorktreeTabLayoutState,
  set: TabStoreSet,
  get: TabStoreGet,
): Promise<WorktreeTabLayoutState> {
  let syncState = layoutSyncByWorktree.get(worktreeId);
  if (!syncState || !syncState.dirty) {
    beginLayoutMutation(get(), worktreeId);
    syncState = layoutSyncByWorktree.get(worktreeId)!;
  } else if (syncState.lastSubmittedGeneration === syncState.generation) {
    beginLayoutMutation(get(), worktreeId);
  }

  syncState = layoutSyncByWorktree.get(worktreeId)!;
  const generation = syncState.generation;
  syncState.lastSubmittedGeneration = generation;
  const submission: LayoutSubmission = {
    acknowledged: false,
    generation,
    httpSettled: false,
    signature: layoutMutationSignature(desired),
  };
  syncState.submissions.push(submission);
  cleanupSubmissions(syncState);

  const operation = syncState.tail.then(async () => {
    try {
      const serverState = await submitLayoutChange(
        projectId,
        worktreeId,
        desired.layout,
        desired.tabs,
      );
      const canReconcile = !submission.acknowledged;
      if (canReconcile) {
        syncState.confirmed = serverState;
      }
      if (canReconcile && syncState.generation === generation) {
        syncState.dirty = false;
        set((current) =>
          reconcileLayoutState(current, worktreeId, serverState),
        );
      }
      return serverState;
    } catch (error) {
      if (!submission.acknowledged && syncState.generation === generation) {
        syncState.dirty = false;
        set((current) =>
          reconcileLayoutState(current, worktreeId, syncState.confirmed),
        );
      }
      submission.acknowledged = true;
      throw error;
    } finally {
      submission.httpSettled = true;
      cleanupSubmissions(syncState);
    }
  });
  syncState.tail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

/** Reconciles layout SSE without letting an older write replace local intent. */
export function applyWorktreeLayoutEvent(
  state: TabsState,
  worktreeId: string,
  nextState: WorktreeTabLayoutState,
): Partial<TabsState> | TabsState {
  const syncState = layoutSyncByWorktree.get(worktreeId);
  if (!syncState) {
    return nextStateAfterWorktreeLayout(state, worktreeId, nextState);
  }

  const submissions = matchingSubmissions(syncState, nextState);
  syncState.confirmed = nextState;
  if (submissions.length > 0) {
    for (const submission of submissions) {
      submission.acknowledged = true;
    }
    cleanupSubmissions(syncState);
    if (
      submissions.some(
        (submission) => submission.generation === syncState.generation,
      )
    ) {
      syncState.dirty = false;
      return reconcileLayoutState(state, worktreeId, nextState);
    }
    return state;
  }

  if (syncState.dirty) {
    return state;
  }
  return nextStateAfterWorktreeLayout(state, worktreeId, nextState);
}

/** Refreshes rollback state from an authoritative store snapshot. */
export function rebaseLayoutSynchronization(
  state: TabsState,
  worktreeId: string,
): void {
  const syncState = layoutSyncByWorktree.get(worktreeId);
  if (!syncState) {
    return;
  }
  const authoritative = worktreeLayoutState(state, worktreeId);
  const submissions = matchingSubmissions(syncState, authoritative);
  syncState.confirmed = authoritative;
  if (submissions.length > 0) {
    for (const submission of submissions) {
      submission.acknowledged = true;
    }
    if (
      submissions.some(
        (submission) => submission.generation === syncState.generation,
      )
    ) {
      syncState.dirty = false;
    }
    cleanupSubmissions(syncState);
  }
}

/** Keeps confirmed membership current without confirming local layout fields. */
export function rebaseConfirmedTabMembership(
  worktreeId: string,
  tabs: Tab[],
): void {
  const syncState = layoutSyncByWorktree.get(worktreeId);
  if (!syncState) {
    return;
  }
  const confirmedTabs = new Map(
    syncState.confirmed.tabs.map((tab) => [tab.id, tab]),
  );
  const nextTabs = sortTabs(
    tabs.map((tab) => {
      const confirmedTab = confirmedTabs.get(tab.id);
      return confirmedTab
        ? {
            ...tab,
            paneId: confirmedTab.paneId,
            position: confirmedTab.position,
          }
        : tab;
    }),
  );
  syncState.confirmed = {
    layout: collapseLayoutToTabs(syncState.confirmed.layout, nextTabs),
    tabs: nextTabs,
  };
}

/** Rebases confirmed positions without confirming an unpersisted pane move. */
export function rebaseConfirmedTabOrdering(
  worktreeId: string,
  tabs: Tab[],
): void {
  const syncState = layoutSyncByWorktree.get(worktreeId);
  if (!syncState) {
    return;
  }
  const reorderedTabs = new Map(tabs.map((tab) => [tab.id, tab]));
  syncState.confirmed = {
    layout: syncState.confirmed.layout,
    tabs: sortTabs(
      syncState.confirmed.tabs.map((tab) => {
        const reorderedTab = reorderedTabs.get(tab.id);
        return reorderedTab?.paneId === tab.paneId
          ? { ...tab, position: reorderedTab.position }
          : tab;
      }),
    ),
  };
}

/** Clears layout synchronization ownership between store lifecycles. */
export function resetLayoutSynchronization(): void {
  for (const syncState of layoutSyncByWorktree.values()) {
    syncState.generation += 1;
  }
  layoutSyncByWorktree.clear();
}

export async function submitLayoutChange(
  projectId: string,
  worktreeId: string,
  layout: WorktreeTabLayout,
  tabs: Tab[],
): Promise<WorktreeTabLayoutState> {
  return updateWorktreeTabLayout(projectId, worktreeId, {
    rootId: layout.rootId,
    nodes: layout.nodes,
    panes: serializePaneTabs(layout, tabs),
  });
}

export function createLayoutActions(
  set: TabStoreSet,
  get: TabStoreGet,
): LayoutActions {
  return {
    async moveTab(
      projectId,
      worktreeId,
      tabId,
      targetPaneId,
      placement,
      targetTabId,
    ) {
      const state = get();
      const worktreeTabs = tabsForWorktreeInternal(
        selectAllTabs(state),
        worktreeId,
      );
      const layout =
        state.layoutsByWorktree[worktreeId] ??
        createSinglePaneLayout(worktreeTabs[0]?.paneId);
      const targetIndex =
        targetTabId && placement === "center"
          ? tabsForPane(worktreeTabs, targetPaneId).findIndex(
              (tab) => tab.id === targetTabId,
            )
          : undefined;
      const next = moveTabBetweenPanes(
        layout,
        worktreeTabs,
        tabId,
        targetPaneId,
        placement,
        typeof targetIndex === "number" && targetIndex >= 0
          ? targetIndex
          : undefined,
      );
      if (!next) {
        return;
      }

      beginLayoutMutation(state, worktreeId);

      set((current) => {
        const nextTabs = sortTabs([
          ...selectAllTabs(current).filter(
            (tab) => tab.worktreeId !== worktreeId,
          ),
          ...next.tabs,
        ]);
        const nextLayoutsByWorktree = ensureLayoutsForTabs(nextTabs, {
          ...current.layoutsByWorktree,
          [worktreeId]: next.layout,
        });
        const selection = activateLocal(
          {
            ...current,
            ...replaceTabs(current, nextTabs),
            layoutsByWorktree: nextLayoutsByWorktree,
          } as TabsState,
          tabId,
        );
        return {
          ...replaceTabs(current, nextTabs),
          layoutsByWorktree: nextLayoutsByWorktree,
          ...selection,
        };
      });

      await synchronizeLayoutChange(
        projectId,
        worktreeId,
        { layout: next.layout, tabs: next.tabs },
        set,
        get,
      );
    },
    async createSplitPane(projectId, worktreeId, paneId, direction) {
      const state = get();
      const worktreeTabs = tabsForWorktreeInternal(
        selectAllTabs(state),
        worktreeId,
      );
      const layout =
        state.layoutsByWorktree[worktreeId] ??
        createSinglePaneLayout(worktreeTabs[0]?.paneId);
      const next = splitPaneInLayout(
        layout,
        paneId,
        direction === "right" ? "right" : "bottom",
      );
      if (!next) {
        return null;
      }

      beginLayoutMutation(state, worktreeId);

      set((current) => ({
        ...(() => {
          const focusedPaneByWorktree = {
            ...current.focusedPaneByWorktree,
            [worktreeId]: next.destinationPaneId,
          };
          const focusedPaneHistoryByWorktree = pushPaneFocusHistory(
            current.focusedPaneHistoryByWorktree,
            worktreeId,
            next.destinationPaneId,
          );
          const selection = {
            activeTabId: current.activeTabId,
            activeTabByWorktree: current.activeTabByWorktree,
            activeTabByPane: current.activeTabByPane,
            focusedPaneByWorktree,
            focusedPaneHistoryByWorktree,
            tabMruByPane: current.tabMruByPane,
          };
          persistSelection(selection);
          return {
            layoutsByWorktree: {
              ...current.layoutsByWorktree,
              [worktreeId]: next.layout,
            },
            focusedPaneByWorktree,
            focusedPaneHistoryByWorktree,
          };
        })(),
      }));

      await synchronizeLayoutChange(
        projectId,
        worktreeId,
        { layout: next.layout, tabs: worktreeTabs },
        set,
        get,
      );
      return next.destinationPaneId;
    },
    async splitPane(projectId, worktreeId, paneId, direction) {
      const state = get();
      const previousTabs = tabsForWorktreeInternal(
        selectAllTabs(state),
        worktreeId,
      );
      const previousLayout =
        state.layoutsByWorktree[worktreeId] ??
        createSinglePaneLayout(previousTabs[0]?.paneId);
      const destinationPaneId = await get().createSplitPane(
        projectId,
        worktreeId,
        paneId,
        direction,
      );
      const splitGeneration = currentLayoutGeneration(worktreeId);
      try {
        const tab = await get().addTerminal(
          worktreeId,
          destinationPaneId ?? paneId,
        );
        return tab;
      } catch (error) {
        if (currentLayoutGeneration(worktreeId) === splitGeneration) {
          beginLayoutMutation(get(), worktreeId);
          await synchronizeLayoutChange(
            projectId,
            worktreeId,
            { layout: previousLayout, tabs: previousTabs },
            set,
            get,
          );
        }
        throw error;
      }
    },
    switchToWorktree(worktreeId) {
      set((state) => {
        if (state.activeTabId) {
          const current = selectAllTabs(state).find(
            (tab) => tab.id === state.activeTabId,
          );
          if (current?.worktreeId === worktreeId) {
            return state;
          }
        }

        const paneIds = paneIdsForWorktree(
          state.layoutsByWorktree,
          selectAllTabs(state),
          worktreeId,
        );
        if (paneIds.length === 0) {
          const selection = {
            activeTabId: null,
            activeTabByWorktree: state.activeTabByWorktree,
            activeTabByPane: state.activeTabByPane,
            focusedPaneByWorktree: state.focusedPaneByWorktree,
            focusedPaneHistoryByWorktree: state.focusedPaneHistoryByWorktree,
            tabMruByPane: state.tabMruByPane,
          };
          persistSelection(selection);
          return { activeTabId: null };
        }

        const focusedPaneHistory =
          state.focusedPaneHistoryByWorktree[worktreeId]?.filter((paneId) =>
            paneIds.includes(paneId),
          ) ?? [];
        const focusedPaneId =
          focusedPaneHistory[0] ||
          (state.focusedPaneByWorktree[worktreeId] &&
            paneIds.includes(state.focusedPaneByWorktree[worktreeId]) &&
            state.focusedPaneByWorktree[worktreeId]) ||
          paneIds[0];

        const paneTabs = tabsForPane(
          tabsForWorktreeInternal(selectAllTabs(state), worktreeId),
          focusedPaneId,
        );
        const activeTabId = preferredPaneTabId(
          paneTabs,
          state.tabMruByPane[focusedPaneId],
          "first",
        );
        const tabMruByPane =
          activeTabId != null
            ? promoteTabMru(state.tabMruByPane, focusedPaneId, activeTabId)
            : state.tabMruByPane;

        const selection = {
          activeTabId,
          activeTabByWorktree: {
            ...state.activeTabByWorktree,
            ...(activeTabId ? { [worktreeId]: activeTabId } : {}),
          },
          activeTabByPane: {
            ...state.activeTabByPane,
            ...(activeTabId ? { [focusedPaneId]: activeTabId } : {}),
          },
          focusedPaneByWorktree: {
            ...state.focusedPaneByWorktree,
            [worktreeId]: focusedPaneId,
          },
          focusedPaneHistoryByWorktree: prunePaneFocusHistory(
            state.focusedPaneHistoryByWorktree,
            worktreeId,
            paneIds,
            focusedPaneId,
          ),
          tabMruByPane,
        };
        persistSelection(selection);
        return selection;
      });
    },
  };
}
