import type { contextBridge as ElectronContextBridge } from "electron";

import type { DesktopRuntimeConfig } from "./desktopRuntimeConfigShared";
export type { DesktopRuntimeConfig } from "./desktopRuntimeConfigShared";

import {
  HUBRIS_CODE_SERVER_ORIGIN,
  HUBRIS_ORIGIN,
  HUBRIS_VSCODE_CLI_ORIGIN,
  HUBRIS_WS_ORIGIN,
} from "./desktopOrigins";

type ContextBridgeLike = Pick<
  typeof ElectronContextBridge,
  "executeInMainWorld"
>;

/** Build the desktop runtime URLs exposed to the main Hubris window. */
export function buildDesktopRuntimeConfig(): DesktopRuntimeConfig {
  return {
    apiBase: `${HUBRIS_ORIGIN}/api`,
    eventsUrl: `${HUBRIS_ORIGIN}/api/events`,
    terminalWsBase: `${HUBRIS_WS_ORIGIN}/api/terminal/ws`,
    vscodeBases: {
      codeServer: `${HUBRIS_CODE_SERVER_ORIGIN}/`,
      vscodeCli: `${HUBRIS_VSCODE_CLI_ORIGIN}/`,
    },
  };
}

/** Install desktop runtime config into the page world before app startup. */
export function installDesktopRuntimeConfigInMainWorld(
  contextBridge: ContextBridgeLike,
): void {
  contextBridge.executeInMainWorld({
    func: (desktopConfig: DesktopRuntimeConfig) => {
      window.__HUBRIS_DESKTOP_CONFIG__ = desktopConfig;
    },
    args: [buildDesktopRuntimeConfig()],
  });
}
