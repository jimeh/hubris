import {
  collectPaneIds,
  createSinglePaneLayout,
  firstPaneId,
  sortTabs,
} from "@/lib/tabLayout";
import {
  compactArrayRecord,
  compactRecord,
} from "@/lib/stores/tabs/persistence";
import { selectAllTabs } from "@/lib/stores/tabs/selectors";
import type { TabsState } from "@/lib/stores/tabs/index";
import type { Tab, WorktreeTabLayout } from "@/lib/types";

const DEFAULT_ROOT_PANE_ID = "pane-1";

export function layoutEqual(
  left: WorktreeTabLayout | undefined,
  right: WorktreeTabLayout | undefined,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function layoutMapEqual(
  a: Record<string, WorktreeTabLayout>,
  b: Record<string, WorktreeTabLayout>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (!layoutEqual(a[key], b[key])) {
      return false;
    }
  }
  return true;
}

export function tabsForWorktreeInternal(
  tabs: Tab[],
  worktreeId: string,
): Tab[] {
  return sortTabs(tabs.filter((tab) => tab.worktreeId === worktreeId));
}

export function ensureLayoutsForTabs(
  tabs: Tab[],
  layoutsByWorktree: Record<string, WorktreeTabLayout>,
): Record<string, WorktreeTabLayout> {
  const nextLayouts = { ...layoutsByWorktree };
  for (const tab of tabs) {
    if (!nextLayouts[tab.worktreeId]) {
      nextLayouts[tab.worktreeId] = createSinglePaneLayout(tab.paneId);
    }
  }
  return nextLayouts;
}

export function paneIdsForWorktree(
  layoutsByWorktree: Record<string, WorktreeTabLayout>,
  tabs: Tab[],
  worktreeId: string,
): string[] {
  const fromLayout = collectPaneIds(layoutsByWorktree[worktreeId]);
  if (fromLayout.length > 0) {
    return fromLayout;
  }

  return Array.from(
    new Set(tabsForWorktreeInternal(tabs, worktreeId).map((tab) => tab.paneId)),
  );
}

function resolvePaneIdForOpen(
  state: TabsState,
  worktreeId: string,
  requestedPaneId?: string,
): string {
  const paneIds = paneIdsForWorktree(
    state.layoutsByWorktree,
    selectAllTabs(state),
    worktreeId,
  );

  if (requestedPaneId && paneIds.includes(requestedPaneId)) {
    return requestedPaneId;
  }

  const focusedPaneId = state.focusedPaneByWorktree[worktreeId];
  if (focusedPaneId && paneIds.includes(focusedPaneId)) {
    return focusedPaneId;
  }

  return (
    firstPaneId(state.layoutsByWorktree[worktreeId]) ??
    tabsForWorktreeInternal(selectAllTabs(state), worktreeId)[0]?.paneId ??
    requestedPaneId ??
    DEFAULT_ROOT_PANE_ID
  );
}

export function resolvedPaneIdOrNew(
  state: TabsState,
  worktreeId: string,
  requestedPaneId?: string,
): string {
  const paneId = resolvePaneIdForOpen(state, worktreeId, requestedPaneId);
  return paneId || DEFAULT_ROOT_PANE_ID;
}

export function activeTabMapEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  return JSON.stringify(compactRecord(a)) === JSON.stringify(compactRecord(b));
}

export function paneHistoryMapEqual(
  a: Record<string, string[]>,
  b: Record<string, string[]>,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function tabMruMapEqual(
  a: Record<string, string[]>,
  b: Record<string, string[]>,
): boolean {
  return (
    JSON.stringify(compactArrayRecord(a)) ===
    JSON.stringify(compactArrayRecord(b))
  );
}

export function pushPaneFocusHistory(
  historyByWorktree: Record<string, string[]>,
  worktreeId: string,
  paneId: string,
): Record<string, string[]> {
  const nextHistory = [
    paneId,
    ...(historyByWorktree[worktreeId] ?? []).filter(
      (candidate) => candidate !== paneId,
    ),
  ];
  return {
    ...historyByWorktree,
    [worktreeId]: nextHistory,
  };
}

export function promoteTabMru(
  tabMruByPane: Record<string, string[]>,
  paneId: string,
  tabId: string,
): Record<string, string[]> {
  const nextEntries = Object.entries(tabMruByPane).map(
    ([candidatePaneId, ids]) => [
      candidatePaneId,
      ids.filter((candidateId) => candidateId !== tabId),
    ],
  );
  const nextTabMruByPane = compactArrayRecord(
    Object.fromEntries(nextEntries) as Record<string, string[]>,
  );
  nextTabMruByPane[paneId] = [
    tabId,
    ...(nextTabMruByPane[paneId] ?? []).filter(
      (candidateId) => candidateId !== tabId,
    ),
  ];
  return nextTabMruByPane;
}

export function pruneTabMruByPane(
  tabMruByPane: Record<string, string[]>,
  tabs: Tab[],
): Record<string, string[]> {
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  return compactArrayRecord(
    Object.fromEntries(
      Object.entries(tabMruByPane).map(([paneId, tabIds]) => {
        const seen = new Set<string>();
        const nextTabIds = tabIds.filter((tabId) => {
          const tab = tabsById.get(tabId);
          if (!tab || tab.paneId !== paneId || seen.has(tabId)) {
            return false;
          }
          seen.add(tabId);
          return true;
        });
        return [paneId, nextTabIds];
      }),
    ) as Record<string, string[]>,
  );
}

export function preferredPaneTabId(
  paneTabs: Tab[],
  tabMru: string[] | undefined,
  fallback: "first" | "last",
): string | null {
  const tabIds = new Set(paneTabs.map((tab) => tab.id));
  const preferredId =
    tabMru?.find((tabId) => tabIds.has(tabId)) ??
    (fallback === "first" ? paneTabs[0]?.id : paneTabs.at(-1)?.id) ??
    null;
  return preferredId;
}

export function prunePaneFocusHistory(
  historyByWorktree: Record<string, string[]>,
  worktreeId: string,
  paneIds: string[],
  preferredPaneId?: string,
): Record<string, string[]> {
  const paneIdSet = new Set(paneIds);
  const preserved = (historyByWorktree[worktreeId] ?? []).filter(
    (paneId, index, array) =>
      paneIdSet.has(paneId) && array.indexOf(paneId) === index,
  );
  const nextHistory =
    preferredPaneId && paneIdSet.has(preferredPaneId)
      ? [
          preferredPaneId,
          ...preserved.filter((paneId) => paneId !== preferredPaneId),
        ]
      : preserved;

  return {
    ...historyByWorktree,
    [worktreeId]: nextHistory,
  };
}
