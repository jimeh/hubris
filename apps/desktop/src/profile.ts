import fs from "node:fs";
import path from "node:path";

import type { App } from "electron";

export type DesktopProfileMode = "dev" | "release";

const RELEASE_APP_NAME = "Hubris";
const DEV_APP_NAME = "Hubris Dev";
const SESSION_DATA_APP_NAME = "Hubris";

/**
 * Resolve the desktop profile mode from the packaged state.
 */
export function desktopProfileMode(isPackaged: boolean): DesktopProfileMode {
  return isPackaged ? "release" : "dev";
}

/**
 * Return the native app-data directory name for the given desktop mode.
 */
export function desktopAppDataName(mode: DesktopProfileMode): string {
  return mode === "release" ? RELEASE_APP_NAME : DEV_APP_NAME;
}

/**
 * Return the persistent partition used by the Hubris desktop window.
 */
export function desktopSessionPartition(mode: DesktopProfileMode): string {
  return mode === "release"
    ? "persist:hubris-desktop"
    : "persist:hubris-desktop-dev";
}

/**
 * Return the persistent partition used by embedded browser tabs.
 */
export function desktopBrowserSessionPartition(
  mode: DesktopProfileMode,
): string {
  return mode === "release"
    ? "persist:hubris-desktop-browser"
    : "persist:hubris-desktop-browser-dev";
}

/**
 * Resolve the Electron userData path for the Hubris desktop profile.
 */
export function desktopUserDataPath(
  appDataPath: string,
  mode: DesktopProfileMode,
): string {
  return path.join(appDataPath, desktopAppDataName(mode));
}

/**
 * Resolve the Electron sessionData path for the Hubris desktop profile.
 */
export function desktopSessionDataPath(
  appDataPath: string,
  _mode: DesktopProfileMode,
): string {
  return path.join(appDataPath, SESSION_DATA_APP_NAME, "sessionData");
}

/**
 * Configure the Electron userData/sessionData directories for the active
 * desktop profile before any session is created.
 */
export function configureDesktopProfilePaths(
  electronApp: Pick<App, "getPath" | "setPath">,
  mode: DesktopProfileMode,
) {
  const appDataPath = electronApp.getPath("appData");
  const userDataPath = desktopUserDataPath(appDataPath, mode);
  const sessionDataPath = desktopSessionDataPath(appDataPath, mode);

  fs.mkdirSync(userDataPath, { recursive: true });
  fs.mkdirSync(sessionDataPath, { recursive: true });

  electronApp.setPath("userData", userDataPath);
  electronApp.setPath("sessionData", sessionDataPath);
}
