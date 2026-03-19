import { create } from "zustand";

export type WorktreeGitStatusViewMode = "list" | "tree";

export const DEFAULT_WORKTREE_GIT_STATUS_VIEW_MODE = "tree";

const LS_VIEW_MODE_BY_WORKTREE =
  "hubris-worktree-git-status-view-mode-by-worktree";

type WorktreeGitStatusViewState = {
  viewModeByWorktree: Record<string, WorktreeGitStatusViewMode>;
  setViewMode: (
    worktreeId: string,
    viewMode: WorktreeGitStatusViewMode,
  ) => void;
};

function sanitizeViewMode(value: unknown): WorktreeGitStatusViewMode | null {
  return value === "list" || value === "tree" ? value : null;
}

function readViewModeByWorktree(): Record<string, WorktreeGitStatusViewMode> {
  try {
    const raw = localStorage.getItem(LS_VIEW_MODE_BY_WORKTREE);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .map(([worktreeId, value]) => [worktreeId, sanitizeViewMode(value)])
        .filter(
          (entry): entry is [string, WorktreeGitStatusViewMode] =>
            entry[1] != null,
        ),
    );
  } catch {
    return {};
  }
}

function writeViewModeByWorktree(
  value: Record<string, WorktreeGitStatusViewMode>,
): void {
  try {
    localStorage.setItem(LS_VIEW_MODE_BY_WORKTREE, JSON.stringify(value));
  } catch {
    // localStorage unavailable
  }
}

export const useWorktreeGitStatusViewStore = create<WorktreeGitStatusViewState>(
  (set) => ({
    viewModeByWorktree: readViewModeByWorktree(),
    setViewMode(worktreeId, viewMode) {
      set((state) => {
        const next = {
          ...state.viewModeByWorktree,
          [worktreeId]: viewMode,
        };
        writeViewModeByWorktree(next);
        return { viewModeByWorktree: next };
      });
    },
  }),
);

export function resetWorktreeGitStatusViewStoreForTests(): void {
  useWorktreeGitStatusViewStore.setState({
    viewModeByWorktree: readViewModeByWorktree(),
  });
}
