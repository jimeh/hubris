import { contextBridge, ipcRenderer } from "electron";

import { createDesktopWebSocketBridge } from "./webSocketRendererBridge";
import { installDesktopWebSocketPatchInMainWorld } from "./webSocketPatch";

contextBridge.exposeInMainWorld(
  "__HUBRIS_ELECTRON_WS__",
  createDesktopWebSocketBridge(ipcRenderer),
);
installDesktopWebSocketPatchInMainWorld(contextBridge);
