import { create } from "zustand";
import {
  createTab,
  createTerminalTab,
  deleteTab,
  reorderTabs,
  updateTab,
  updateWorktreeRestoreState,
  updateWorktreeTabLayout,
} from "@/lib/api";
import {
  BLANK_BROWSER_URL,
  browserLabelFromUrl,
  normalizeBrowserUrl,
} from "@/lib/browserTabs";
import {
  desktopBrowserBridge,
  hasDesktopBrowserBridge,
} from "@/lib/desktopBrowser";
import { getEventClient } from "@/lib/events";
import { scheduleDisposeTabModels } from "@/lib/monaco";
import {
  collapseLayoutToTabs,
  collectPaneIds,
  createSinglePaneLayout,
  firstPaneId,
  moveTabBetweenPanes,
  setPaneSplitRatio,
  serializePaneTabs,
  splitPaneInLayout,
  sortTabs,
  tabsForPane,
  type PaneDropPlacement,
} from "@/lib/tabLayout";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import type {
  BrowserTab,
  GitDiffScope,
  GitDiffTab,
  Tab,
  WorktreeTabLayout,
  WorktreeTabLayoutState,
} from "@/lib/types";

const LS_ACTIVE_TAB = "hubris-active-tab";
const LS_TAB_BY_WORKTREE = "hubris-active-tab-by-worktree";
const LS_TAB_BY_PANE = "hubris-active-tab-by-pane";
const LS_FOCUSED_PANE_BY_WORKTREE = "hubris-focused-pane-by-worktree";
const LS_PANE_MRU_BY_WORKTREE = "hubris-pane-mru-by-worktree";
const LS_TAB_MRU_BY_PANE = "hubris-tab-mru-by-pane";
const DEFAULT_ROOT_PANE_ID = "pane-1";

// Shares one createTab request across click+double-click for the same diff,
// letting the later event upgrade the eventual tab from preview to pinned.
const pendingGitDiffOpens = new Map<string, PendingGitDiffOpen>();
const pendingAgentChatOpens = new Map<string, Promise<Tab>>();

type OpenFileOptions = {
  worktreeId: string;
  path: string;
  preview: boolean;
  paneId?: string;
};

type OpenGitDiffOptions = {
  worktreeId: string;
  path: string;
  scope: GitDiffScope;
  originalPath?: string | null;
  commitId?: string | null;
  preview: boolean;
  paneId?: string;
};

type OpenBrowserOptions = {
  worktreeId: string;
  url?: string;
  paneId?: string;
};

type OpenAgentChatOptions = {
  worktreeId: string;
  conversationId?: string;
  paneId?: string;
};

type BrowserTabUpdate = {
  label?: string;
  url?: string;
  history?: string[];
  historyIndex?: number;
};

type PendingGitDiffOpen = {
  state: {
    shouldPin: boolean;
  };
  promise: Promise<Tab>;
};

type TabsState = {
  tabs: Tab[];
  layoutsByWorktree: Record<string, WorktreeTabLayout>;
  activeTabId: string | null;
  activeTabByWorktree: Record<string, string>;
  activeTabByPane: Record<string, string>;
  focusedPaneByWorktree: Record<string, string>;
  focusedPaneHistoryByWorktree: Record<string, string[]>;
  tabMruByPane: Record<string, string[]>;
  addTerminal: (worktreeId: string, paneId?: string) => Promise<Tab>;
  setTerminalCustomLabel: (
    id: string,
    customLabel: string,
  ) => Promise<Tab | null>;
  resetTerminalCustomLabel: (id: string) => Promise<Tab | null>;
  openFile: (options: OpenFileOptions) => Promise<Tab>;
  openGitDiff: (options: OpenGitDiffOptions) => Promise<Tab>;
  openBrowser: (options: OpenBrowserOptions) => Promise<Tab>;
  openAgentChat: (options: OpenAgentChatOptions) => Promise<Tab>;
  setBrowserState: (
    id: string,
    updates: BrowserTabUpdate,
  ) => Promise<BrowserTab | null>;
  pin: (id: string) => Promise<Tab | null>;
  close: (id: string) => Promise<void>;
  removeLocal: (id: string) => void;
  activate: (id: string) => void;
  focusPane: (worktreeId: string, paneId: string) => void;
  setSplitRatio: (worktreeId: string, nodeId: string, ratio: number) => boolean;
  persistLayout: (projectId: string, worktreeId: string) => Promise<void>;
  reorder: (
    worktreeId: string,
    paneId: string,
    orderedIds: string[],
  ) => Promise<void>;
  moveTab: (
    projectId: string,
    worktreeId: string,
    tabId: string,
    targetPaneId: string,
    placement: PaneDropPlacement,
    targetTabId?: string,
  ) => Promise<void>;
  createSplitPane: (
    projectId: string,
    worktreeId: string,
    paneId: string,
    direction: "right" | "down",
  ) => Promise<string | null>;
  splitPane: (
    projectId: string,
    worktreeId: string,
    paneId: string,
    direction: "right" | "down",
  ) => Promise<Tab>;
  switchToWorktree: (worktreeId: string) => void;
};

