import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  HUBRIS_VSCODE_CREATE_CHANNEL,
  HUBRIS_VSCODE_DESTROY_CHANNEL,
  HUBRIS_VSCODE_HIDE_CHANNEL,
  HUBRIS_VSCODE_LOAD_CHANNEL,
  HUBRIS_VSCODE_SET_BOUNDS_CHANNEL,
  HUBRIS_VSCODE_SHOW_CHANNEL,
} from "./vscodeViewShared";

type Listener = (...args: unknown[]) => void;

type MockWebContents = {
  loadURL: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

async function loadVscodeViewsModule() {
  vi.resetModules();

  const handles = new Map<string, (...args: unknown[]) => unknown>();
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const shellOpenExternal = vi.fn(async () => {});
  const createdViews: Array<{
    options?: unknown;
    setBounds: ReturnType<typeof vi.fn>;
    webContents: MockWebContents;
  }> = [];
  const window = {
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
    isDestroyed: vi.fn(() => false),
  };

  class WebContentsViewMock {
    setBounds = vi.fn();
    webContents: MockWebContents;

    constructor(public options?: unknown) {
      const localListeners = new Map<string, Listener>();
      this.webContents = {
        loadURL: vi.fn(async () => {}),
        on: vi.fn((event: string, handler: Listener) => {
          localListeners.set(event, handler);
        }),
        setWindowOpenHandler: vi.fn(),
        removeAllListeners: vi.fn(() => {
          localListeners.clear();
        }),
        isDestroyed: vi.fn(() => false),
        close: vi.fn(),
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
    shell: {
      openExternal: shellOpenExternal,
    },
  }));

  vi.doMock("./profile", () => ({
    desktopSessionPartition: vi.fn((mode: "dev" | "release") =>
      mode === "dev" ? "persist:hubris-desktop-dev" : "persist:hubris-desktop",
    ),
  }));

  vi.doMock("./protocol", () => ({
    HUBRIS_CODE_SERVER_ORIGIN:
      "https://code-server.desktop.internal.hubris.build",
    HUBRIS_VSCODE_CLI_ORIGIN:
      "https://vscode-cli.desktop.internal.hubris.build",
  }));

  const mod = await import("./vscodeViews.js");

  return {
    createdViews,
    disposeVscodeViewBridge: mod.disposeVscodeViewBridge,
    handles,
    installVscodeViewBridge: mod.installVscodeViewBridge,
    listenerMap: listeners,
    shellOpenExternal,
    window,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("VS Code view bridge", () => {
  it("creates, shows, resizes, hides, reloads, and destroys views", async () => {
    const state = await loadVscodeViewsModule();

    state.installVscodeViewBridge(
      state.window as never,
      "dev",
      "/tmp/vscodePreload.js",
      [
        "https://desktop.internal.hubris.build",
        "https://vscode-cli.desktop.internal.hubris.build",
        "https://code-server.desktop.internal.hubris.build",
      ],
    );

    await state.handles.get(HUBRIS_VSCODE_CREATE_CHANNEL)?.(undefined, {
      worktreeId: "w-feature",
      runtime: "vscodeCli",
      worktreePath: "/tmp/feature-a",
    });

    expect(state.createdViews).toHaveLength(1);
    expect(state.createdViews[0]?.options).toMatchObject({
      webPreferences: {
        partition: "persist:hubris-desktop-dev",
        preload: "/tmp/vscodePreload.js",
        sandbox: true,
      },
    });
    expect(state.createdViews[0]?.webContents.loadURL).toHaveBeenCalledWith(
      "https://vscode-cli.desktop.internal.hubris.build/?folder=%2Ftmp%2Ffeature-a",
    );

    state.listenerMap.get(HUBRIS_VSCODE_SHOW_CHANNEL)?.(undefined, {
      worktreeId: "w-feature",
    });
    expect(state.window.contentView.addChildView).toHaveBeenCalledWith(
      state.createdViews[0],
    );

    state.listenerMap.get(HUBRIS_VSCODE_SET_BOUNDS_CHANNEL)?.(undefined, {
      worktreeId: "w-feature",
      bounds: {
        x: 12.4,
        y: 45.6,
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

    state.listenerMap.get(HUBRIS_VSCODE_LOAD_CHANNEL)?.(undefined, {
      worktreeId: "w-feature",
      runtime: "codeServer",
      worktreePath: "/tmp/feature-a",
    });
    expect(state.createdViews[0]?.webContents.loadURL).toHaveBeenLastCalledWith(
      "https://code-server.desktop.internal.hubris.build/?folder=%2Ftmp%2Ffeature-a",
    );

    state.listenerMap.get(HUBRIS_VSCODE_HIDE_CHANNEL)?.(undefined, {
      worktreeId: "w-feature",
    });
    expect(state.window.contentView.removeChildView).toHaveBeenCalledWith(
      state.createdViews[0],
    );

    state.listenerMap.get(HUBRIS_VSCODE_DESTROY_CHANNEL)?.(undefined, {
      worktreeId: "w-feature",
    });
    expect(state.createdViews[0]?.webContents.close).toHaveBeenCalledTimes(1);
  });

  it("preserves retained views across bridge disposal until explicitly destroyed", async () => {
    const state = await loadVscodeViewsModule();

    state.installVscodeViewBridge(
      state.window as never,
      "dev",
      "/tmp/vscodePreload.js",
      [
        "https://desktop.internal.hubris.build",
        "https://vscode-cli.desktop.internal.hubris.build",
        "https://code-server.desktop.internal.hubris.build",
      ],
    );
    await state.handles.get(HUBRIS_VSCODE_CREATE_CHANNEL)?.(undefined, {
      worktreeId: "w-feature",
      runtime: "vscodeCli",
      worktreePath: "/tmp/feature-a",
    });
    state.listenerMap.get(HUBRIS_VSCODE_SHOW_CHANNEL)?.(undefined, {
      worktreeId: "w-feature",
    });

    state.disposeVscodeViewBridge();

    expect(state.window.contentView.removeChildView).toHaveBeenCalledWith(
      state.createdViews[0],
    );
    expect(state.createdViews[0]?.webContents.close).not.toHaveBeenCalled();

    const nextWindow = {
      contentView: {
        addChildView: vi.fn(),
        removeChildView: vi.fn(),
      },
      isDestroyed: vi.fn(() => false),
    };

    state.installVscodeViewBridge(
      nextWindow as never,
      "dev",
      "/tmp/vscodePreload.js",
      [
        "https://desktop.internal.hubris.build",
        "https://vscode-cli.desktop.internal.hubris.build",
        "https://code-server.desktop.internal.hubris.build",
      ],
    );
    await state.handles.get(HUBRIS_VSCODE_CREATE_CHANNEL)?.(undefined, {
      worktreeId: "w-feature",
      runtime: "vscodeCli",
      worktreePath: "/tmp/feature-a",
    });
    state.listenerMap.get(HUBRIS_VSCODE_SHOW_CHANNEL)?.(undefined, {
      worktreeId: "w-feature",
    });

    expect(nextWindow.contentView.addChildView).toHaveBeenCalledWith(
      state.createdViews[0],
    );
  });

  it("blocks frame navigations and only opens external http urls", async () => {
    const state = await loadVscodeViewsModule();

    state.installVscodeViewBridge(
      state.window as never,
      "dev",
      "/tmp/vscodePreload.js",
      [
        "https://desktop.internal.hubris.build",
        "https://vscode-cli.desktop.internal.hubris.build",
        "https://code-server.desktop.internal.hubris.build",
      ],
    );
    await state.handles.get(HUBRIS_VSCODE_CREATE_CHANNEL)?.(undefined, {
      worktreeId: "w-feature",
      runtime: "vscodeCli",
      worktreePath: "/tmp/feature-a",
    });

    const frameNavigationHandler =
      state.createdViews[0]?.webContents.on.mock.calls.find(
        ([event]) => event === "will-frame-navigate",
      )?.[1];
    expect(frameNavigationHandler).toBeTypeOf("function");

    const blockedEvent = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      url: "javascript:alert('owned')",
    };
    frameNavigationHandler?.(blockedEvent);

    expect(blockedEvent.defaultPrevented).toBe(true);
    expect(state.shellOpenExternal).not.toHaveBeenCalled();

    const popupHandler =
      state.createdViews[0]?.webContents.setWindowOpenHandler.mock
        .calls[0]?.[0];
    expect(popupHandler).toBeTypeOf("function");

    expect(popupHandler?.({ url: "file:///tmp/secret.txt" })).toEqual({
      action: "deny",
    });
    expect(state.shellOpenExternal).not.toHaveBeenCalled();

    expect(popupHandler?.({ url: "https://example.com/docs" })).toEqual({
      action: "deny",
    });
    expect(state.shellOpenExternal).toHaveBeenCalledWith(
      "https://example.com/docs",
    );
  });

  it("keeps trusted VS Code webview bootstrap urls inside the view", async () => {
    const state = await loadVscodeViewsModule();

    state.installVscodeViewBridge(
      state.window as never,
      "dev",
      "/tmp/vscodePreload.js",
      [
        "https://desktop.internal.hubris.build",
        "https://vscode-cli.desktop.internal.hubris.build",
        "https://code-server.desktop.internal.hubris.build",
      ],
    );
    await state.handles.get(HUBRIS_VSCODE_CREATE_CHANNEL)?.(undefined, {
      worktreeId: "w-feature",
      runtime: "vscodeCli",
      worktreePath: "/tmp/feature-a",
    });

    const frameNavigationHandler =
      state.createdViews[0]?.webContents.on.mock.calls.find(
        ([event]) => event === "will-frame-navigate",
      )?.[1];
    expect(frameNavigationHandler).toBeTypeOf("function");

    const trustedWebviewUrl =
      "https://02kmpqvunlvrq93tfs6n5q8n84bsmlgppb0lhik12jjv7p71170v.vscode-cdn.net/stable/560a9dba96f961efea7b1612916f89e5d5d4d679/out/vs/workbench/contrib/webview/browser/pre/index.html?id=044957d5-b37b-434f-9182-19d35ee5b6a2&parentId=1&origin=04f672ab-ba1e-4f25-9d98-00ab77d109f9&swVersion=4&extensionId=&platform=browser&vscode-resource-base-authority=vscode-resource.vscode-cdn.net&parentOrigin=https%3A%2F%2Fvscode-cli.desktop.internal.hubris.build&disableServiceWorker=true&remoteAuthority=vscode-cli.desktop.internal.hubris.build";

    const navigationEvent = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      url: trustedWebviewUrl,
    };
    frameNavigationHandler?.(navigationEvent);

    expect(navigationEvent.defaultPrevented).toBe(false);
    expect(state.shellOpenExternal).not.toHaveBeenCalled();

    const popupHandler =
      state.createdViews[0]?.webContents.setWindowOpenHandler.mock
        .calls[0]?.[0];
    expect(popupHandler).toBeTypeOf("function");

    expect(popupHandler?.({ url: trustedWebviewUrl })).toEqual({
      action: "deny",
    });
    expect(state.shellOpenExternal).not.toHaveBeenCalled();
  });

  it("keeps trusted VS Code fake webview bootstrap urls inside the view", async () => {
    const state = await loadVscodeViewsModule();

    state.installVscodeViewBridge(
      state.window as never,
      "dev",
      "/tmp/vscodePreload.js",
      [
        "https://desktop.internal.hubris.build",
        "https://vscode-cli.desktop.internal.hubris.build",
        "https://code-server.desktop.internal.hubris.build",
      ],
    );
    await state.handles.get(HUBRIS_VSCODE_CREATE_CHANNEL)?.(undefined, {
      worktreeId: "w-feature",
      runtime: "vscodeCli",
      worktreePath: "/tmp/feature-a",
    });

    const frameNavigationHandler =
      state.createdViews[0]?.webContents.on.mock.calls.find(
        ([event]) => event === "will-frame-navigate",
      )?.[1];
    expect(frameNavigationHandler).toBeTypeOf("function");

    const trustedFakeWebviewUrl =
      "https://1pcfbad8e6ro99bgouf42o8ovivd4fkiu0m5j4j708ro97hqa2v8.vscode-cdn.net/stable/560a9dba96f961efea7b1612916f89e5d5d4d679/out/vs/workbench/contrib/webview/browser/pre/fake.html?id=485b912c-9350-4b7d-9920-a34182edbb06";

    const navigationEvent = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      url: trustedFakeWebviewUrl,
    };
    frameNavigationHandler?.(navigationEvent);

    expect(navigationEvent.defaultPrevented).toBe(false);
    expect(state.shellOpenExternal).not.toHaveBeenCalled();

    const popupHandler =
      state.createdViews[0]?.webContents.setWindowOpenHandler.mock
        .calls[0]?.[0];
    expect(popupHandler).toBeTypeOf("function");

    expect(popupHandler?.({ url: trustedFakeWebviewUrl })).toEqual({
      action: "deny",
    });
    expect(state.shellOpenExternal).not.toHaveBeenCalled();
  });
});
