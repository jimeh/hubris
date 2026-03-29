import type { Worktree } from "@/lib/types";

export type DialogState = {
  addProject: boolean;
  showSettings: boolean;
  addWorktree: { projectId: string; projectName: string } | null;
  renameProject: { projectId: string; currentName: string } | null;
  renameWorktree: {
    projectId: string;
    worktreeId: string;
    currentName: string;
  } | null;
  confirmRemoveProject: string | null;
  confirmForceRemoveProject: string | null;
  confirmRemoveWorktree: { projectId: string; worktree: Worktree } | null;
  confirmForceRemoveWorktree: {
    projectId: string;
    worktree: Worktree;
  } | null;
  confirmRemoveImportedWorktree: {
    projectId: string;
    worktree: Worktree;
  } | null;
  actionError: string | null;
};

export const initialDialogState: DialogState = {
  addProject: false,
  showSettings: false,
  addWorktree: null,
  renameProject: null,
  renameWorktree: null,
  confirmRemoveProject: null,
  confirmForceRemoveProject: null,
  confirmRemoveWorktree: null,
  confirmForceRemoveWorktree: null,
  confirmRemoveImportedWorktree: null,
  actionError: null,
};
