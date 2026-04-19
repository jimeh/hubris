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

import type { BrowserViewBounds } from "./browserViewShared";
import {
  HUBRIS_CODE_SERVER_ORIGIN,
  HUBRIS_VSCODE_CLI_ORIGIN,
} from "./protocol";
import { desktopSessionPartition, type DesktopProfileMode } from "./profile";
import { classifyNavigationTarget } from "./security";
import {
  HUBRIS_VSCODE_CREATE_CHANNEL,
  HUBRIS_VSCODE_DESTROY_CHANNEL,
  HUBRIS_VSCODE_HIDE_CHANNEL,
  HUBRIS_VSCODE_LOAD_CHANNEL,
  HUBRIS_VSCODE_SET_BOUNDS_CHANNEL,
  HUBRIS_VSCODE_SHOW_CHANNEL,
  type VscodeRuntime,
  type VscodeViewLoadRequest,
  type VscodeViewRequest,
  type VscodeViewSetBoundsRequest,
} from "./vscodeViewShared";

type VscodeViewRecord = {
  view: WebContentsView;
  attached: boolean;
  bounds: Rectangle;
};

type ActiveVscodeViews = {
  window: BrowserWindow;
  partition: string;
  preloadPath: string;
  allowedOrigins: string[];
};

const activeVscodeViews: { current: ActiveVscodeViews | null } = {
  current: null,
};
const records = new Map<string, VscodeViewRecord>();
let handlersRegistered = false;

function normalizeBounds(bounds: BrowserViewBounds): Rectangle {
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
}

function buildVscodeUrl(runtime: VscodeRuntime, worktreePath: string): string {
  const url = new URL(
    runtime === "vscodeCli"
      ? HUBRIS_VSCODE_CLI_ORIGIN
      : HUBRIS_CODE_SERVER_ORIGIN,
  );
  url.searchParams.set("folder", worktreePath);
  return url.toString();
}

function openExternalUrl(url: string): void {
  void shell.openExternal(url).catch((error: unknown) => {
    console.error("failed to open external VS Code URL", { url, error });
  });
}

function classifyVscodeNavigationTarget(
  url: string,
  allowedOrigins: string[],
): "internal" | "external" | "deny" {
  const target = classifyNavigationTarget(url, allowedOrigins);
  if (target === "internal") {
    return target;
  }

  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === "https:" &&
      parsed.hostname.endsWith(".vscode-cdn.net") &&
      /\/out\/vs\/workbench\/contrib\/webview\/browser\/pre\/(?:index|fake)\.html$/.test(
        parsed.pathname,
      )
    ) {
      const parentOrigin = parsed.searchParams.get("parentOrigin");
      const remoteAuthority = parsed.searchParams.get("remoteAuthority");
      const parentAllowed =
        parentOrigin === null ||
        classifyNavigationTarget(parentOrigin, allowedOrigins) === "internal";
      const remoteAllowed =
        remoteAuthority === null ||
        allowedOrigins.some((origin) => new URL(origin).host === remoteAuthority);

      if (parentAllowed && remoteAllowed) {
        return "internal";
      }
    }
  } catch {
    return target;
  }

  return target;
}

function configureVscodeViewGuards(
  webContents: WebContents,
  allowedOrigins: string[],
): void {
  const maybeOpenExternalUrl = (url: string): void => {
    if (classifyVscodeNavigationTarget(url, allowedOrigins) !== "external") {
      return;
    }

    openExternalUrl(url);
  };

  webContents.setWindowOpenHandler(({ url }) => {
    if (classifyVscodeNavigationTarget(url, allowedOrigins) !== "internal") {
      maybeOpenExternalUrl(url);
    }
    return { action: "deny" };
  });

  const blockDisallowedNavigation = (details: {
    preventDefault(): void;
    url: string;
  }) => {
    if (classifyVscodeNavigationTarget(details.url, allowedOrigins) === "internal") {
      return;
    }

    details.preventDefault();
    maybeOpenExternalUrl(details.url);
  };

  webContents.on("will-navigate", (details) => {
    blockDisallowedNavigation(details);
  });
  // Electron emits this at runtime, but the current desktop typings omit it.
  (
    webContents.on as unknown as (
      event: string,
      listener: (details: { preventDefault: () => void; url: string }) => void,
    ) => void
  )("will-frame-navigate", (details) => {
    blockDisallowedNavigation(details);
  });
  webContents.on("will-redirect", (details) => {
    blockDisallowedNavigation(details);
  });
}

function attachRecord(record: VscodeViewRecord): void {
  const window = activeVscodeViews.current?.window;
  if (!window || window.isDestroyed() || record.attached) {
    return;
  }

  window.contentView.addChildView(record.view);
  record.attached = true;
  record.view.setBounds(record.bounds);
}

