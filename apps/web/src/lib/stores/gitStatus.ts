import { create } from "zustand";
import { toast } from "sonner";
import {
  discardProjectWorktreePath,
  getProjectWorktreeCommitDetails,
  stageProjectWorktreePath,
  unstageProjectWorktreePath,
  type WorktreeGitCommitDetails,
} from "@/lib/api";
import { useWorktreeFileManagerStore } from "@/lib/stores/worktreeFileManager";

export type GitStatusAction = "stage" | "unstage" | "discard";

export type CommitDetailsState = {
  status: "idle" | "loading" | "loaded" | "error";
  details: WorktreeGitCommitDetails | null;
  error: string | null;
};

export type RunGitStatusActionInput = {
  action: GitStatusAction;
  projectId: string;
  worktreeId: string;
  path: string;
  originalPath?: string;
  label: string;
};

export type GitStatusState = {
  commitDetailsById: Record<string, CommitDetailsState>;
  pendingActionKeyByWorktree: Record<string, string>;
  ensureCommitDetails: (
    projectId: string,
    worktreeId: string,
    commitId: string,
  ) => Promise<void>;
  runAction: (input: RunGitStatusActionInput) => Promise<void>;
};

export const EMPTY_COMMIT_DETAILS_STATE: CommitDetailsState = {
  status: "idle",
  details: null,
  error: null,
};

function actionLabel(action: GitStatusAction): string {
  switch (action) {
    case "stage":
      return "Stage";
    case "unstage":
      return "Unstage";
    case "discard":
      return "Discard";
  }
}

function actionSuccessLabel(action: GitStatusAction): string {
  switch (action) {
    case "stage":
      return "Staged";
    case "unstage":
      return "Unstaged";
    case "discard":
      return "Discarded";
  }
}

/** Selects cached commit details by globally unique commit ID. */
export function selectCommitDetails(
  state: GitStatusState,
  commitId: string,
): CommitDetailsState {
  return state.commitDetailsById[commitId] ?? EMPTY_COMMIT_DETAILS_STATE;
}

/** Selects the pending mutation key for one worktree. */
export function selectPendingGitStatusAction(
  state: GitStatusState,
  worktreeId: string,
): string | null {
  return state.pendingActionKeyByWorktree[worktreeId] ?? null;
}

export const useGitStatusStore = create<GitStatusState>((set, get) => ({
  commitDetailsById: {},
  pendingActionKeyByWorktree: {},
  ensureCommitDetails: async (projectId, worktreeId, commitId) => {
    const current = get().commitDetailsById[commitId];
    if (current?.status === "loading" || current?.status === "loaded") {
      return;
    }

    set((state) => ({
      commitDetailsById: {
        ...state.commitDetailsById,
        [commitId]: {
          status: "loading",
          details: current?.details ?? null,
          error: null,
        },
      },
    }));

    try {
      const details = await getProjectWorktreeCommitDetails(
        projectId,
        worktreeId,
        commitId,
      );
      set((state) => ({
        commitDetailsById: {
          ...state.commitDetailsById,
          [commitId]: { status: "loaded", details, error: null },
        },
      }));
    } catch (error) {
      set((state) => ({
        commitDetailsById: {
          ...state.commitDetailsById,
          [commitId]: {
            status: "error",
            details: null,
            error:
              error instanceof Error
                ? error.message
                : "Failed to load commit details.",
          },
        },
      }));
    }
  },
  runAction: async ({
    action,
    projectId,
    worktreeId,
    path,
    originalPath,
    label,
  }) => {
    const actionKey = `${action}:${path}`;
    set((state) => ({
      pendingActionKeyByWorktree: {
        ...state.pendingActionKeyByWorktree,
        [worktreeId]: actionKey,
      },
    }));

    try {
      if (action === "stage") {
        await stageProjectWorktreePath(
          projectId,
          worktreeId,
          path,
          originalPath,
        );
      } else if (action === "unstage") {
        await unstageProjectWorktreePath(
          projectId,
          worktreeId,
          path,
          originalPath,
        );
      } else {
        await discardProjectWorktreePath(projectId, worktreeId, path);
      }

      await useWorktreeFileManagerStore
        .getState()
        .refreshPaths(
          projectId,
          worktreeId,
          originalPath ? [path, originalPath] : [path],
        );
      toast.success(`${actionSuccessLabel(action)} ${label}`);
    } catch {
      toast.error(
        `Couldn't ${actionLabel(action).toLowerCase()} ${label.toLowerCase()}`,
      );
    } finally {
      set((state) => {
        if (state.pendingActionKeyByWorktree[worktreeId] !== actionKey) {
          return state;
        }
        const pendingActionKeyByWorktree = {
          ...state.pendingActionKeyByWorktree,
        };
        delete pendingActionKeyByWorktree[worktreeId];
        return { pendingActionKeyByWorktree };
      });
    }
  },
}));

export function resetGitStatusStoreForTests(): void {
  useGitStatusStore.setState({
    commitDetailsById: {},
    pendingActionKeyByWorktree: {},
  });
}
