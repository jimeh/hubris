export const HUBRIS_BROWSER_CREATE_CHANNEL = "hubris:browser-create";
export const HUBRIS_BROWSER_DESTROY_CHANNEL = "hubris:browser-destroy";
export const HUBRIS_BROWSER_SHOW_CHANNEL = "hubris:browser-show";
export const HUBRIS_BROWSER_HIDE_CHANNEL = "hubris:browser-hide";
export const HUBRIS_BROWSER_SET_BOUNDS_CHANNEL = "hubris:browser-set-bounds";
export const HUBRIS_BROWSER_NAVIGATE_CHANNEL = "hubris:browser-navigate";
export const HUBRIS_BROWSER_BACK_CHANNEL = "hubris:browser-back";
export const HUBRIS_BROWSER_FORWARD_CHANNEL = "hubris:browser-forward";
export const HUBRIS_BROWSER_RELOAD_CHANNEL = "hubris:browser-reload";
export const HUBRIS_BROWSER_EVENT_CHANNEL = "hubris:browser-event";

export type BrowserViewBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserViewState = {
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

export type BrowserViewCreateRequest = {
  tabId: string;
  url: string;
};

export type BrowserViewCreateResponse = {
  state: BrowserViewState;
};

export type BrowserViewTabRequest = {
  tabId: string;
};

export type BrowserViewNavigateRequest = {
  tabId: string;
  url: string;
};

export type BrowserViewSetBoundsRequest = {
  tabId: string;
  bounds: BrowserViewBounds;
};
