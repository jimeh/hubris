import type { BrowserWindowConstructorOptions } from "electron";

import { desktopSessionPartition, type DesktopProfileMode } from "./profile";

export const HUBRIS_WINDOW_TITLE = "Hubris";
export const HUBRIS_WINDOW_WIDTH = 1440;
export const HUBRIS_WINDOW_HEIGHT = 960;
export const HUBRIS_WINDOW_MIN_WIDTH = 1024;
export const HUBRIS_WINDOW_MIN_HEIGHT = 720;

/**
 * Return the hardened BrowserWindow defaults for Hubris.
 */
export function createHubrisWindowOptions(
  preloadPath: string,
  mode: DesktopProfileMode,
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
      partition: desktopSessionPartition(mode),
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
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
    const target = new URL(url);
    const allowed = new URL(allowedOrigin);
    return (
      target.protocol === allowed.protocol &&
      target.host === allowed.host &&
      target.username === allowed.username &&
      target.password === allowed.password
    );
  } catch {
    return false;
  }
}
