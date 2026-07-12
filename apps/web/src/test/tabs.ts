import { sortTabs } from "@/lib/tabLayout";
import type { TabsState } from "@/lib/stores/tabs";
import type { Tab } from "@/lib/types";

/** Builds the normalized store fields used by tab-store test fixtures. */
export function normalizedTabState(
  tabs: Tab[],
): Pick<TabsState, "tabsById" | "tabIdsByWorktree" | "tabIdsByPane"> {
  const sortedTabs = sortTabs(tabs);
  const tabIdsByWorktree: Record<string, string[]> = {};
  const tabIdsByPane: Record<string, string[]> = {};

  for (const tab of sortedTabs) {
    (tabIdsByWorktree[tab.worktreeId] ??= []).push(tab.id);
    (tabIdsByPane[tab.paneId] ??= []).push(tab.id);
  }

  return {
    tabsById: Object.fromEntries(sortedTabs.map((tab) => [tab.id, tab])),
    tabIdsByWorktree,
    tabIdsByPane,
  };
}