function detachRecord(record: VscodeViewRecord): void {
  const window = activeVscodeViews.current?.window;
  if (!record.attached) {
    return;
  }

  if (window && !window.isDestroyed()) {
    window.contentView.removeChildView(record.view);
  }
  record.attached = false;
}

function destroyRecord(record: VscodeViewRecord): void {
  detachRecord(record);
  record.view.webContents.removeAllListeners();
  if (!record.view.webContents.isDestroyed()) {
    record.view.webContents.close();
  }
}

function createRecord(
  active: ActiveVscodeViews,
  request: VscodeViewLoadRequest,
): VscodeViewRecord {
  const view = new WebContentsView({
    webPreferences: {
      partition: active.partition,
      preload: active.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  configureVscodeViewGuards(view.webContents, active.allowedOrigins);
  const record: VscodeViewRecord = {
    view,
    attached: false,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
  };

  void view.webContents
    .loadURL(buildVscodeUrl(request.runtime, request.worktreePath))
    .catch((error: Error) => {
      console.error("failed to load VS Code view", {
        worktreeId: request.worktreeId,
        error,
      });
    });

  return record;
}

function findRecord(worktreeId: string): VscodeViewRecord | null {
  return records.get(worktreeId) ?? null;
}

async function handleCreate(
  _event: IpcMainInvokeEvent,
  payload: VscodeViewLoadRequest,
): Promise<void> {
  const active = activeVscodeViews.current;
  if (!active) {
    throw new Error("desktop VS Code views not initialized");
  }

  if (!records.has(payload.worktreeId)) {
    records.set(payload.worktreeId, createRecord(active, payload));
  }
}

function handleDestroy(_event: IpcMainEvent, payload: VscodeViewRequest): void {
  const record = findRecord(payload.worktreeId);
  if (!record) {
    return;
  }

  records.delete(payload.worktreeId);
  destroyRecord(record);
}

function handleShow(_event: IpcMainEvent, payload: VscodeViewRequest): void {
  const record = findRecord(payload.worktreeId);
  if (!record) {
    return;
  }

  attachRecord(record);
  record.view.setBounds(record.bounds);
}

function handleHide(_event: IpcMainEvent, payload: VscodeViewRequest): void {
  const record = findRecord(payload.worktreeId);
  if (!record) {
    return;
  }

  detachRecord(record);
}

function handleSetBounds(
  _event: IpcMainEvent,
  payload: VscodeViewSetBoundsRequest,
): void {
  const record = findRecord(payload.worktreeId);
  if (!record) {
    return;
  }

  record.bounds = normalizeBounds(payload.bounds);
  if (record.attached) {
    record.view.setBounds(record.bounds);
  }
}

function handleLoad(
  _event: IpcMainEvent,
  payload: VscodeViewLoadRequest,
): void {
  const record = findRecord(payload.worktreeId);
  if (!record) {
    return;
  }

  void record.view.webContents
    .loadURL(buildVscodeUrl(payload.runtime, payload.worktreePath))
    .catch((error: Error) => {
      console.error("failed to reload VS Code view", {
        worktreeId: payload.worktreeId,
        error,
      });
    });
}

/** Install the main-process bridge used by renderer VS Code worktree panes. */
export function installVscodeViewBridge(
  window: BrowserWindow,
  mode: DesktopProfileMode,
  preloadPath: string,
  allowedOrigins: string[],
): void {
  activeVscodeViews.current = {
    window,
    partition: desktopSessionPartition(mode),
    preloadPath,
    allowedOrigins,
  };

  if (handlersRegistered) {
    return;
  }

  handlersRegistered = true;
  ipcMain.handle(HUBRIS_VSCODE_CREATE_CHANNEL, handleCreate);
  ipcMain.on(HUBRIS_VSCODE_DESTROY_CHANNEL, handleDestroy);
  ipcMain.on(HUBRIS_VSCODE_HIDE_CHANNEL, handleHide);
  ipcMain.on(HUBRIS_VSCODE_LOAD_CHANNEL, handleLoad);
  ipcMain.on(HUBRIS_VSCODE_SET_BOUNDS_CHANNEL, handleSetBounds);
  ipcMain.on(HUBRIS_VSCODE_SHOW_CHANNEL, handleShow);
}

type DisposeVscodeViewBridgeOptions = {
  destroyRecords?: boolean;
};

/** Detach the current VS Code views, optionally destroying their records too. */
export function disposeVscodeViewBridge(
  options: DisposeVscodeViewBridgeOptions = {},
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
  activeVscodeViews.current = null;
}
