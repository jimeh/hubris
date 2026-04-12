import { contextBridge, ipcRenderer } from "electron";

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
import {
  HUBRIS_WS_CLOSE_CHANNEL,
  HUBRIS_WS_CONNECT_CHANNEL,
  HUBRIS_WS_EVENT_CHANNEL,
  HUBRIS_WS_SEND_CHANNEL,
  type WebSocketBridgeCloseRequest,
  type WebSocketBridgeConnectRequest,
  type WebSocketBridgeConnectResponse,
  type WebSocketBridgeEvent,
  type WebSocketBridgeSendRequest,
} from "./wsBridgeShared";

type BridgeListener = (event: WebSocketBridgeEvent) => void;

type DesktopWebSocketBridge = {
  connect(
    payload: WebSocketBridgeConnectRequest,
  ): Promise<WebSocketBridgeConnectResponse>;
  send(payload: WebSocketBridgeSendRequest): void;
  close(payload: WebSocketBridgeCloseRequest): void;
  subscribe(listener: BridgeListener): () => void;
};

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

declare global {
  interface Window {
    __HUBRIS_ELECTRON_WS__?: DesktopWebSocketBridge;
    __HUBRIS_ELECTRON_BROWSER__?: DesktopBrowserBridge;
  }
}

const listeners = new Set<BridgeListener>();
const browserListeners = new Set<BrowserBridgeListener>();

const bridge: DesktopWebSocketBridge = {
  connect(payload) {
    return ipcRenderer.invoke(HUBRIS_WS_CONNECT_CHANNEL, payload);
  },
  send(payload) {
    ipcRenderer.send(HUBRIS_WS_SEND_CHANNEL, payload);
  },
  close(payload) {
    ipcRenderer.send(HUBRIS_WS_CLOSE_CHANNEL, payload);
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

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

ipcRenderer.on(
  HUBRIS_WS_EVENT_CHANNEL,
  (_event, payload: WebSocketBridgeEvent) => {
    for (const listener of listeners) {
      listener(payload);
    }
  },
);

ipcRenderer.on(
  HUBRIS_BROWSER_EVENT_CHANNEL,
  (_event, payload: BrowserViewState) => {
    for (const listener of browserListeners) {
      listener(payload);
    }
  },
);

contextBridge.exposeInMainWorld("__HUBRIS_ELECTRON_WS__", bridge);
contextBridge.exposeInMainWorld("__HUBRIS_ELECTRON_BROWSER__", browserBridge);
