import {
  BrowserWindow,
  WebContentsView,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Rectangle,
  type WebContents,
} from "electron";

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
  type BrowserViewBounds,
  type BrowserViewCreateRequest,
  type BrowserViewCreateResponse,
  type BrowserViewNavigateRequest,
  type BrowserViewSetBoundsRequest,
  type BrowserViewState,
  type BrowserViewTabRequest,
} from "./browserViewShared";
import {
  desktopBrowserSessionPartition,
  type DesktopProfileMode,
} from "./profile";

type BrowserViewRecord = {
  view: WebContentsView;
  attached: boolean;
  bounds: Rectangle;
  state: BrowserViewState;
};

type ActiveBrowserViews = {
  window: BrowserWindow;
  partition: string;
};

const activeBrowserViews: { current: ActiveBrowserViews | null } = {
  current: null,
};
const records = new Map<string, BrowserViewRecord>();
let handlersRegistered = false;

function normalizeBounds(bounds: BrowserViewBounds): Rectangle {
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
}

function cloneState(state: BrowserViewState): BrowserViewState {
  return {
    ...state,
    history: [...state.history],
  };
}

function emitState(record: BrowserViewRecord): void {
  const target = activeBrowserViews.current?.window.webContents;
  if (!target || target.isDestroyed()) {
    return;
  }

  target.send(HUBRIS_BROWSER_EVENT_CHANNEL, cloneState(record.state));
}

