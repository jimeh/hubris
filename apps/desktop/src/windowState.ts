import fs from "node:fs";
import path from "node:path";
import { screen, type BrowserWindow, type Rectangle } from "electron";

import { HUBRIS_WINDOW_MIN_HEIGHT, HUBRIS_WINDOW_MIN_WIDTH } from "./security";

const WINDOW_STATE_FILENAME = "window-state.json";
const WINDOW_STATE_WRITE_DEBOUNCE_MS = 200;

/**
 * Persistent desktop window geometry and maximized state.
 */
export type DesktopWindowState = {
  bounds: Rectangle;
  isMaximized: boolean;
};

type WindowStateWriter = Pick<
  BrowserWindow,
  "getNormalBounds" | "isMaximized" | "on"
>;

/**
 * Resolve the path used to store the desktop window state.
 */
export function desktopWindowStatePath(userDataPath: string): string {
  return path.join(userDataPath, WINDOW_STATE_FILENAME);
}

/**
 * Load the persisted window state if it exists and can be restored safely.
 */
export function loadDesktopWindowState(
  userDataPath: string,
): DesktopWindowState | null {
  const statePath = desktopWindowStatePath(userDataPath);

  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const state = parseDesktopWindowState(parsed);
    if (!state) {
      return null;
    }

    return {
      ...state,
      bounds: clampWindowBounds(state.bounds),
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    console.warn("failed to load desktop window state", {
      error,
      statePath,
    });
    return null;
  }
}

/**
 * Persist window geometry when the desktop window moves or resizes.
 */
export function wireDesktopWindowStatePersistence(
  window: WindowStateWriter,
  userDataPath: string,
) {
  let writeTimer: ReturnType<typeof setTimeout> | null = null;

  const persistState = () => {
    writeTimer = null;
    writeDesktopWindowState(userDataPath, captureDesktopWindowState(window));
  };

  const schedulePersist = () => {
    if (writeTimer) {
      clearTimeout(writeTimer);
    }

    writeTimer = setTimeout(persistState, WINDOW_STATE_WRITE_DEBOUNCE_MS);
  };

  window.on("move", schedulePersist);
  window.on("resize", schedulePersist);
  window.on("maximize", schedulePersist);
  window.on("unmaximize", schedulePersist);
  window.on("close", () => {
    if (writeTimer) {
      clearTimeout(writeTimer);
    }

    persistState();
  });
}

function captureDesktopWindowState(
  window: Pick<BrowserWindow, "getNormalBounds" | "isMaximized">,
): DesktopWindowState {
  return {
    bounds: window.getNormalBounds(),
    isMaximized: window.isMaximized(),
  };
}

function writeDesktopWindowState(
  userDataPath: string,
  state: DesktopWindowState,
) {
  const statePath = desktopWindowStatePath(userDataPath);

  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn("failed to persist desktop window state", {
      error,
      statePath,
    });
  }
}

function parseDesktopWindowState(value: unknown): DesktopWindowState | null {
  if (!isRecord(value)) {
    return null;
  }

  if (!isRectangle(value.bounds)) {
    return null;
  }

  if (typeof value.isMaximized !== "boolean") {
    return null;
  }

  return {
    bounds: normalizeRectangle(value.bounds),
    isMaximized: value.isMaximized,
  };
}

function clampWindowBounds(bounds: Rectangle): Rectangle {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) {
    return ensureMinimumSize(bounds);
  }

  const workArea = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(
    Math.max(bounds.width, HUBRIS_WINDOW_MIN_WIDTH),
    workArea.width,
  );
  const height = Math.min(
    Math.max(bounds.height, HUBRIS_WINDOW_MIN_HEIGHT),
    workArea.height,
  );

  return {
    x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

function ensureMinimumSize(bounds: Rectangle): Rectangle {
  return {
    ...bounds,
    width: Math.max(bounds.width, HUBRIS_WINDOW_MIN_WIDTH),
    height: Math.max(bounds.height, HUBRIS_WINDOW_MIN_HEIGHT),
  };
}

function normalizeRectangle(bounds: Rectangle): Rectangle {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

function isRectangle(value: unknown): value is Rectangle {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    value.width > 0 &&
    value.height > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
