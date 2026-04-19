import { contextBridge, ipcRenderer } from "electron";

import { installDesktopRuntimeConfigInMainWorld } from "./desktopRuntimeConfig";
import {
  HUBRIS_BROWSER_BACK_CHANNEL,
  HUBRIS_BROWSER_CREATE_CHANNEL,
  HUBRIS_BROWSER_DESTROY_CHANNEL,
  HUBRIS_BROWSER_EVENT_CHANNEL,
  HUBRIS_BROWSER_FORWARD_CHANNEL,
  HUBRIS_BROWSER_HIDE_CHANNEL,
  HUBRIS_BROWSER_NAVIGATE_CHANNEL,
  HUBRIS_BROWSER_RELOAD_CHANNEL,
  HUBRIS_BROWSER_SET_BOUNDS_CHANNEL,
  HUBRIS_BROWSER_SHOW_CHANNEL,
  type BrowserViewCreateRequest,
  type BrowserViewCreateResponse,
  type BrowserViewNavigateRequest,
  type BrowserViewSetBoundsRequest,
  type BrowserViewState,
  type BrowserViewTabRequest,
} from "./browserViewShared";
import type { DesktopWebSocketBridge } from "./webSocketRendererBridge";
import { createDesktopWebSocketBridge } from "./webSocketRendererBridge";
import { installDesktopWebSocketPatchInMainWorld } from "./webSocketPatch";
import {
  HUBRIS_VSCODE_CREATE_CHANNEL,
  HUBRIS_VSCODE_DESTROY_CHANNEL,
  HUBRIS_VSCODE_HIDE_CHANNEL,
  HUBRIS_VSCODE_LOAD_CHANNEL,
  HUBRIS_VSCODE_SET_BOUNDS_CHANNEL,
  HUBRIS_VSCODE_SHOW_CHANNEL,
  type VscodeViewLoadRequest,
  type VscodeViewRequest,
  type VscodeViewSetBoundsRequest,
} from "./vscodeViewShared";

type BrowserBridgeListener = (event: BrowserViewState) => void;

type DesktopBrowserBridge = {
  create(payload: BrowserViewCreateRequest): Promise<BrowserViewCreateResponse>;
  destroy(payload: BrowserViewTabRequest): void;
  show(payload: BrowserViewTabRequest): void;
  hide(payload: BrowserViewTabRequest): void;
  setBounds(payload: BrowserViewSetBoundsRequest): void;
  navigate(payload: BrowserViewNavigateRequest): void;
  goBack(payload: BrowserViewTabRequest): void;
  goForward(payload: BrowserViewTabRequest): void;
  reload(payload: BrowserViewTabRequest): void;
  subscribe(listener: BrowserBridgeListener): () => void;
};

type DesktopVscodeBridge = {
  create(payload: VscodeViewLoadRequest): Promise<void>;
  load(payload: VscodeViewLoadRequest): void;
  destroy(payload: VscodeViewRequest): void;
  show(payload: VscodeViewRequest): void;
  hide(payload: VscodeViewRequest): void;
  setBounds(payload: VscodeViewSetBoundsRequest): void;
};

declare global {
  interface Window {
    __HUBRIS_ELECTRON_WS__?: DesktopWebSocketBridge;
    __HUBRIS_ELECTRON_BROWSER__?: DesktopBrowserBridge;
    __HUBRIS_ELECTRON_VSCODE__?: DesktopVscodeBridge;
  }
}

const browserListeners = new Set<BrowserBridgeListener>();
const webSocketBridge = createDesktopWebSocketBridge(ipcRenderer);

const browserBridge: DesktopBrowserBridge = {
  create(payload) {
    return ipcRenderer.invoke(HUBRIS_BROWSER_CREATE_CHANNEL, payload);
  },
  destroy(payload) {
    ipcRenderer.send(HUBRIS_BROWSER_DESTROY_CHANNEL, payload);
  },
  show(payload) {
    ipcRenderer.send(HUBRIS_BROWSER_SHOW_CHANNEL, payload);
  },
  hide(payload) {
    ipcRenderer.send(HUBRIS_BROWSER_HIDE_CHANNEL, payload);
  },
  setBounds(payload) {
    ipcRenderer.send(HUBRIS_BROWSER_SET_BOUNDS_CHANNEL, payload);
  },
  navigate(payload) {
    ipcRenderer.send(HUBRIS_BROWSER_NAVIGATE_CHANNEL, payload);
  },
  goBack(payload) {
    ipcRenderer.send(HUBRIS_BROWSER_BACK_CHANNEL, payload);
  },
  goForward(payload) {
    ipcRenderer.send(HUBRIS_BROWSER_FORWARD_CHANNEL, payload);
  },
  reload(payload) {
    ipcRenderer.send(HUBRIS_BROWSER_RELOAD_CHANNEL, payload);
  },
  subscribe(listener) {
    browserListeners.add(listener);
    return () => {
      browserListeners.delete(listener);
    };
  },
};

const vscodeBridge: DesktopVscodeBridge = {
  create(payload) {
    return ipcRenderer.invoke(HUBRIS_VSCODE_CREATE_CHANNEL, payload);
  },
  load(payload) {
    ipcRenderer.send(HUBRIS_VSCODE_LOAD_CHANNEL, payload);
  },
  destroy(payload) {
    ipcRenderer.send(HUBRIS_VSCODE_DESTROY_CHANNEL, payload);
  },
  show(payload) {
    ipcRenderer.send(HUBRIS_VSCODE_SHOW_CHANNEL, payload);
  },
  hide(payload) {
    ipcRenderer.send(HUBRIS_VSCODE_HIDE_CHANNEL, payload);
  },
  setBounds(payload) {
    ipcRenderer.send(HUBRIS_VSCODE_SET_BOUNDS_CHANNEL, payload);
  },
};

ipcRenderer.on(
  HUBRIS_BROWSER_EVENT_CHANNEL,
  (_event, payload: BrowserViewState) => {
    for (const listener of browserListeners) {
      listener(payload);
    }
  },
);

contextBridge.exposeInMainWorld("__HUBRIS_ELECTRON_WS__", webSocketBridge);
contextBridge.exposeInMainWorld("__HUBRIS_ELECTRON_BROWSER__", browserBridge);
contextBridge.exposeInMainWorld("__HUBRIS_ELECTRON_VSCODE__", vscodeBridge);
installDesktopRuntimeConfigInMainWorld(contextBridge);
installDesktopWebSocketPatchInMainWorld(contextBridge);
