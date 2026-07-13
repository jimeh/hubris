import { updateTab } from "@/lib/api";
import { getEventClient } from "@/lib/events";
import { scheduleDisposeTabModels } from "@/lib/monacoLazy";
import { sortTabs } from "@/lib/tabLayout";
import { tabsEqual } from "@/lib/stores/tabs/labels";
import {
  addTabIfMissing,
  disposeDesktopBrowserTab,
  removedTabs,
} from "@/lib/stores/tabs/open-flows";
import {
  activeTabMapEqual,
  ensureLayoutsForTabs,
  layoutMapEqual,
  paneHistoryMapEqual,
  tabMruMapEqual,
  tabsForWorktreeInternal,
} from "@/lib/stores/tabs/pane-layout";
import { initialSelection } from "@/lib/stores/tabs/persistence";
import {
  buildRestoreStatePayload,
  clearRestoreStatePersistTimers,
  restoreStateWorktreeIds,
  schedulePersistRestoreState,
  seedSelectionFromBackendRestore,
} from "@/lib/stores/tabs/restore-state";
import {
  nextStateAfterWorktreeLayout,
  reconcileSelection,
  removeFromState,
} from "@/lib/stores/tabs/selection";
import {
  normalizeTabs,
  replaceTabs,
  selectAllTabs,
} from "@/lib/stores/tabs/selectors";
import { resetPendingTabOpens, useTabStore } from "@/lib/stores/tabs/store";
import type { TabsState } from "@/lib/stores/tabs/types";
import { useWorktreeFileManagerStore } from "@/lib/stores/worktreeFileManager";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import type { Tab } from "@/lib/types";

let initialized = false;
let eventUnsubscribers: Array<() => void> = [];
let notificationDismissTimer: ReturnType<typeof setTimeout> | null = null;
let hasHydratedBackendRestoreSelection = false;

function clearNotificationDismissTimer(): void {
  if (notificationDismissTimer !== null) {
    clearTimeout(notificationDismissTimer);
    notificationDismissTimer = null;
  }
}

/** Derives the tab ID that needs notification dismissal. */
function notifiedActiveTerminalTabId(state: TabsState): string | null {
  if (!state.activeTabId) {
    return null;
  }
  const tab = selectAllTabs(state).find(
    (candidate) =>
      candidate.id === state.activeTabId &&
      candidate.type === "terminal" &&
      !!candidate.hasNotification,
  );
  return tab ? tab.id : null;
}

function selectedWorktreeTabsKey(state: TabsState): string {
  const worktreeId = useWorktreeStore.getState().selectedWorktreeId;
  if (!worktreeId) {
    return "";
  }
  return `${worktreeId}:${state.tabIdsByWorktree[worktreeId]?.join(",") ?? ""}`;
}

function syncSelectedWorktreeTab(): void {
  const worktreeId = useWorktreeStore.getState().selectedWorktreeId;
  if (worktreeId) {
    useTabStore.getState().switchToWorktree(worktreeId);
  }
}

function activeEditorPathKey(state: TabsState): string {
  const tab = state.activeTabId ? state.tabsById[state.activeTabId] : null;
  if (tab?.type !== "file" && tab?.type !== "git_diff") {
    return "";
  }
  return `${tab.worktreeId}:${tab.path}`;
}

function syncActiveEditorPath(state: TabsState): void {
  const tab = state.activeTabId ? state.tabsById[state.activeTabId] : null;
  if (tab?.type === "file" || tab?.type === "git_diff") {
    useWorktreeFileManagerStore
      .getState()
      .setSelectedPath(tab.worktreeId, tab.path);
  }
}

