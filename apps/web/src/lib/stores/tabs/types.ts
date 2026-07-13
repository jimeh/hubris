import type { PaneDropPlacement } from "@/lib/tabLayout";
import type {
  BrowserTab,
  GitDiffScope,
  Tab,
  WorktreeTabLayout,
} from "@/lib/types";

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

export type TabsState = {
  tabsById: Record<string, Tab>;
  tabIdsByWorktree: Record<string, string[]>;
  tabIdsByPane: Record<string, string[]>;
  layoutsByWorktree: Record<string, WorktreeTabLayout>;
  activeTabId: string | null;
  activeTabByWorktree: Record<string, string>;
  activeTabByPane: Record<string, string>;
  focusedPaneByWorktree: Record<string, string>;
  focusedPaneHistoryByWorktree: Record<string, string[]>;
  tabMruByPane: Record<string, string[]>;
  addTerminal: (worktreeId: string, paneId?: string) => Promise<Tab>;
  updateAgentChatTitle: (conversationId: string, title: string) => void;
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
