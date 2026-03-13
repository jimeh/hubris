import { create } from "zustand";

const LS_RIGHT_SIDEBAR_WIDTH = "hubris-worktree-right-sidebar-width";
const LS_LEGACY_RIGHT_SIDEBAR_WIDTH = "hubris-worktree-git-sidebar-width";
const RIGHT_SIDEBAR_WIDTH_DEFAULT_PX = 320;
const RIGHT_SIDEBAR_WIDTH_MIN_PX = 240;
const RIGHT_SIDEBAR_WIDTH_MAX_PX = 640;
const PERSIST_DEBOUNCE_MS = 150;

type WorktreeRightSidebarWidthState = {
  width: number;
  isResizing: boolean;
  setWidth: (width: number) => void;
  setResizing: (value: boolean) => void;
  flushPendingPersist: () => void;
};

function clampWidth(width: number): number {
  return Math.min(
    RIGHT_SIDEBAR_WIDTH_MAX_PX,
    Math.max(RIGHT_SIDEBAR_WIDTH_MIN_PX, Math.round(width)),
  );
}

function readStoredWidth(): number {
  try {
    const raw =
      localStorage.getItem(LS_RIGHT_SIDEBAR_WIDTH) ??
      localStorage.getItem(LS_LEGACY_RIGHT_SIDEBAR_WIDTH);
    if (!raw) return RIGHT_SIDEBAR_WIDTH_DEFAULT_PX;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return RIGHT_SIDEBAR_WIDTH_DEFAULT_PX;
    return clampWidth(parsed);
  } catch {
    return RIGHT_SIDEBAR_WIDTH_DEFAULT_PX;
  }
}

function writeStoredWidth(width: number): void {
  try {
    localStorage.setItem(LS_RIGHT_SIDEBAR_WIDTH, String(width));
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

export const useWorktreeRightSidebarWidthStore =
  create<WorktreeRightSidebarWidthState>((set, get) => ({
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

export function resetWorktreeRightSidebarWidthStoreForTests(): void {
  clearPersistTimer();
  useWorktreeRightSidebarWidthStore.setState({
    width: readStoredWidth(),
    isResizing: false,
  });
}
