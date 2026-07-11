import type { TabsState } from "@/lib/stores/tabs/index";

const LS_ACTIVE_TAB = "hubris-active-tab";
const LS_TAB_BY_WORKTREE = "hubris-active-tab-by-worktree";
const LS_TAB_BY_PANE = "hubris-active-tab-by-pane";
const LS_FOCUSED_PANE_BY_WORKTREE = "hubris-focused-pane-by-worktree";
const LS_PANE_MRU_BY_WORKTREE = "hubris-pane-mru-by-worktree";
const LS_TAB_MRU_BY_PANE = "hubris-tab-mru-by-pane";

export type PersistedSelection = Pick<
  TabsState,
  | "activeTabId"
  | "activeTabByWorktree"
  | "activeTabByPane"
  | "focusedPaneByWorktree"
  | "tabMruByPane"
>;

export type SelectionState = PersistedSelection &
  Pick<TabsState, "focusedPaneHistoryByWorktree">;

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsGetJson<T>(key: string): T | null {
  const raw = lsGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: unknown): void {
  try {
    if (value == null) {
      localStorage.removeItem(key);
      return;
    }

    localStorage.setItem(
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  } catch {
    // localStorage unavailable
  }
}

export function compactRecord(
  record: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => Boolean(value)),
  );
}

export function compactArrayRecord(
  record: Record<string, string[]>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value.length > 0),
  );
}

export function persistSelection(selection: SelectionState): void {
  lsSet(LS_ACTIVE_TAB, selection.activeTabId);
  lsSet(LS_TAB_BY_WORKTREE, compactRecord(selection.activeTabByWorktree));
  lsSet(LS_TAB_BY_PANE, compactRecord(selection.activeTabByPane));
  lsSet(
    LS_FOCUSED_PANE_BY_WORKTREE,
    compactRecord(selection.focusedPaneByWorktree),
  );
  lsSet(
    LS_PANE_MRU_BY_WORKTREE,
    compactArrayRecord(selection.focusedPaneHistoryByWorktree),
  );
  lsSet(LS_TAB_MRU_BY_PANE, compactArrayRecord(selection.tabMruByPane));
}

function initialFocusedPaneHistory(
  focusedPaneByWorktree: Record<string, string>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(focusedPaneByWorktree)
      .filter(([, paneId]) => Boolean(paneId))
      .map(([worktreeId, paneId]) => [worktreeId, [paneId]]),
  );
}

export function initialSelection(): SelectionState {
  const focusedPaneByWorktree =
    lsGetJson<Record<string, string>>(LS_FOCUSED_PANE_BY_WORKTREE) ?? {};
  const focusedPaneHistoryByWorktree =
    lsGetJson<Record<string, string[]>>(LS_PANE_MRU_BY_WORKTREE) ??
    initialFocusedPaneHistory(focusedPaneByWorktree);
  const activeTabByPane =
    lsGetJson<Record<string, string>>(LS_TAB_BY_PANE) ?? {};
  const tabMruByPane =
    lsGetJson<Record<string, string[]>>(LS_TAB_MRU_BY_PANE) ??
    Object.fromEntries(
      Object.entries(activeTabByPane)
        .filter(([, tabId]) => Boolean(tabId))
        .map(([paneId, tabId]) => [paneId, [tabId]]),
    );
  return {
    activeTabId: lsGet(LS_ACTIVE_TAB),
    activeTabByWorktree:
      lsGetJson<Record<string, string>>(LS_TAB_BY_WORKTREE) ?? {},
    activeTabByPane,
    focusedPaneByWorktree,
    focusedPaneHistoryByWorktree,
    tabMruByPane,
  };
}
