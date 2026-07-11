import {
  desktopBrowserBridge,
  hasDesktopBrowserBridge,
} from "@/lib/desktopBrowser";
import { sortTabs } from "@/lib/tabLayout";
import type { GitDiffScope, GitDiffTab, Tab } from "@/lib/types";

export function addTabIfMissing(tabs: Tab[], tab: Tab): Tab[] {
  return tabs.some((candidate) => candidate.id === tab.id)
    ? sortTabs(tabs)
    : sortTabs([...tabs, tab]);
}

export function removedTabs(previous: Tab[], next: Tab[]): Tab[] {
  const nextIds = new Set(next.map((tab) => tab.id));
  return previous.filter((tab) => !nextIds.has(tab.id));
}

export function findFileTab(
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

export function findGitDiffTab(
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

export function findPreviewTab(
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

export function gitDiffOpenKey(options: {
  worktreeId: string;
  path: string;
  scope: GitDiffScope;
  originalPath?: string | null;
  commitId?: string | null;
}): string {
  return [
    options.worktreeId,
    options.path,
    options.scope,
    options.originalPath ?? "",
    options.commitId ?? "",
  ].join("|");
}

export function agentChatOpenKey(
  options: { worktreeId: string; conversationId?: string },
  paneId: string,
): string {
  if (options.conversationId) {
    return ["agent_chat", options.worktreeId, options.conversationId].join(":");
  }
  return ["agent_chat", options.worktreeId, paneId, "new"].join(":");
}

export function disposeDesktopBrowserTab(tab: Tab | null | undefined): void {
  if (!tab || tab.type !== "browser" || !hasDesktopBrowserBridge()) {
    return;
  }

  desktopBrowserBridge()?.destroy({ tabId: tab.id });
}
