import type { BrowserWindowConstructorOptions } from "electron";

import { desktopSessionPartition, type DesktopProfileMode } from "./profile";
import {
  HUBRIS_CODE_SERVER_ORIGIN,
  HUBRIS_ORIGIN,
  HUBRIS_VSCODE_CLI_ORIGIN,
} from "./protocol";

export const HUBRIS_WINDOW_TITLE = "Hubris";
export const HUBRIS_WINDOW_WIDTH = 1440;
export const HUBRIS_WINDOW_HEIGHT = 960;
export const HUBRIS_WINDOW_MIN_WIDTH = 1024;
export const HUBRIS_WINDOW_MIN_HEIGHT = 720;

export type NavigationTarget = "internal" | "external" | "deny";

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
  allowedOrigins: string | string[],
): boolean {
  return classifyNavigationTarget(url, allowedOrigins) === "internal";
}

/**
 * Classify a navigation target relative to the desktop app origin.
 */
export function classifyNavigationTarget(
  url: string,
  allowedOrigins: string | string[],
): NavigationTarget {
  try {
    const target = new URL(url);
    const allowedList = Array.isArray(allowedOrigins)
      ? allowedOrigins
      : [allowedOrigins];

    if (
      allowedList.some((allowedOrigin) => {
        const allowed = new URL(allowedOrigin);
        return (
          target.protocol === allowed.protocol &&
          target.host === allowed.host &&
          target.username === allowed.username &&
          target.password === allowed.password
        );
      })
    ) {
      return "internal";
    }

    if (target.protocol === "http:" || target.protocol === "https:") {
      return "external";
    }

    return "deny";
  } catch {
    return "deny";
  }
}

export function allowedHubrisOrigins(): string[] {
  return [HUBRIS_ORIGIN, HUBRIS_VSCODE_CLI_ORIGIN, HUBRIS_CODE_SERVER_ORIGIN];
}
