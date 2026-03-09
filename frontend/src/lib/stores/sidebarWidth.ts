import { create } from "zustand";

const LS_SIDEBAR_WIDTH = "hubris-sidebar-width";
const SIDEBAR_WIDTH_DEFAULT_PX = 256;
const SIDEBAR_WIDTH_MIN_PX = 192;
const SIDEBAR_WIDTH_MAX_PX = 640;
const PERSIST_DEBOUNCE_MS = 150;

type SidebarWidthState = {
  width: number;
  isResizing: boolean;
  setWidth: (width: number) => void;
  setResizing: (value: boolean) => void;
  flushPendingPersist: () => void;
};

function clampWidth(width: number): number {
  return Math.min(
    SIDEBAR_WIDTH_MAX_PX,
    Math.max(SIDEBAR_WIDTH_MIN_PX, Math.round(width)),
  );
}

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(LS_SIDEBAR_WIDTH);
    if (!raw) return SIDEBAR_WIDTH_DEFAULT_PX;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return SIDEBAR_WIDTH_DEFAULT_PX;
    return clampWidth(parsed);
  } catch {
    return SIDEBAR_WIDTH_DEFAULT_PX;
  }
}

function writeStoredWidth(width: number): void {
  try {
    localStorage.setItem(LS_SIDEBAR_WIDTH, String(width));
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

export const useSidebarWidthStore = create<SidebarWidthState>((set, get) => ({
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

export function resetSidebarWidthStoreForTests(): void {
  clearPersistTimer();
  useSidebarWidthStore.setState({
    width: readStoredWidth(),
    isResizing: false,
  });
}
