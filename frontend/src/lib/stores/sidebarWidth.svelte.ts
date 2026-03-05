const LS_SIDEBAR_WIDTH = 'hubris-sidebar-width';
const SIDEBAR_WIDTH_DEFAULT_PX = 256;
const SIDEBAR_WIDTH_MIN_PX = 192;
const SIDEBAR_WIDTH_MAX_PX = 640;
const PERSIST_DEBOUNCE_MS = 150;

function clampWidth(width: number): number {
  return Math.min(
    SIDEBAR_WIDTH_MAX_PX,
    Math.max(SIDEBAR_WIDTH_MIN_PX, Math.round(width)),
  );
}

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(LS_SIDEBAR_WIDTH);
    if (!raw) {
      return SIDEBAR_WIDTH_DEFAULT_PX;
    }
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) {
      return SIDEBAR_WIDTH_DEFAULT_PX;
    }
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

let width = $state(readStoredWidth());
let isResizing = $state(false);
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function clearPersistTimer(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

function queuePersist(): void {
  clearPersistTimer();
  persistTimer = setTimeout(() => {
    writeStoredWidth(width);
    persistTimer = null;
  }, PERSIST_DEBOUNCE_MS);
}

function setWidth(nextWidth: number): void {
  width = clampWidth(nextWidth);
  queuePersist();
}

function setResizing(value: boolean): void {
  isResizing = value;
}

function flushPendingPersist(): void {
  clearPersistTimer();
  writeStoredWidth(width);
}

export function getSidebarWidthStore() {
  return {
    get width() {
      return width;
    },
    get isResizing() {
      return isResizing;
    },
    setWidth,
    setResizing,
    flushPendingPersist,
  };
}
