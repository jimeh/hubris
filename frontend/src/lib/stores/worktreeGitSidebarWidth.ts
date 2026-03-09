import { create } from "zustand";

const LS_WORKTREE_GIT_SIDEBAR_WIDTH = "hubris-worktree-git-sidebar-width";
const WORKTREE_GIT_SIDEBAR_WIDTH_DEFAULT_PX = 320;
const WORKTREE_GIT_SIDEBAR_WIDTH_MIN_PX = 240;
const WORKTREE_GIT_SIDEBAR_WIDTH_MAX_PX = 640;
const PERSIST_DEBOUNCE_MS = 150;

type WorktreeGitSidebarWidthState = {
  width: number;
  isResizing: boolean;
  setWidth: (width: number) => void;
  setResizing: (value: boolean) => void;
  flushPendingPersist: () => void;
};

function clampWidth(width: number): number {
  return Math.min(
    WORKTREE_GIT_SIDEBAR_WIDTH_MAX_PX,
    Math.max(WORKTREE_GIT_SIDEBAR_WIDTH_MIN_PX, Math.round(width)),
  );
}

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(LS_WORKTREE_GIT_SIDEBAR_WIDTH);
    if (!raw) return WORKTREE_GIT_SIDEBAR_WIDTH_DEFAULT_PX;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return WORKTREE_GIT_SIDEBAR_WIDTH_DEFAULT_PX;
    return clampWidth(parsed);
  } catch {
    return WORKTREE_GIT_SIDEBAR_WIDTH_DEFAULT_PX;
  }
}

function writeStoredWidth(width: number): void {
  try {
    localStorage.setItem(LS_WORKTREE_GIT_SIDEBAR_WIDTH, String(width));
  } catch {
    // localStorage unavailable
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function clearPersistTimer(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

function queuePersist(width: number): void {
  clearPersistTimer();
  persistTimer = setTimeout(() => {
    writeStoredWidth(width);
    persistTimer = null;
  }, PERSIST_DEBOUNCE_MS);
}

export const useWorktreeGitSidebarWidthStore =
  create<WorktreeGitSidebarWidthState>((set, get) => ({
    width: readStoredWidth(),
    isResizing: false,
    setWidth(width) {
      const next = clampWidth(width);
      queuePersist(next);
      set({ width: next });
    },
    setResizing(isResizing) {
      set({ isResizing });
    },
    flushPendingPersist() {
      clearPersistTimer();
      writeStoredWidth(get().width);
    },
  }));

export function resetWorktreeGitSidebarWidthStoreForTests(): void {
  clearPersistTimer();
  useWorktreeGitSidebarWidthStore.setState({
    width: readStoredWidth(),
    isResizing: false,
  });
}