function isAllowedBrowserUrl(url: string): boolean {
  if (url === "about:blank") {
    return true;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isExternalBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function maybeOpenExternal(url: string): void {
  if (!isExternalBrowserUrl(url)) {
    return;
  }

  void shell.openExternal(url).catch((error: unknown) => {
    console.error("failed to open external browser URL", { url, error });
  });
}

function syncHistory(record: BrowserViewRecord, url: string): void {
  const { history, historyIndex } = record.state;
  if (history[historyIndex] === url) {
    record.state.url = url;
  } else if (historyIndex > 0 && history[historyIndex - 1] === url) {
    record.state.historyIndex -= 1;
    record.state.url = url;
  } else if (
    historyIndex + 1 < history.length &&
    history[historyIndex + 1] === url
  ) {
    record.state.historyIndex += 1;
    record.state.url = url;
  } else {
    record.state.history = [...history.slice(0, historyIndex + 1), url];
    record.state.historyIndex = record.state.history.length - 1;
    record.state.url = url;
  }

  record.state.canGoBack = record.state.historyIndex > 0;
  record.state.canGoForward =
    record.state.historyIndex < record.state.history.length - 1;
}

function configureBrowserViewGuards(webContents: WebContents): void {
  type NavigationDetails = {
    preventDefault(): void;
    url: string;
  };

  webContents.setWindowOpenHandler(({ url }) => {
    maybeOpenExternal(url);
    return { action: "deny" };
  });

  const blockDisallowedNavigation = (details: NavigationDetails) => {
    if (isAllowedBrowserUrl(details.url)) {
      return;
    }

    details.preventDefault();
  };

  webContents.on("will-navigate", (details) => {
    blockDisallowedNavigation(details);
  });
  webContents.on("will-redirect", (details) => {
    blockDisallowedNavigation(details);
  });
}

function attachRecord(record: BrowserViewRecord): void {
  const window = activeBrowserViews.current?.window;
  if (!window || window.isDestroyed() || record.attached) {
    return;
  }

  window.contentView.addChildView(record.view);
  record.attached = true;
  record.view.setBounds(record.bounds);
}

function detachRecord(record: BrowserViewRecord): void {
  const window = activeBrowserViews.current?.window;
  if (!record.attached) {
    return;
  }

  if (window && !window.isDestroyed()) {
    window.contentView.removeChildView(record.view);
  }
  record.attached = false;
}

function destroyRecord(record: BrowserViewRecord): void {
  detachRecord(record);
  record.view.webContents.removeAllListeners();
  if (!record.view.webContents.isDestroyed()) {
    record.view.webContents.close();
  }
}

function createRecord(
  partition: string,
  request: BrowserViewCreateRequest,
): BrowserViewRecord {
  if (!isAllowedBrowserUrl(request.url)) {
    throw new Error("Browser tabs only support http:// and https:// URLs.");
  }

  const view = new WebContentsView({
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  const record: BrowserViewRecord = {
    view,
    attached: false,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    state: {
      tabId: request.tabId,
      url: request.url,
      title: null,
      history: [request.url],
      historyIndex: 0,
      canGoBack: false,
      canGoForward: false,
      isLoading: true,
      error: null,
    },
  };

  configureBrowserViewGuards(view.webContents);
  view.webContents.on("did-start-loading", () => {
    record.state.isLoading = true;
    record.state.error = null;
    emitState(record);
  });
  view.webContents.on("did-stop-loading", () => {
    record.state.isLoading = false;
    emitState(record);
  });
  view.webContents.on("page-title-updated", (_event, title) => {
    record.state.title = title || null;
    emitState(record);
  });
  view.webContents.on("did-navigate", (_event, url) => {
    record.state.error = null;
    syncHistory(record, url);
    emitState(record);
  });
  view.webContents.on("did-navigate-in-page", (_event, url) => {
    record.state.error = null;
    syncHistory(record, url);
    emitState(record);
  });
  view.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) {
        return;
      }

      record.state.isLoading = false;
      record.state.error = `${errorDescription} (${validatedURL})`;
      emitState(record);
    },
  );

  void view.webContents.loadURL(request.url).catch((error: Error) => {
    record.state.isLoading = false;
    record.state.error = error.message;
    emitState(record);
  });

  return record;
}

function findRecord(tabId: string): BrowserViewRecord | null {
  return records.get(tabId) ?? null;
}

async function handleCreate(
  _event: IpcMainInvokeEvent,
  payload: BrowserViewCreateRequest,
): Promise<BrowserViewCreateResponse> {
  const active = activeBrowserViews.current;
  if (!active) {
    throw new Error("desktop browser views not initialized");
  }

  let record = records.get(payload.tabId);
  if (!record) {
    record = createRecord(active.partition, payload);
    records.set(payload.tabId, record);
  }

  return { state: cloneState(record.state) };
}

function handleDestroy(
  _event: IpcMainEvent,
  payload: BrowserViewTabRequest,
): void {
  const record = findRecord(payload.tabId);
  if (!record) {
    return;
  }

  records.delete(payload.tabId);
  destroyRecord(record);
}

function handleShow(
  _event: IpcMainEvent,
  payload: BrowserViewTabRequest,
): void {
  const record = findRecord(payload.tabId);
  if (!record) {
    return;
  }

  attachRecord(record);
  record.view.setBounds(record.bounds);
}

function handleHide(
  _event: IpcMainEvent,
  payload: BrowserViewTabRequest,
): void {
  const record = findRecord(payload.tabId);
  if (!record) {
    return;
  }

  detachRecord(record);
}

function handleSetBounds(
  _event: IpcMainEvent,
  payload: BrowserViewSetBoundsRequest,
): void {
  const record = findRecord(payload.tabId);
  if (!record) {
    return;
  }

  record.bounds = normalizeBounds(payload.bounds);
  if (record.attached) {
    record.view.setBounds(record.bounds);
  }
}

function handleNavigate(
  _event: IpcMainEvent,
  payload: BrowserViewNavigateRequest,
): void {
  const record = findRecord(payload.tabId);
  if (!record || !isAllowedBrowserUrl(payload.url)) {
    return;
  }

  record.state.error = null;
  record.state.isLoading = true;
  void record.view.webContents.loadURL(payload.url).catch((error: Error) => {
    record.state.isLoading = false;
    record.state.error = error.message;
    emitState(record);
  });
  emitState(record);
}

function handleGoBack(
  _event: IpcMainEvent,
  payload: BrowserViewTabRequest,
): void {
  const record = findRecord(payload.tabId);
  if (!record || !record.state.canGoBack) {
    return;
  }

  record.state.isLoading = true;
  emitState(record);
  record.view.webContents.goBack();
}

function handleGoForward(
  _event: IpcMainEvent,
  payload: BrowserViewTabRequest,
): void {
  const record = findRecord(payload.tabId);
  if (!record || !record.state.canGoForward) {
    return;
  }

  record.state.isLoading = true;
  emitState(record);
  record.view.webContents.goForward();
}

function handleReload(
  _event: IpcMainEvent,
  payload: BrowserViewTabRequest,
): void {
  const record = findRecord(payload.tabId);
  if (!record) {
    return;
  }

  record.state.isLoading = true;
  record.state.error = null;
  emitState(record);
  record.view.webContents.reload();
}

/** Install the main-process bridge used by renderer browser tabs. */
export function installBrowserViewBridge(
  window: BrowserWindow,
  mode: DesktopProfileMode,
): void {
  activeBrowserViews.current = {
    window,
    partition: desktopBrowserSessionPartition(mode),
  };

  if (handlersRegistered) {
    return;
  }

  handlersRegistered = true;
  ipcMain.handle(HUBRIS_BROWSER_CREATE_CHANNEL, handleCreate);
  ipcMain.on(HUBRIS_BROWSER_DESTROY_CHANNEL, handleDestroy);
  ipcMain.on(HUBRIS_BROWSER_SHOW_CHANNEL, handleShow);
  ipcMain.on(HUBRIS_BROWSER_HIDE_CHANNEL, handleHide);
  ipcMain.on(HUBRIS_BROWSER_SET_BOUNDS_CHANNEL, handleSetBounds);
  ipcMain.on(HUBRIS_BROWSER_NAVIGATE_CHANNEL, handleNavigate);
  ipcMain.on(HUBRIS_BROWSER_BACK_CHANNEL, handleGoBack);
  ipcMain.on(HUBRIS_BROWSER_FORWARD_CHANNEL, handleGoForward);
  ipcMain.on(HUBRIS_BROWSER_RELOAD_CHANNEL, handleReload);
}

type DisposeBrowserViewBridgeOptions = {
  destroyRecords?: boolean;
};

/** Detach the current browser views, optionally destroying their records too. */
export function disposeBrowserViewBridge(
  options: DisposeBrowserViewBridgeOptions = {},
): void {
  const { destroyRecords = false } = options;

  for (const record of records.values()) {
    if (destroyRecords) {
      destroyRecord(record);
    } else {
      detachRecord(record);
    }
  }
  if (destroyRecords) {
    records.clear();
  }
  activeBrowserViews.current = null;
}
