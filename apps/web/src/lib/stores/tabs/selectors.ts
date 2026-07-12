import { sortTabs } from "@/lib/tabLayout";
import type { TabsState } from "@/lib/stores/tabs/index";
import type { Tab } from "@/lib/types";

const EMPTY_TAB_IDS: string[] = [];
const tabsForIdsCache = new WeakMap<
  string[],
  { tabsById: Record<string, Tab>; tabs: Tab[] }
>();
const allTabsCache = new WeakMap<Record<string, Tab>, Tab[]>();

/** Selects a tab by its server-authoritative ID. */
export function selectTabById(
  state: TabsState,
  tabId: string,
): Tab | undefined {
  return state.tabsById[tabId];
}

/** Selects the stored, position-ordered tab IDs for a worktree. */
export function selectTabIdsForWorktree(
  state: TabsState,
  worktreeId: string,
): string[] {
  return state.tabIdsByWorktree[worktreeId] ?? EMPTY_TAB_IDS;
}

function tabsForIds(state: TabsState, ids: string[]): Tab[] {
  const cached = tabsForIdsCache.get(ids);
  if (
    cached &&
    (cached.tabsById === state.tabsById ||
      ids.every((id, index) => cached.tabs[index] === state.tabsById[id]))
  ) {
    cached.tabsById = state.tabsById;
    return cached.tabs;
  }
  const tabs = ids.flatMap((id) => {
    const tab = state.tabsById[id];
    return tab ? [tab] : [];
  });
  tabsForIdsCache.set(ids, { tabsById: state.tabsById, tabs });
  return tabs;
}

/** Selects the position-ordered tabs for a worktree. */
export function selectTabsForWorktree(
  state: TabsState,
  worktreeId: string,
): Tab[] {
  return tabsForIds(state, selectTabIdsForWorktree(state, worktreeId));
}

/** Selects the position-ordered tabs assigned to a pane. */
export function selectTabsForPane(state: TabsState, paneId: string): Tab[] {
  return tabsForIds(state, state.tabIdsByPane[paneId] ?? EMPTY_TAB_IDS);
}

/** Selects every tab in the store's stable canonical order. */
export function selectAllTabs(state: TabsState): Tab[] {
  const cached = allTabsCache.get(state.tabsById);
  if (cached) {
    return cached;
  }
  const tabs = sortTabs(Object.values(state.tabsById));
  allTabsCache.set(state.tabsById, tabs);
  return tabs;
}

export type NormalizedTabsState = Pick<
  TabsState,
  "tabsById" | "tabIdsByWorktree" | "tabIdsByPane"
>;

function arraysEqual(left: string[] | undefined, right: string[]): boolean {
  return (
    left?.length === right.length &&
    right.every((value, index) => left[index] === value)
  );
}

function reuseEqualIdArrays(
  previous: Record<string, string[]> | undefined,
  next: Record<string, string[]>,
): Record<string, string[]> {
  if (!previous) {
    return next;
  }
  for (const [key, ids] of Object.entries(next)) {
    if (arraysEqual(previous[key], ids)) {
      next[key] = previous[key];
    }
  }
  return next;
}

export function normalizeTabs(
  tabs: Tab[],
  previous?: NormalizedTabsState,
): NormalizedTabsState {
  const sortedTabs = sortTabs(tabs);
  const tabsById = Object.fromEntries(sortedTabs.map((tab) => [tab.id, tab]));
  const tabIdsByWorktree: Record<string, string[]> = {};
  const tabIdsByPane: Record<string, string[]> = {};

  for (const tab of sortedTabs) {
    (tabIdsByWorktree[tab.worktreeId] ??= []).push(tab.id);
    (tabIdsByPane[tab.paneId] ??= []).push(tab.id);
  }

  return {
    tabsById,
    tabIdsByWorktree: reuseEqualIdArrays(
      previous?.tabIdsByWorktree,
      tabIdsByWorktree,
    ),
    tabIdsByPane: reuseEqualIdArrays(previous?.tabIdsByPane, tabIdsByPane),
  };
}

export function replaceTabs(
  state: TabsState,
  tabs: Tab[],
): NormalizedTabsState {
  return normalizeTabs(tabs, state);
}
