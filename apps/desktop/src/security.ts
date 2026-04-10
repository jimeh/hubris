import type { BrowserWindowConstructorOptions } from "electron";

export const HUBRIS_WINDOW_TITLE = "Hubris";
export const HUBRIS_WINDOW_WIDTH = 1440;
export const HUBRIS_WINDOW_HEIGHT = 960;
export const HUBRIS_WINDOW_MIN_WIDTH = 1024;
export const HUBRIS_WINDOW_MIN_HEIGHT = 720;
export const HUBRIS_SESSION_PARTITION = "hubris-desktop";

/**
 * Return the hardened BrowserWindow defaults for Hubris.
 */
export function createHubrisWindowOptions(
  preloadPath: string,
): BrowserWindowConstructorOptions {
  return {
    title: HUBRIS_WINDOW_TITLE,
    width: HUBRIS_WINDOW_WIDTH,
    height: HUBRIS_WINDOW_HEIGHT,
    minWidth: HUBRIS_WINDOW_MIN_WIDTH,
    minHeight: HUBRIS_WINDOW_MIN_HEIGHT,
    show: false,
    webPreferences: {
      preload: preloadPath,
      partition: HUBRIS_SESSION_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  };
}

/**
 * Allow navigation only within the active Hubris origin.
 */
export function isAllowedNavigation(
  url: string,
  allowedOrigin: string,
): boolean {
  try {
    return new URL(url).origin === allowedOrigin;
  } catch {
    return false;
  }
}
