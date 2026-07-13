import type { StateCreator } from "zustand";
import { updateWorktreeTabLayout } from "@/lib/api";
import {
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

      const serverState = await submitLayoutChange(
        projectId,
        worktreeId,
        next.layout,
        next.tabs,
      );
      set((current) =>
        nextStateAfterWorktreeLayout(current, worktreeId, serverState),
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

      const serverState = await submitLayoutChange(
        projectId,
        worktreeId,
        next.layout,
        worktreeTabs,
      );
      set((current) =>
        nextStateAfterWorktreeLayout(current, worktreeId, serverState),
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
      try {
        const tab = await get().addTerminal(
          worktreeId,
          destinationPaneId ?? paneId,
        );
        return tab;
      } catch (error) {
        const serverState = await submitLayoutChange(
          projectId,
          worktreeId,
          previousLayout,
          previousTabs,
        );
        set((current) =>
          nextStateAfterWorktreeLayout(current, worktreeId, serverState),
        );
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