type PersistedSelection = Pick<
  TabsState,
  | "activeTabId"
  | "activeTabByWorktree"
  | "activeTabByPane"
  | "focusedPaneByWorktree"
  | "tabMruByPane"
>;

type SelectionState = PersistedSelection &
  Pick<TabsState, "focusedPaneHistoryByWorktree">;

type WorktreeRestoreSelection = {
  activeTabId?: string | null;
  focusedPaneId?: string | null;
  paneMru?: string[] | null;
  tabMruByPane?: Record<string, string[]> | null;
};

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

function compactRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => Boolean(value)),
  );
}

function compactArrayRecord(
  record: Record<string, string[]>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value.length > 0),
  );
}

function persistSelection(selection: SelectionState): void {
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

function buildRestoreStatePayload(
  state: TabsState,
  worktreeId: string,
): WorktreeRestoreSelection {
  const activeTabId = state.activeTabByWorktree[worktreeId] ?? null;
  const focusedPaneId = state.focusedPaneByWorktree[worktreeId] ?? null;
  const paneIds = paneIdsForWorktree(
    state.layoutsByWorktree,
    state.tabs,
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
            state.tabs.find(
              (tab) =>
                tab.id === tabId &&
                tab.worktree_id === worktreeId &&
                tab.pane_id === paneId,
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

function schedulePersistRestoreState(
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

function restoreStateWorktreeIds(state: TabsState): string[] {
  const worktreeIds = new Set([
    ...Object.keys(state.layoutsByWorktree),
    ...Object.keys(state.activeTabByWorktree),
    ...Object.keys(state.focusedPaneByWorktree),
    ...Object.keys(state.focusedPaneHistoryByWorktree),
  ]);
  for (const tab of state.tabs) {
    worktreeIds.add(tab.worktree_id);
  }
  return [...worktreeIds];
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

function initialSelection(): SelectionState {
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

function seedSelectionFromBackendRestore(
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
            tab.worktree_id === worktreeId,
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
      activeTab?.pane_id ||
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
        activeTab.pane_id,
        activeTab.id,
      );
      nextActiveTabByWorktree[worktreeId] = activeTab.id;
      nextActiveTabByPane[activeTab.pane_id] = activeTab.id;
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

function tabKey(tab: Tab): string {
  switch (tab.type) {
    case "terminal":
      return [
        tab.id,
        tab.label,
        tab.customLabel ?? "",
        tab.smartLabel ?? "",
        tab.titleLabel ?? "",
        tab.position,
        tab.worktree_id,
        tab.pane_id,
        tab.preview,
        tab.type,
        tab.has_notification ?? false,
      ].join("|");
    case "file":
      return [
        tab.id,
        tab.label,
        tab.position,
        tab.worktree_id,
        tab.pane_id,
        tab.preview,
        tab.type,
        tab.path,
      ].join("|");
    case "git_diff":
      return [
        tab.id,
        tab.label,
        tab.position,
        tab.worktree_id,
        tab.pane_id,
        tab.preview,
        tab.type,
        tab.path,
        tab.scope,
        tab.original_path ?? "",
        tab.commit_id ?? "",
      ].join("|");
    case "browser":
      return [
        tab.id,
        tab.label,
        tab.position,
        tab.worktree_id,
        tab.pane_id,
        tab.preview,
        tab.type,
        tab.url,
        tab.history.join("||"),
        tab.history_index,
      ].join("|");
    case "agent_chat":
      return [
        tab.id,
        tab.label,
        tab.position,
        tab.worktree_id,
        tab.pane_id,
        tab.preview,
        tab.type,
        tab.conversation_id,
      ].join("|");
  }
}

function tabsEqual(a: Tab[], b: Tab[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (tabKey(a[index]) !== tabKey(b[index])) {
      return false;
    }
  }
  return true;
}

function layoutEqual(
  left: WorktreeTabLayout | undefined,
  right: WorktreeTabLayout | undefined,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function layoutMapEqual(
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

function tabsForWorktreeInternal(tabs: Tab[], worktreeId: string): Tab[] {
  return sortTabs(tabs.filter((tab) => tab.worktree_id === worktreeId));
}

function addTabIfMissing(tabs: Tab[], tab: Tab): Tab[] {
  return tabs.some((candidate) => candidate.id === tab.id)
    ? sortTabs(tabs)
    : sortTabs([...tabs, tab]);
}

function ensureLayoutsForTabs(
  tabs: Tab[],
  layoutsByWorktree: Record<string, WorktreeTabLayout>,
): Record<string, WorktreeTabLayout> {
  const nextLayouts = { ...layoutsByWorktree };
  for (const tab of tabs) {
    if (!nextLayouts[tab.worktree_id]) {
      nextLayouts[tab.worktree_id] = createSinglePaneLayout(tab.pane_id);
    }
  }
  return nextLayouts;
}

function paneIdsForWorktree(
  layoutsByWorktree: Record<string, WorktreeTabLayout>,
  tabs: Tab[],
  worktreeId: string,
): string[] {
  const fromLayout = collectPaneIds(layoutsByWorktree[worktreeId]);
  if (fromLayout.length > 0) {
    return fromLayout;
  }

  return Array.from(
    new Set(
      tabsForWorktreeInternal(tabs, worktreeId).map((tab) => tab.pane_id),
    ),
  );
}

function resolvePaneIdForOpen(
  state: TabsState,
  worktreeId: string,
  requestedPaneId?: string,
): string {
  const paneIds = paneIdsForWorktree(
    state.layoutsByWorktree,
    state.tabs,
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
    tabsForWorktreeInternal(state.tabs, worktreeId)[0]?.pane_id ??
    requestedPaneId ??
    DEFAULT_ROOT_PANE_ID
  );
}

function resolvedPaneIdOrNew(
  state: TabsState,
  worktreeId: string,
  requestedPaneId?: string,
): string {
  const paneId = resolvePaneIdForOpen(state, worktreeId, requestedPaneId);
  return paneId || DEFAULT_ROOT_PANE_ID;
}

function removedTabs(previous: Tab[], next: Tab[]): Tab[] {
  const nextIds = new Set(next.map((tab) => tab.id));
  return previous.filter((tab) => !nextIds.has(tab.id));
}

function findFileTab(
  tabs: Tab[],
  worktreeId: string,
  path: string,
): Tab | null {
  return (
    tabs.find(
      (tab) =>
        tab.worktree_id === worktreeId &&
        tab.type === "file" &&
        tab.path === path,
    ) ?? null
  );
}

function findGitDiffTab(
  tabs: Tab[],
  worktreeId: string,
  path: string,
  scope: GitDiffScope,
  originalPath?: string | null,
  commitId?: string | null,
): GitDiffTab | null {
  return (
    tabs.find(
      (tab): tab is GitDiffTab =>
        tab.worktree_id === worktreeId &&
        tab.type === "git_diff" &&
        tab.path === path &&
        tab.scope === scope &&
        (tab.original_path ?? null) === (originalPath ?? null) &&
        (tab.commit_id ?? null) === (commitId ?? null),
    ) ?? null
  );
}

function findPreviewTab(
  tabs: Tab[],
  worktreeId: string,
  paneId: string,
): Tab | null {
  return (
    tabs.find(
      (tab) =>
        tab.worktree_id === worktreeId &&
        tab.pane_id === paneId &&
        tab.preview &&
        tab.type !== "terminal",
    ) ?? null
  );
}

function gitDiffOpenKey(options: OpenGitDiffOptions): string {
  return [
    options.worktreeId,
    options.path,
    options.scope,
    options.originalPath ?? "",
    options.commitId ?? "",
  ].join("|");
}

function agentChatOpenKey(
  options: OpenAgentChatOptions,
  paneId: string,
): string {
  return [
    "agent_chat",
    options.worktreeId,
    paneId,
    options.conversationId ?? "new",
  ].join(":");
}

function disposeDesktopBrowserTab(tab: Tab | null | undefined): void {
  if (!tab || tab.type !== "browser" || !hasDesktopBrowserBridge()) {
    return;
  }

  desktopBrowserBridge()?.destroy({ tabId: tab.id });
}

function activeTabMapEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  return JSON.stringify(compactRecord(a)) === JSON.stringify(compactRecord(b));
}

function paneHistoryMapEqual(
  a: Record<string, string[]>,
  b: Record<string, string[]>,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function tabMruMapEqual(
  a: Record<string, string[]>,
  b: Record<string, string[]>,
): boolean {
  return (
    JSON.stringify(compactArrayRecord(a)) ===
    JSON.stringify(compactArrayRecord(b))
  );
}

function pushPaneFocusHistory(
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

function promoteTabMru(
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

function pruneTabMruByPane(
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
          if (!tab || tab.pane_id !== paneId || seen.has(tabId)) {
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

function preferredPaneTabId(
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

function prunePaneFocusHistory(
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

function focusPaneLocal(
  state: TabsState,
  worktreeId: string,
  paneId: string,
): SelectionState {
  const paneTabs = tabsForPane(
    tabsForWorktreeInternal(state.tabs, worktreeId),
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

function activateLocal(state: TabsState, id: string): SelectionState {
  const tab = state.tabs.find((candidate) => candidate.id === id);
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
    tab.worktree_id,
    tab.pane_id,
  );
  const nextTabMruByPane = promoteTabMru(state.tabMruByPane, tab.pane_id, id);
  const selection = {
    activeTabId: id,
    activeTabByWorktree: {
      ...state.activeTabByWorktree,
      [tab.worktree_id]: id,
    },
    activeTabByPane: {
      ...state.activeTabByPane,
      [tab.pane_id]: id,
    },
    focusedPaneByWorktree: {
      ...state.focusedPaneByWorktree,
      [tab.worktree_id]: tab.pane_id,
    },
    focusedPaneHistoryByWorktree: nextFocusedPaneHistoryByWorktree,
    tabMruByPane: nextTabMruByPane,
  };
  persistSelection(selection);
  return selection;
}

function reconcileSelection(
  state: TabsState,
  nextTabs: Tab[],
  nextLayoutsByWorktree: Record<string, WorktreeTabLayout>,
): SelectionState {
  const tabsById = new Map(nextTabs.map((tab) => [tab.id, tab]));
  const previousActiveWorktreeId =
    state.activeTabId &&
    state.tabs.find((tab) => tab.id === state.activeTabId)?.worktree_id;
  const nextActiveTabByPane = Object.fromEntries(
    Object.entries(state.activeTabByPane).filter(
      ([paneId, tabId]) => tabsById.get(tabId)?.pane_id === paneId,
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
    ...nextTabs.map((tab) => tab.worktree_id),
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
      nextActiveTabByPane[activeTab.pane_id] = activeTab.id;
      nextActiveTabByWorktree[activeTab.worktree_id] = activeTab.id;
      nextFocusedPaneByWorktree[activeTab.worktree_id] = activeTab.pane_id;
      nextFocusedPaneHistoryByWorktree[activeTab.worktree_id] = [
        activeTab.pane_id,
        ...(
          nextFocusedPaneHistoryByWorktree[activeTab.worktree_id] ?? []
        ).filter((paneId) => paneId !== activeTab.pane_id),
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

function nextStateAfterWorktreeLayout(
  state: TabsState,
  worktreeId: string,
  nextLayoutState: WorktreeTabLayoutState,
): Partial<TabsState> {
  const nextTabs = sortTabs([
    ...state.tabs.filter((tab) => tab.worktree_id !== worktreeId),
    ...nextLayoutState.tabs,
  ]);
  const nextLayoutsByWorktree = ensureLayoutsForTabs(nextTabs, {
    ...state.layoutsByWorktree,
    [worktreeId]: nextLayoutState.layout,
  });
  const selection = reconcileSelection(state, nextTabs, nextLayoutsByWorktree);
  return {
    tabs: nextTabs,
    layoutsByWorktree: nextLayoutsByWorktree,
    ...selection,
  };
}

function removeFromState(state: TabsState, id: string): Partial<TabsState> {
  const closingTab = state.tabs.find((candidate) => candidate.id === id);
  const nextTabs = state.tabs.filter((candidate) => candidate.id !== id);
  const nextLayoutsByWorktree = { ...state.layoutsByWorktree };

  if (closingTab && nextLayoutsByWorktree[closingTab.worktree_id]) {
    nextLayoutsByWorktree[closingTab.worktree_id] = collapseLayoutToTabs(
      nextLayoutsByWorktree[closingTab.worktree_id],
      tabsForWorktreeInternal(nextTabs, closingTab.worktree_id),
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
    tabs: nextTabs,
    layoutsByWorktree: normalizedLayouts,
    ...selection,
  };
}

async function replacePreviewIfNeeded(
  state: TabsState,
  worktreeId: string,
  paneId: string,
): Promise<void> {
  const previewTab = findPreviewTab(state.tabs, worktreeId, paneId);
  if (!previewTab) {
    return;
  }

  scheduleDisposeTabModels(previewTab);
  useTabStore.setState((current) => removeFromState(current, previewTab.id));
  try {
    await deleteTab(previewTab.id);
  } catch {
    // Preview tab may already be gone.
  }
}

async function submitLayoutChange(
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

export const useTabStore = create<TabsState>((set, get) => {
  const selection = initialSelection();

  return {
    tabs: [],
    layoutsByWorktree: {},
    ...selection,
    async addTerminal(worktreeId, requestedPaneId) {
      const paneId = resolvedPaneIdOrNew(get(), worktreeId, requestedPaneId);
      const tab = await createTerminalTab(worktreeId, paneId);
      set((state) => {
        const nextTabs = addTabIfMissing(state.tabs, tab);
        const nextLayoutsByWorktree = ensureLayoutsForTabs(
          nextTabs,
          state.layoutsByWorktree,
        );
        return {
          tabs: nextTabs,
          layoutsByWorktree: nextLayoutsByWorktree,
          ...activateLocal(
            {
              ...state,
              tabs: nextTabs,
              layoutsByWorktree: nextLayoutsByWorktree,
            } as TabsState,
            tab.id,
          ),
        };
      });
      return tab;
    },
    async setTerminalCustomLabel(id, customLabel) {
      const existing = get().tabs.find((tab) => tab.id === id) ?? null;
      if (!existing || existing.type !== "terminal") {
        return existing;
      }

      const normalized = customLabel.trim();
      const nextCustomLabel = normalized.length > 0 ? normalized : null;
      set((state) => ({
        tabs: sortTabs(
          state.tabs.map((tab) =>
            tab.id === id && tab.type === "terminal"
              ? { ...tab, customLabel: nextCustomLabel }
              : tab,
          ),
        ),
      }));

      try {
        return await updateTab(id, { custom_label: customLabel });
      } catch {
        return { ...existing, customLabel: nextCustomLabel };
      }
    },
    async resetTerminalCustomLabel(id) {
      return get().setTerminalCustomLabel(id, "");
    },
    async openFile(options) {
      const existing = findFileTab(
        get().tabs,
        options.worktreeId,
        options.path,
      );
      if (existing) {
        if (!options.preview && existing.preview) {
          set((state) => ({
            tabs: sortTabs(
              state.tabs.map((tab) =>
                tab.id === existing.id ? { ...tab, preview: false } : tab,
              ),
            ),
            ...activateLocal(state, existing.id),
          }));
          try {
            return await updateTab(existing.id, { preview: false });
          } catch {
            return { ...existing, preview: false };
          }
        }

        set((state) => activateLocal(state, existing.id));
        return existing;
      }

      const paneId = resolvedPaneIdOrNew(
        get(),
        options.worktreeId,
        options.paneId,
      );
      if (options.preview) {
        await replacePreviewIfNeeded(get(), options.worktreeId, paneId);
      }

      const tab = await createTab({
        type: "file",
        worktree_id: options.worktreeId,
        pane_id: paneId,
        path: options.path,
        preview: options.preview,
      });
      set((state) => {
        const nextTabs = addTabIfMissing(state.tabs, tab);
        const nextLayoutsByWorktree = ensureLayoutsForTabs(
          nextTabs,
          state.layoutsByWorktree,
        );
        return {
          tabs: nextTabs,
          layoutsByWorktree: nextLayoutsByWorktree,
          ...activateLocal(
            {
              ...state,
              tabs: nextTabs,
              layoutsByWorktree: nextLayoutsByWorktree,
            } as TabsState,
            tab.id,
          ),
        };
      });
      return tab;
    },
    async openGitDiff(options) {
      const existing = findGitDiffTab(
        get().tabs,
        options.worktreeId,
        options.path,
        options.scope,
        options.originalPath,
        options.commitId,
      );
      if (existing) {
        if (!options.preview && existing.preview) {
          set((state) => ({
            tabs: sortTabs(
              state.tabs.map((tab) =>
                tab.id === existing.id ? { ...tab, preview: false } : tab,
              ),
            ),
            ...activateLocal(state, existing.id),
          }));
          try {
            return await updateTab(existing.id, { preview: false });
          } catch {
            return { ...existing, preview: false };
          }
        }

        set((state) => activateLocal(state, existing.id));
        return existing;
      }

      const pendingKey = gitDiffOpenKey(options);
      const pending = pendingGitDiffOpens.get(pendingKey);
      if (pending) {
        if (!options.preview) {
          pending.state.shouldPin = true;
        }
        return pending.promise;
      }

      const paneId = resolvedPaneIdOrNew(
        get(),
        options.worktreeId,
        options.paneId,
      );
      const pendingState = {
        shouldPin: !options.preview,
      };
      const pendingPromise = (async () => {
        if (options.preview) {
          await replacePreviewIfNeeded(get(), options.worktreeId, paneId);
        }

        const tab = await createTab({
          type: "git_diff",
          worktree_id: options.worktreeId,
          pane_id: paneId,
          path: options.path,
          scope: options.scope,
          original_path: options.originalPath ?? undefined,
          commit_id: options.commitId ?? undefined,
          preview: options.preview,
        });
        set((state) => {
          const nextTabs = addTabIfMissing(state.tabs, tab);
          const nextLayoutsByWorktree = ensureLayoutsForTabs(
            nextTabs,
            state.layoutsByWorktree,
          );
          return {
            tabs: nextTabs,
            layoutsByWorktree: nextLayoutsByWorktree,
            ...activateLocal(
              {
                ...state,
                tabs: nextTabs,
                layoutsByWorktree: nextLayoutsByWorktree,
              } as TabsState,
              tab.id,
            ),
          };
        });

        if (!pendingState.shouldPin || !tab.preview) {
          return tab;
        }

        set((state) => ({
          tabs: sortTabs(
            state.tabs.map((candidate) =>
              candidate.id === tab.id
                ? { ...candidate, preview: false }
                : candidate,
            ),
          ),
          ...activateLocal(state, tab.id),
        }));
        try {
          return await updateTab(tab.id, { preview: false });
        } catch {
          return { ...tab, preview: false };
        }
      })().finally(() => {
        pendingGitDiffOpens.delete(pendingKey);
      });

      pendingGitDiffOpens.set(pendingKey, {
        state: pendingState,
        promise: pendingPromise,
      });

      return pendingPromise;
    },
    async openBrowser(options) {
      const paneId = resolvedPaneIdOrNew(
        get(),
        options.worktreeId,
        options.paneId,
      );
      const url = normalizeBrowserUrl(options.url ?? BLANK_BROWSER_URL, {
        allowBlank: true,
      });
      const tab = await createTab({
        type: "browser",
        worktree_id: options.worktreeId,
        pane_id: paneId,
        url,
      });
      set((state) => {
        const nextTabs = addTabIfMissing(state.tabs, tab);
        const nextLayoutsByWorktree = ensureLayoutsForTabs(
          nextTabs,
          state.layoutsByWorktree,
        );
        return {
          tabs: nextTabs,
          layoutsByWorktree: nextLayoutsByWorktree,
          ...activateLocal(
            {
              ...state,
              tabs: nextTabs,
              layoutsByWorktree: nextLayoutsByWorktree,
            } as TabsState,
            tab.id,
          ),
        };
      });
      return tab;
    },
    async openAgentChat(options) {
      const existing =
        options.conversationId == null
          ? null
          : (get().tabs.find(
              (tab) =>
                tab.type === "agent_chat" &&
                tab.worktree_id === options.worktreeId &&
                tab.conversation_id === options.conversationId,
            ) ?? null);
      if (existing) {
        set((state) => activateLocal(state, existing.id));
        return existing;
      }

      const paneId = resolvedPaneIdOrNew(
        get(),
        options.worktreeId,
        options.paneId,
      );
      const pendingKey = agentChatOpenKey(options, paneId);
      const pending = pendingAgentChatOpens.get(pendingKey);
      if (pending) {
        return pending;
      }

      const pendingPromise = (async () => {
        const tab = await createTab({
          type: "agent_chat",
          worktree_id: options.worktreeId,
          pane_id: paneId,
          conversation_id: options.conversationId,
        });
        set((state) => {
          const nextTabs = addTabIfMissing(state.tabs, tab);
          const nextLayoutsByWorktree = ensureLayoutsForTabs(
            nextTabs,
            state.layoutsByWorktree,
          );
          return {
            tabs: nextTabs,
            layoutsByWorktree: nextLayoutsByWorktree,
            ...activateLocal(
              {
                ...state,
                tabs: nextTabs,
                layoutsByWorktree: nextLayoutsByWorktree,
              } as TabsState,
              tab.id,
            ),
          };
        });
        return tab;
      })().finally(() => {
        pendingAgentChatOpens.delete(pendingKey);
      });

      pendingAgentChatOpens.set(pendingKey, pendingPromise);
      return pendingPromise;
    },
    async setBrowserState(id, updates) {
      const existing =
        get().tabs.find(
          (tab): tab is BrowserTab => tab.id === id && tab.type === "browser",
        ) ?? null;
      if (!existing) {
        return existing;
      }

      const nextUrl = updates.url
        ? normalizeBrowserUrl(updates.url, { allowBlank: true })
        : existing.url;
      const nextHistory = updates.history
        ? updates.history.map((entry) =>
            normalizeBrowserUrl(entry, { allowBlank: true }),
          )
        : existing.history;
      const nextHistoryIndex = updates.historyIndex ?? existing.history_index;
      if (nextHistory.length === 0 || nextHistoryIndex >= nextHistory.length) {
        throw new Error("history_index must point at an entry in history.");
      }
      const nextLabel =
        updates.label ?? existing.label ?? browserLabelFromUrl(nextUrl);

      if (
        nextLabel === existing.label &&
        nextUrl === existing.url &&
        nextHistoryIndex === existing.history_index &&
        nextHistory.length === existing.history.length &&
        nextHistory.every((entry, index) => entry === existing.history[index])
      ) {
        return existing;
      }

      const optimistic: BrowserTab = {
        ...existing,
        label: nextLabel,
        url: nextUrl,
        history: nextHistory,
        history_index: nextHistoryIndex,
      };
      set((state) => ({
        tabs: sortTabs(
          state.tabs.map((tab) => (tab.id === id ? optimistic : tab)),
        ),
      }));

      try {
        return (await updateTab(id, {
          label: nextLabel,
          url: nextUrl,
          history: nextHistory,
          history_index: nextHistoryIndex,
        })) as BrowserTab;
      } catch {
        return optimistic;
      }
    },
    async pin(id) {
      const existing = get().tabs.find((tab) => tab.id === id) ?? null;
      if (!existing || !existing.preview) {
        return existing;
      }

      set((state) => ({
        tabs: sortTabs(
          state.tabs.map((tab) =>
            tab.id === id ? { ...tab, preview: false } : tab,
          ),
        ),
      }));

      try {
        return await updateTab(id, { preview: false });
      } catch {
        return { ...existing, preview: false };
      }
    },
    async close(id) {
      const closingTab = get().tabs.find((candidate) => candidate.id === id);
      if (!closingTab) {
        return;
      }

      set((state) => removeFromState(state, id));

      try {
        await deleteTab(id);
      } catch {
        // Already gone.
      }

      disposeDesktopBrowserTab(closingTab);
      scheduleDisposeTabModels(closingTab);
    },
    removeLocal(id) {
      const closingTab = get().tabs.find((candidate) => candidate.id === id);
      set((state) => removeFromState(state, id));
      if (closingTab) {
        disposeDesktopBrowserTab(closingTab);
        scheduleDisposeTabModels(closingTab);
      }
    },
    activate(id) {
      const tab = get().tabs.find((candidate) => candidate.id === id);
      set((state) => activateLocal(state, id));
      if (!tab) {
        return;
      }
    },
    focusPane(worktreeId, paneId) {
      set((state) => focusPaneLocal(state, worktreeId, paneId));
    },
    setSplitRatio(worktreeId, nodeId, ratio) {
      let changed = false;
      set((state) => {
        const layout = state.layoutsByWorktree[worktreeId];
        if (!layout) {
          return state;
        }

        const nextLayout = setPaneSplitRatio(layout, nodeId, ratio);
        if (layoutEqual(layout, nextLayout)) {
          return state;
        }
        changed = true;

        return {
          layoutsByWorktree: {
            ...state.layoutsByWorktree,
            [worktreeId]: nextLayout,
          },
        };
      });
      return changed;
    },
    async persistLayout(projectId, worktreeId) {
      const state = get();
      const layout = state.layoutsByWorktree[worktreeId];
      if (!layout) {
        return;
      }

      const serverState = await submitLayoutChange(
        projectId,
        worktreeId,
        layout,
        tabsForWorktreeInternal(state.tabs, worktreeId),
      );
      set((current) =>
        nextStateAfterWorktreeLayout(current, worktreeId, serverState),
      );
    },
    async reorder(worktreeId, paneId, orderedIds) {
      set((state) => ({
        tabs: sortTabs(
          state.tabs.map((tab) => {
            if (tab.worktree_id !== worktreeId || tab.pane_id !== paneId) {
              return tab;
            }
            const index = orderedIds.indexOf(tab.id);
            return index >= 0 ? { ...tab, position: index + 1 } : tab;
          }),
        ),
      }));

      await reorderTabs(worktreeId, paneId, orderedIds);
    },
    async moveTab(
      projectId,
      worktreeId,
      tabId,
      targetPaneId,
      placement,
      targetTabId,
    ) {
      const state = get();
      const worktreeTabs = tabsForWorktreeInternal(state.tabs, worktreeId);
      const layout =
        state.layoutsByWorktree[worktreeId] ??
        createSinglePaneLayout(worktreeTabs[0]?.pane_id);
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
          ...current.tabs.filter((tab) => tab.worktree_id !== worktreeId),
          ...next.tabs,
        ]);
        const nextLayoutsByWorktree = ensureLayoutsForTabs(nextTabs, {
          ...current.layoutsByWorktree,
          [worktreeId]: next.layout,
        });
        const selection = activateLocal(
          {
            ...current,
            tabs: nextTabs,
            layoutsByWorktree: nextLayoutsByWorktree,
          } as TabsState,
          tabId,
        );
        return {
          tabs: nextTabs,
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
      const worktreeTabs = tabsForWorktreeInternal(state.tabs, worktreeId);
      const layout =
        state.layoutsByWorktree[worktreeId] ??
        createSinglePaneLayout(worktreeTabs[0]?.pane_id);
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
      const previousTabs = tabsForWorktreeInternal(state.tabs, worktreeId);
      const previousLayout =
        state.layoutsByWorktree[worktreeId] ??
        createSinglePaneLayout(previousTabs[0]?.pane_id);
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
          const current = state.tabs.find(
            (tab) => tab.id === state.activeTabId,
          );
          if (current?.worktree_id === worktreeId) {
            return state;
          }
        }

        const paneIds = paneIdsForWorktree(
          state.layoutsByWorktree,
          state.tabs,
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
          tabsForWorktreeInternal(state.tabs, worktreeId),
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
});

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
  const tab = state.tabs.find(
    (candidate) =>
      candidate.id === state.activeTabId &&
      candidate.type === "terminal" &&
      !!candidate.has_notification,
  );
  return tab ? tab.id : null;
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
        data.tab_layouts,
      );
      useTabStore.setState((state) => {
        const selectionSeedState = hasHydratedBackendRestoreSelection
          ? state
          : seedSelectionFromBackendRestore(
              state,
              incomingTabs,
              incomingLayouts,
              data.worktree_restore_state ?? {},
            );
        const selection = reconcileSelection(
          selectionSeedState,
          incomingTabs,
          incomingLayouts,
        );

        if (
          tabsEqual(state.tabs, incomingTabs) &&
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

        for (const tab of removedTabs(state.tabs, incomingTabs)) {
          disposeDesktopBrowserTab(tab);
          scheduleDisposeTabModels(tab);
        }

        return {
          tabs: incomingTabs,
          layoutsByWorktree: incomingLayouts,
          ...selection,
        };
      });
      hasHydratedBackendRestoreSelection = true;
    }),
    events.on("tab_created", ({ tab }) => {
      useTabStore.setState((state) => {
        if (state.tabs.some((candidate) => candidate.id === tab.id)) {
          return state;
        }
        const nextTabs = addTabIfMissing(state.tabs, tab);
        const nextLayoutsByWorktree = ensureLayoutsForTabs(
          nextTabs,
          state.layoutsByWorktree,
        );
        return {
          tabs: nextTabs,
          layoutsByWorktree: nextLayoutsByWorktree,
        };
      });
    }),
    events.on("tab_closed", ({ tab_id }) => {
      useTabStore.setState((state) => {
        const closedTab = state.tabs.find((tab) => tab.id === tab_id);
        if (closedTab) {
          disposeDesktopBrowserTab(closedTab);
          scheduleDisposeTabModels(closedTab);
        }
        return removeFromState(state, tab_id);
      });
    }),
    events.on("tab_updated", ({ tab }) => {
      useTabStore.setState((state) => ({
        tabs: sortTabs(
          state.tabs.map((candidate) =>
            candidate.id === tab.id ? tab : candidate,
          ),
        ),
      }));
    }),
    events.on("tabs_reordered", ({ tabs }) => {
      useTabStore.setState((state) => {
        const reorderedIds = new Set(tabs.map((tab) => tab.id));
        const nextTabs = sortTabs([
          ...state.tabs.filter((tab) => !reorderedIds.has(tab.id)),
          ...tabs,
        ]);
        return { tabs: nextTabs };
      });
    }),
    events.on(
      "worktree_tab_layout_updated",
      ({ worktree_id, state: nextState }) => {
        useTabStore.setState((current) =>
          nextStateAfterWorktreeLayout(current, worktree_id, nextState),
        );
      },
    ),
  ];

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
      useTabStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === nextId && tab.type === "terminal"
            ? { ...tab, has_notification: false }
            : tab,
        ),
      }));
      void updateTab(nextId, { has_notification: false }).catch(() => {});
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
  pendingGitDiffOpens.clear();
  pendingAgentChatOpens.clear();
  for (const timer of restoreStatePersistTimers.values()) {
    clearTimeout(timer);
  }
  restoreStatePersistTimers.clear();
  for (const unsubscribe of eventUnsubscribers) {
    unsubscribe();
  }
  eventUnsubscribers = [];
  initialized = false;
  hasHydratedBackendRestoreSelection = false;
  useTabStore.setState({
    tabs: [],
    layoutsByWorktree: {},
    ...initialSelection(),
  });
}

export function tabsForWorktree(worktreeId: string): Tab[] {
  return tabsForWorktreeInternal(useTabStore.getState().tabs, worktreeId);
}
