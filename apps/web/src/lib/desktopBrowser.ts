export type DesktopBrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DesktopBrowserState = {
  tabId: string;
  url: string;
  title: string | null;
  history: string[];
  historyIndex: number;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  error: string | null;
};

type DesktopBrowserBridge = {
  create: (payload: {
    tabId: string;
    url: string;
  }) => Promise<{ state: DesktopBrowserState }>;
  destroy: (payload: { tabId: string }) => void;
  show: (payload: { tabId: string }) => void;
  hide: (payload: { tabId: string }) => void;
  setBounds: (payload: { tabId: string; bounds: DesktopBrowserBounds }) => void;
  navigate: (payload: { tabId: string; url: string }) => void;
  goBack: (payload: { tabId: string }) => void;
  goForward: (payload: { tabId: string }) => void;
  reload: (payload: { tabId: string }) => void;
  subscribe: (listener: (state: DesktopBrowserState) => void) => () => void;
};

declare global {
  interface Window {
    __HUBRIS_ELECTRON_BROWSER__?: DesktopBrowserBridge;
  }
}

/** Return the Electron browser-view bridge when running in desktop mode. */
export function desktopBrowserBridge(): DesktopBrowserBridge | null {
  return window.__HUBRIS_ELECTRON_BROWSER__ ?? null;
}

/** Whether the current renderer can talk to the desktop browser bridge. */
export function hasDesktopBrowserBridge(): boolean {
  return desktopBrowserBridge() !== null;
}
