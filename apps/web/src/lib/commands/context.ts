import { useProjectStore } from "@/lib/stores/projects";
import { selectAllTabs, useTabStore } from "@/lib/stores/tabs";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import type { CommandContextSnapshot } from "./types";

export function buildCommandContextSnapshot(input: {
  activeTabId: string | null;
  focusedPaneByWorktree: Record<string, string>;
  projects: ReturnType<typeof useProjectStore.getState>["projects"];
  selectedWorktreeId: string | null;
  tabs: ReturnType<typeof selectAllTabs>;
  worktreesByProject: ReturnType<
    typeof useWorktreeStore.getState
  >["worktreesByProject"];
}): CommandContextSnapshot {
  const worktrees = Object.values(input.worktreesByProject).flat();
  const selectedWorktree =
    (input.selectedWorktreeId
      ? worktrees.find((worktree) => worktree.id === input.selectedWorktreeId)
      : null) ?? null;
  const selectedProject =
    (selectedWorktree
      ? input.projects.find(
          (project) => project.id === selectedWorktree.project_id,
        )
      : null) ?? null;
  const activeTab =
    (input.activeTabId
      ? input.tabs.find((tab) => tab.id === input.activeTabId)
      : null) ?? null;
  const focusedPaneId =
    (selectedWorktree
      ? (input.focusedPaneByWorktree[selectedWorktree.id] ??
        (activeTab?.worktree_id === selectedWorktree.id
          ? activeTab.pane_id
          : null))
      : null) ?? null;

  return {
    activeTab,
    focusedPaneId,
    projects: input.projects,
    selectedProject,
    selectedWorktree,
    tabs: input.tabs,
    worktrees,
    worktreesByProject: input.worktreesByProject,
  };
}

export function getCommandContextSnapshot(): CommandContextSnapshot {
  const projectState = useProjectStore.getState();
  const worktreeState = useWorktreeStore.getState();
  const tabState = useTabStore.getState();

  return buildCommandContextSnapshot({
    activeTabId: tabState.activeTabId,
    focusedPaneByWorktree: tabState.focusedPaneByWorktree,
    projects: projectState.projects,
    selectedWorktreeId: worktreeState.selectedWorktreeId,
    tabs: selectAllTabs(tabState),
    worktreesByProject: worktreeState.worktreesByProject,
  });
}

export function findProjectById(
  context: CommandContextSnapshot,
  projectId: string | undefined,
) {
  if (!projectId) {
    return null;
  }

  return context.projects.find((project) => project.id === projectId) ?? null;
}

export function findTabById(
  context: CommandContextSnapshot,
  tabId: string | undefined,
) {
  if (!tabId) {
    return null;
  }

  return context.tabs.find((tab) => tab.id === tabId) ?? null;
}

export function findWorktreeById(
  context: CommandContextSnapshot,
  worktreeId: string | undefined,
) {
  if (!worktreeId) {
    return null;
  }

  return (
    context.worktrees.find((worktree) => worktree.id === worktreeId) ?? null
  );
}

export function projectForWorktree(
  context: CommandContextSnapshot,
  worktreeId: string | undefined,
) {
  const worktree = findWorktreeById(context, worktreeId);
  return worktree ? findProjectById(context, worktree.project_id) : null;
}
