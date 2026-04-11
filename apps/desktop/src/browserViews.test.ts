import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  HUBRIS_BROWSER_BACK_CHANNEL,
  HUBRIS_BROWSER_CREATE_CHANNEL,
  HUBRIS_BROWSER_DESTROY_CHANNEL,
  HUBRIS_BROWSER_EVENT_CHANNEL,
  HUBRIS_BROWSER_HIDE_CHANNEL,
  HUBRIS_BROWSER_SET_BOUNDS_CHANNEL,
  HUBRIS_BROWSER_SHOW_CHANNEL,
  type BrowserViewState,
} from "./browserViewShared";

type Listener = (...args: unknown[]) => void;

type MockWebContents = {
  listeners: Map<string, Listener>;
  openHandler: ((details: { url: string }) => { action: "deny" }) | null;
  loadURL: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  goForward: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
};

async function loadBrowserViewsModule() {
  vi.resetModules();

  const handles = new Map<string, (...args: unknown[]) => unknown>();
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const createdViews: Array<{
    options?: unknown;
    setBounds: ReturnType<typeof vi.fn>;
    webContents: MockWebContents;
  }> = [];
  const shell = {
    openExternal: vi.fn(async () => {}),
  };
  const window = {
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
    webContents: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
  };

  class WebContentsViewMock {
    setBounds = vi.fn();
    webContents: MockWebContents;

    constructor(public options?: unknown) {
      const localListeners = new Map<string, Listener>();
      this.webContents = {
        listeners: localListeners,
        openHandler: null,
        loadURL: vi.fn(async () => {}),
        on: vi.fn((event: string, handler: Listener) => {
          localListeners.set(event, handler);
        }),
        setWindowOpenHandler: vi.fn(
          (handler: (details: { url: string }) => { action: "deny" }) => {
            this.webContents.openHandler = handler;
          },
        ),
        removeAllListeners: vi.fn(() => {
          localListeners.clear();
        }),
        isDestroyed: vi.fn(() => false),
        close: vi.fn(),
        send: vi.fn(),
        goBack: vi.fn(),
        goForward: vi.fn(),
        reload: vi.fn(),
        emit: (event: string, ...args: unknown[]) => {
          localListeners.get(event)?.(...args);
        },
      };
      createdViews.push(this);
    }
  }

  vi.doMock("electron", () => ({
    BrowserWindow: vi.fn(),
    WebContentsView: WebContentsViewMock,
    ipcMain: {
      handle: vi.fn(
        (channel: string, handler: (...args: unknown[]) => unknown) =>
          handles.set(channel, handler),
      ),
      on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) =>
        listeners.set(channel, handler),
      ),
    },
    shell,
  }));

  vi.doMock("./profile", () => ({
    desktopBrowserSessionPartition: vi.fn((mode: "dev" | "release") =>
      mode === "dev"
        ? "persist:hubris-desktop-browser-dev"
        : "persist:hubris-desktop-browser",
    ),
  }));

  const mod = await import("./browserViews.js");

  return {
    createdViews,
    disposeBrowserViewBridge: mod.disposeBrowserViewBridge,
    handles,
    installBrowserViewBridge: mod.installBrowserViewBridge,
    listenerMap: listeners,
    shell,
    window,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("browser view bridge", () => {
  it("creates, shows, resizes, hides, and destroys browser views", async () => {
    const state = await loadBrowserViewsModule();

    state.installBrowserViewBridge(state.window as never, "dev");

    const created = (await state.handles.get(HUBRIS_BROWSER_CREATE_CHANNEL)?.(
      undefined,
      {
        tabId: "browser-1",
        url: "http://localhost:3000/",
      },
    )) as { state: BrowserViewState };

    expect(created.state.url).toBe("http://localhost:3000/");
    expect(state.createdViews).toHaveLength(1);
    expect(state.createdViews[0]?.options).toMatchObject({
      webPreferences: {
        partition: "persist:hubris-desktop-browser-dev",
        sandbox: true,
      },
    });

    state.listenerMap.get(HUBRIS_BROWSER_SHOW_CHANNEL)?.(undefined, {
      tabId: "browser-1",
    });
    expect(state.window.contentView.addChildView).toHaveBeenCalledWith(
      state.createdViews[0],
    );

    state.listenerMap.get(HUBRIS_BROWSER_SET_BOUNDS_CHANNEL)?.(undefined, {
      tabId: "browser-1",
      bounds: {
        x: 12.3,
        y: 45.8,
        width: 640.2,
        height: 480.9,
      },
    });
    expect(state.createdViews[0]?.setBounds).toHaveBeenLastCalledWith({
      x: 12,
      y: 46,
      width: 640,
      height: 481,
    });

    state.listenerMap.get(HUBRIS_BROWSER_HIDE_CHANNEL)?.(undefined, {
      tabId: "browser-1",
    });
    expect(state.window.contentView.removeChildView).toHaveBeenCalledWith(
      state.createdViews[0],
    );

    state.listenerMap.get(HUBRIS_BROWSER_DESTROY_CHANNEL)?.(undefined, {
      tabId: "browser-1",
    });
    expect(state.createdViews[0]?.webContents.close).toHaveBeenCalledTimes(1);
  });

  it("denies popup windows and opens them externally", async () => {
    const state = await loadBrowserViewsModule();

    state.installBrowserViewBridge(state.window as never, "dev");
    await state.handles.get(HUBRIS_BROWSER_CREATE_CHANNEL)?.(undefined, {
      tabId: "browser-2",
      url: "https://example.com/docs",
    });

    const popup = state.createdViews[0]?.webContents.openHandler?.({
      url: "https://example.com/help",
    });

    expect(popup).toEqual({ action: "deny" });
    expect(state.shell.openExternal).toHaveBeenCalledWith(
      "https://example.com/help",
    );
  });

  it("emits navigation and title updates back to the renderer", async () => {
    const state = await loadBrowserViewsModule();

    state.installBrowserViewBridge(state.window as never, "dev");
    await state.handles.get(HUBRIS_BROWSER_CREATE_CHANNEL)?.(undefined, {
      tabId: "browser-3",
      url: "http://localhost:3000/",
    });

    const view = state.createdViews[0]!;
    view.webContents.emit("page-title-updated", undefined, "Preview");
    view.webContents.emit(
      "did-navigate",
      undefined,
      "https://example.com/docs",
    );
    view.webContents.emit("did-stop-loading");

    expect(state.window.webContents.send).toHaveBeenCalledWith(
      HUBRIS_BROWSER_EVENT_CHANNEL,
      expect.objectContaining({
        tabId: "browser-3",
        title: "Preview",
        url: "https://example.com/docs",
        history: ["http://localhost:3000/", "https://example.com/docs"],
        historyIndex: 1,
        canGoBack: true,
        canGoForward: false,
        isLoading: false,
      }),
    );
  });
});
