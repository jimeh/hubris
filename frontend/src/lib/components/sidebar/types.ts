import { SHADOW_ITEM_MARKER_PROPERTY_NAME } from "svelte-dnd-action";
import type { DeleteProjectOptions } from "$lib/api";
import type { Project, Worktree } from "$lib/types";

export type DndProject = Project & {
  [SHADOW_ITEM_MARKER_PROPERTY_NAME]?: string;
};

export type DndWorktree = Worktree & {
  [SHADOW_ITEM_MARKER_PROPERTY_NAME]?: string;
};

export interface ProjectStore {
  projects: Project[];
  add(path: string): Promise<Project>;
  remove(id: string, options?: DeleteProjectOptions): Promise<void>;
  reorder(orderedIds: string[]): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  toggleExpanded(projectId: string): void;
  isExpanded(projectId: string): boolean;
}

export interface WorktreeStore {
  selectedWorktreeId: string | null;
  worktreesForProject(projectId: string): Worktree[];
  select(worktreeId: string): void;
  create(
    projectId: string,
    branch: string,
    startPoint?: string,
  ): Promise<Worktree>;
  remove(projectId: string, worktreeId: string, force?: boolean): Promise<void>;
  reorder(projectId: string, orderedIds: string[]): Promise<void>;
  projectError(projectId: string): string | null;
}

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