export function initializeTabStore(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  const events = getEventClient();

  eventUnsubscribers = [
    events.on("snapshot", (data) => {
      const incomingTabs = sortTabs(data.tabs);
      const incomingLayouts = ensureLayoutsForTabs(
        incomingTabs,
        data.tabLayouts,
      );
      useTabStore.setState((state) => {
        const selectionSeedState = hasHydratedBackendRestoreSelection
          ? state
          : seedSelectionFromBackendRestore(
              state,
              incomingTabs,
              incomingLayouts,
              data.worktreeRestoreState ?? {},
            );
        const selection = reconcileSelection(
          selectionSeedState,
          incomingTabs,
          incomingLayouts,
        );

        if (
          tabsEqual(selectAllTabs(state), incomingTabs) &&
          layoutMapEqual(state.layoutsByWorktree, incomingLayouts) &&
          selection.activeTabId === state.activeTabId &&
          activeTabMapEqual(
            selection.activeTabByWorktree,
            state.activeTabByWorktree,
          ) &&
          activeTabMapEqual(selection.activeTabByPane, state.activeTabByPane) &&
          activeTabMapEqual(
            selection.focusedPaneByWorktree,
            state.focusedPaneByWorktree,
          ) &&
          paneHistoryMapEqual(
            selection.focusedPaneHistoryByWorktree,
            state.focusedPaneHistoryByWorktree,
          ) &&
          tabMruMapEqual(selection.tabMruByPane, state.tabMruByPane)
        ) {
          return state;
        }

        for (const tab of removedTabs(selectAllTabs(state), incomingTabs)) {
          disposeDesktopBrowserTab(tab);
          scheduleDisposeTabModels(tab);
        }

        return {
          ...replaceTabs(state, incomingTabs),
          layoutsByWorktree: incomingLayouts,
          ...selection,
        };
      });
      hasHydratedBackendRestoreSelection = true;
    }),
    events.on("tab_created", ({ tab }) => {
      useTabStore.setState((state) => {
        if (selectAllTabs(state).some((candidate) => candidate.id === tab.id)) {
          return state;
        }
        const nextTabs = addTabIfMissing(selectAllTabs(state), tab);
        const nextLayoutsByWorktree = ensureLayoutsForTabs(
          nextTabs,
          state.layoutsByWorktree,
        );
        return {
          ...replaceTabs(state, nextTabs),
          layoutsByWorktree: nextLayoutsByWorktree,
        };
      });
    }),
    events.on("tab_closed", ({ tabId }) => {
      useTabStore.setState((state) => {
        const closedTab = selectAllTabs(state).find((tab) => tab.id === tabId);
        if (closedTab) {
          disposeDesktopBrowserTab(closedTab);
          scheduleDisposeTabModels(closedTab);
        }
        return removeFromState(state, tabId);
      });
    }),
    events.on("tab_updated", ({ tab }) => {
      useTabStore.setState((state) =>
        replaceTabs(
          state,
          sortTabs(
            selectAllTabs(state).map((candidate) =>
              candidate.id === tab.id ? tab : candidate,
            ),
          ),
        ),
      );
    }),
    events.on("tabs_reordered", ({ tabs }) => {
      useTabStore.setState((state) => {
        const reorderedIds = new Set(tabs.map((tab) => tab.id));
        const nextTabs = sortTabs([
          ...selectAllTabs(state).filter((tab) => !reorderedIds.has(tab.id)),
          ...tabs,
        ]);
        return replaceTabs(state, nextTabs);
      });
    }),
    events.on(
      "worktree_tab_layout_updated",
      ({ worktreeId, state: nextState }) => {
        useTabStore.setState((current) =>
          nextStateAfterWorktreeLayout(current, worktreeId, nextState),
        );
      },
    ),
  ];

  syncSelectedWorktreeTab();
  const unsubscribeWorktreeSelection = useWorktreeStore.subscribe(
    (state, previousState) => {
      if (state.selectedWorktreeId !== previousState.selectedWorktreeId) {
        syncSelectedWorktreeTab();
      }
    },
  );
  eventUnsubscribers.push(unsubscribeWorktreeSelection);

  let previousSelectedWorktreeTabsKey = selectedWorktreeTabsKey(
    useTabStore.getState(),
  );
  let previousActiveEditorPathKey = activeEditorPathKey(useTabStore.getState());
  syncActiveEditorPath(useTabStore.getState());
  const unsubscribeTabCoordination = useTabStore.subscribe((state) => {
    const nextSelectedWorktreeTabsKey = selectedWorktreeTabsKey(state);
    if (nextSelectedWorktreeTabsKey !== previousSelectedWorktreeTabsKey) {
      previousSelectedWorktreeTabsKey = nextSelectedWorktreeTabsKey;
      syncSelectedWorktreeTab();
    }

    const nextActiveEditorPathKey = activeEditorPathKey(state);
    if (nextActiveEditorPathKey !== previousActiveEditorPathKey) {
      previousActiveEditorPathKey = nextActiveEditorPathKey;
      syncActiveEditorPath(state);
    }
  });
  eventUnsubscribers.push(unsubscribeTabCoordination);

  // Auto-dismiss terminal notification after a short delay
  // when the notified tab becomes active.
  let prevNotifiedId: string | null = null;
  const unsubscribeNotification = useTabStore.subscribe((state) => {
    const nextId = notifiedActiveTerminalTabId(state);
    if (nextId === prevNotifiedId) {
      return;
    }
    prevNotifiedId = nextId;

    clearNotificationDismissTimer();
    if (!nextId) {
      return;
    }

    notificationDismissTimer = setTimeout(() => {
      notificationDismissTimer = null;
      useTabStore.setState((state) =>
        replaceTabs(
          state,
          selectAllTabs(state).map((tab) =>
            tab.id === nextId && tab.type === "terminal"
              ? { ...tab, hasNotification: false }
              : tab,
          ),
        ),
      );
      void updateTab(nextId, { hasNotification: false }).catch(() => {});
    }, 1500);
  });
  eventUnsubscribers.push(unsubscribeNotification);

  let previousRestoreStateByWorktree = new Map<string, string>();
  const unsubscribeRestoreState = useTabStore.subscribe((state) => {
    const nextRestoreStateByWorktree = new Map(
      restoreStateWorktreeIds(state).map((worktreeId) => [
        worktreeId,
        JSON.stringify(buildRestoreStatePayload(state, worktreeId)),
      ]),
    );

    if (hasHydratedBackendRestoreSelection) {
      const changedWorktreeIds = new Set([
        ...previousRestoreStateByWorktree.keys(),
        ...nextRestoreStateByWorktree.keys(),
      ]);

      for (const worktreeId of changedWorktreeIds) {
        if (
          previousRestoreStateByWorktree.get(worktreeId) !==
          nextRestoreStateByWorktree.get(worktreeId)
        ) {
          schedulePersistRestoreState(worktreeId, state);
        }
      }
    }

    previousRestoreStateByWorktree = nextRestoreStateByWorktree;
  });
  eventUnsubscribers.push(unsubscribeRestoreState);
}

export function resetTabStoreForTests(): void {
  clearNotificationDismissTimer();
  resetPendingTabOpens();
  clearRestoreStatePersistTimers();
  for (const unsubscribe of eventUnsubscribers) {
    unsubscribe();
  }
  eventUnsubscribers = [];
  initialized = false;
  hasHydratedBackendRestoreSelection = false;
  useTabStore.setState({
    ...normalizeTabs([]),
    layoutsByWorktree: {},
    ...initialSelection(),
  });
}

export function tabsForWorktree(worktreeId: string): Tab[] {
  return tabsForWorktreeInternal(
    selectAllTabs(useTabStore.getState()),
    worktreeId,
  );
}
