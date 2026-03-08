import type { Worktree } from "@/lib/types";

export type SidebarDialogState = {
  addProject: boolean;
  showSettings: boolean;
  addWorktree: {
    projectId: string;
    projectName: string;
  } | null;
  renameProject: {
    projectId: string;
    currentName: string;
  } | null;
  confirmRemoveProject: string | null;
  confirmForceRemoveProject: string | null;
  confirmRemoveWorktree: {
    projectId: string;
    worktree: Worktree;
  } | null;
  confirmForceRemoveWorktree: {
    projectId: string;
    worktree: Worktree;
  } | null;
  actionError: string | null;
};

export function createDialogState(): SidebarDialogState {
  return {
    addProject: false,
    showSettings: false,
    addWorktree: null,
    renameProject: null,
    confirmRemoveProject: null,
    confirmForceRemoveProject: null,
    confirmRemoveWorktree: null,
    confirmForceRemoveWorktree: null,
    actionError: null,
  };
}
