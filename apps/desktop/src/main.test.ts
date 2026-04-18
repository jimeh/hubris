import { afterEach, describe, expect, it, vi } from "vitest";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitUntil(assertion: () => void, timeoutMs = 1_000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  assertion();
}

type MockWindow = {
  options: unknown;
  webContents: {
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  handlers: Record<string, (() => void) | undefined>;
  isMinimized: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  maximize: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
};

async function loadMainModule({
  frontendPorts = [Promise.resolve(3001)],
  backendPorts = [Promise.resolve(4001)],
  singleInstanceLock = true,
  savedWindowState = null,
}: {
  frontendPorts?: Array<Promise<number>>;
  backendPorts?: Array<Promise<number>>;
  singleInstanceLock?: boolean;
  savedWindowState?: {
    bounds: { x: number; y: number; width: number; height: number };
    isMaximized: boolean;
  } | null;
} = {}) {
  vi.resetModules();

  process.env.HUBRIS_DEV_ID = "dev-id";
  process.env.HUBRIS_DEV_TMP = "/tmp/hubris-dev";
  process.env.HUBRIS_DESKTOP_SESSION_TOKEN = "desktop-session-token";

  const events: string[] = [];
  const ready = deferred<void>();
  const appOnHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const windows: MockWindow[] = [];
  const createdWindows: MockWindow[] = [];

  const desktopSession = {
    cookies: {
      set: vi.fn(() => Promise.resolve()),
    },
    setPermissionRequestHandler: vi.fn(() => {
      events.push("guard-request");
    }),
    setPermissionCheckHandler: vi.fn(() => {
      events.push("guard-check");
    }),
    on: vi.fn(),
  };
  const browserSession = {
    setPermissionRequestHandler: vi.fn(() => {
      events.push("browser-guard-request");
    }),
    setPermissionCheckHandler: vi.fn(() => {
      events.push("browser-guard-check");
    }),
    on: vi.fn((event: string) => {
      events.push(`browser-session-${event}`);
    }),
  };

  const app = {
    isPackaged: false,
    getPath: vi.fn((name: string) =>
      name === "home" ? "/Users/tester" : "/Users/tester/Library",
    ),
    requestSingleInstanceLock: vi.fn(() => singleInstanceLock),
    whenReady: vi.fn(() => ready.promise),
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      appOnHandlers.set(event, handler);
      events.push(`${event}-registered`);
    }),
    quit: vi.fn(),
  };

  class BrowserWindowMock {
    static getAllWindows() {
      return windows;
    }

    options: unknown;
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    };

    handlers: Record<string, (() => void) | undefined> = {};
    isMinimized = vi.fn(() => false);
    once = vi.fn((event: string, handler: () => void) => {
      this.handlers[event] = handler;
      return this;
    });
    on = vi.fn((event: string, handler: () => void) => {
      this.handlers[event] = handler;
      return this;
    });
    focus = vi.fn();
    loadURL = vi.fn(async () => {});
    maximize = vi.fn();
    restore = vi.fn();
    show = vi.fn();

    constructor(options?: unknown) {
      this.options = options;
      windows.push(this);
      createdWindows.push(this);
      events.push("window-created");
    }
  }

  const waitForFrontendPort = vi.fn(() => frontendPorts.shift()!);
  const waitForBackendPort = vi.fn(() => backendPorts.shift()!);
  const registerHubrisProtocol = vi.fn(async () => ({}));
  const createHubrisWindowOptions = vi.fn(() => ({ title: "Hubris" }));
  const classifyNavigationTarget = vi.fn(() => "internal");
  const loadDesktopWindowState = vi.fn(() => savedWindowState);
  const wireDesktopWindowStatePersistence = vi.fn();

  vi.doMock("electron", () => ({
    app,
    BrowserWindow: BrowserWindowMock,
    session: {
      fromPartition: vi.fn((partition: string) =>
        partition.includes("browser") ? browserSession : desktopSession,
      ),
    },
    shell: {
      openExternal: vi.fn(async () => {}),
    },
  }));

  vi.doMock("./runtime", () => ({
    createDesktopToken: vi.fn(() => "desktop-token"),
    resolvePackagedPaths: vi.fn(),
    spawnPackagedRuntime: vi.fn(),
    waitForBackendPort,
    waitForFrontendPort,
  }));

  vi.doMock("./protocol", () => ({
    HUBRIS_ORIGIN: "https://desktop.internal.hubris.build",
    registerHubrisProtocol,
    registerHubrisScheme: vi.fn(() => {
      events.push("scheme-registered");
    }),
  }));

  vi.doMock("./security", () => ({
    allowedHubrisOrigins: vi.fn(() => [
      "https://desktop.internal.hubris.build",
      "https://vscode-cli.desktop.internal.hubris.build",
      "https://code-server.desktop.internal.hubris.build",
    ]),
    classifyNavigationTarget,
    createHubrisWindowOptions,
  }));

  vi.doMock("./profile", () => ({
    configureDesktopProfilePaths: vi.fn(() => {
      events.push("profile-configured");
    }),
    desktopProfileMode: vi.fn(() => "dev"),
    desktopBrowserSessionPartition: vi.fn(
      () => "persist:hubris-desktop-browser-dev",
    ),
    desktopSessionPartition: vi.fn(() => "persist:hubris-desktop-dev"),
  }));

  vi.doMock("./browserViews", () => ({
    disposeBrowserViewBridge: vi.fn(() => {
      events.push("browser-bridge-disposed");
    }),
    installBrowserViewBridge: vi.fn(() => {
      events.push("browser-bridge-installed");
    }),
  }));

  vi.doMock("./wsBridge", () => ({
    installWebSocketBridge: vi.fn(() => {
      events.push("ws-bridge-installed");
    }),
  }));

  vi.doMock("./windowState", () => ({
    loadDesktopWindowState,
    wireDesktopWindowStatePersistence,
  }));

  await import("./main.js");

  return {
    app,
    appOnHandlers,
    classifyNavigationTarget,
    createHubrisWindowOptions,
    createdWindows,
    browserSession,
    desktopSession,
    events,
    loadDesktopWindowState,
    ready,
    registerHubrisProtocol,
    waitForBackendPort,
    waitForFrontendPort,
    wireDesktopWindowStatePersistence,
    windows,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.HUBRIS_DEV_ID;
  delete process.env.HUBRIS_DEV_TMP;
  delete process.env.HUBRIS_DESKTOP_SESSION_TOKEN;
});

describe("desktop main process startup", () => {
  it("quits immediately when it cannot acquire the single-instance lock", async () => {
    const state = await loadMainModule({ singleInstanceLock: false });

    expect(state.app.quit).toHaveBeenCalledTimes(1);
    expect(state.app.whenReady).not.toHaveBeenCalled();
    expect(state.app.on.mock.calls.map(([event]) => event)).not.toContain(
      "second-instance",
    );
  });

  it("registers activate only after the initial ready flow finishes", async () => {
    const state = await loadMainModule();

    expect(state.app.on.mock.calls.map(([event]) => event)).not.toContain(
      "activate",
    );

    state.ready.resolve();

    await waitUntil(() => {
      expect(state.app.on.mock.calls.map(([event]) => event)).toContain(
        "activate",
      );
    });

    expect(state.events.indexOf("guard-request")).toBeGreaterThan(-1);
    expect(state.events.indexOf("guard-check")).toBeGreaterThan(-1);
    expect(state.events.indexOf("browser-guard-request")).toBeGreaterThan(-1);
    expect(state.events.indexOf("browser-guard-check")).toBeGreaterThan(-1);
    expect(
      state.events.indexOf("browser-session-will-download"),
    ).toBeGreaterThan(-1);
    expect(state.events.indexOf("window-created")).toBeGreaterThan(-1);
    expect(state.events.indexOf("browser-bridge-installed")).toBeGreaterThan(
      -1,
    );
    expect(state.events.indexOf("activate-registered")).toBeGreaterThan(-1);
    expect(state.events.indexOf("guard-request")).toBeLessThan(
      state.events.indexOf("window-created"),
    );
    expect(state.events.indexOf("window-created")).toBeLessThan(
      state.events.indexOf("activate-registered"),
    );
  });

  it("registers the protocol with dev-state metadata for live target refresh", async () => {
    const state = await loadMainModule();

    state.ready.resolve();

    await waitUntil(() => {
      expect(state.registerHubrisProtocol).toHaveBeenCalledTimes(1);
    });

    expect(state.registerHubrisProtocol).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        frontendHttpOrigin: "http://localhost:3001",
        backendHttpOrigin: "http://127.0.0.1:4001",
        backendWsOrigin: "ws://127.0.0.1:4001",
        viteWsOrigin: "ws://localhost:3001",
        devServerState: {
          devId: "dev-id",
          devTmp: "/tmp/hubris-dev",
        },
      }),
    );
  });

  it("blocks external will-navigate requests without crashing event binding", async () => {
    const state = await loadMainModule();
    state.classifyNavigationTarget.mockReturnValue("external");

    state.ready.resolve();

    await waitUntil(() => {
      expect(state.createdWindows).toHaveLength(1);
    });

    const navigationHandler =
      state.createdWindows[0].webContents.on.mock.calls.find(
        ([event]) => event === "will-navigate",
      )?.[1];

    expect(navigationHandler).toBeTypeOf("function");

    const navigationEvent = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      url: "https://example.com/docs",
    };

    navigationHandler?.(navigationEvent);

    expect(navigationEvent.defaultPrevented).toBe(true);
  });

  it("blocks external will-frame-navigate requests", async () => {
    const state = await loadMainModule();
    state.classifyNavigationTarget.mockReturnValue("external");

    state.ready.resolve();

    await waitUntil(() => {
      expect(state.createdWindows).toHaveLength(1);
    });

    const navigationHandler =
      state.createdWindows[0].webContents.on.mock.calls.find(
        ([event]) => event === "will-frame-navigate",
      )?.[1];

    expect(navigationHandler).toBeTypeOf("function");

    const navigationEvent = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      url: "https://example.com/embed",
    };

    navigationHandler?.(navigationEvent);

    expect(navigationEvent.defaultPrevented).toBe(true);
  });

  it("seeds desktop session cookies for the main and runtime origins", async () => {
    const state = await loadMainModule();

    state.ready.resolve();

    await waitUntil(() => {
      expect(state.desktopSession.cookies.set).toHaveBeenCalledTimes(3);
    });

    expect(state.desktopSession.cookies.set).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "https://desktop.internal.hubris.build/",
        name: "hubris_desktop_session",
        value: "desktop-session-token",
      }),
    );
    expect(state.desktopSession.cookies.set).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "https://vscode-cli.desktop.internal.hubris.build/",
        name: "hubris_desktop_session",
        value: "desktop-session-token",
      }),
    );
    expect(state.desktopSession.cookies.set).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        url: "https://code-server.desktop.internal.hubris.build/",
        name: "hubris_desktop_session",
        value: "desktop-session-token",
      }),
    );
  });

  it("keeps running when the last window closes", async () => {
    const state = await loadMainModule();

    state.ready.resolve();

    await waitUntil(() => {
      expect(state.createdWindows).toHaveLength(1);
    });

    const windowAllClosed = state.appOnHandlers.get("window-all-closed");
    expect(windowAllClosed).toBeTypeOf("function");

    windowAllClosed?.();

    expect(state.app.quit).not.toHaveBeenCalled();
  });

  it("restores saved bounds and maximized state for the main window", async () => {
    const state = await loadMainModule({
      savedWindowState: {
        bounds: { x: 48, y: 64, width: 1280, height: 840 },
        isMaximized: true,
      },
    });

    state.ready.resolve();

    await waitUntil(() => {
      expect(state.createdWindows).toHaveLength(1);
    });

    const window = state.createdWindows[0]!;
    expect(state.loadDesktopWindowState).toHaveBeenCalledWith(
      "/Users/tester/Library",
    );
    expect(window.options).toMatchObject({
      title: "Hubris",
      x: 48,
      y: 64,
      width: 1280,
      height: 840,
    });
    expect(window.maximize).not.toHaveBeenCalled();
    expect(state.wireDesktopWindowStatePersistence).toHaveBeenCalledWith(
      window,
      "/Users/tester/Library",
    );

    window.show.mockClear();
    window.handlers["ready-to-show"]?.();

    expect(window.maximize).toHaveBeenCalledTimes(1);
    expect(window.show).not.toHaveBeenCalled();
  });

  it("reopens the existing window on second-instance without reinitializing desktop state", async () => {
    const state = await loadMainModule();

    state.ready.resolve();

    await waitUntil(() => {
      expect(state.createdWindows).toHaveLength(1);
    });

    const existingWindow = state.createdWindows[0]!;
    existingWindow.isMinimized.mockReturnValue(true);
    existingWindow.restore.mockClear();
    existingWindow.show.mockClear();
    existingWindow.focus.mockClear();

    const secondInstance = state.appOnHandlers.get("second-instance");
    expect(secondInstance).toBeTypeOf("function");

    secondInstance?.();

    await waitUntil(() => {
      expect(existingWindow.restore).toHaveBeenCalledTimes(1);
      expect(existingWindow.show).toHaveBeenCalled();
      expect(existingWindow.focus).toHaveBeenCalledTimes(1);
    });

    expect(state.waitForFrontendPort).toHaveBeenCalledTimes(1);
    expect(state.waitForBackendPort).toHaveBeenCalledTimes(1);
    expect(state.registerHubrisProtocol).toHaveBeenCalledTimes(1);

    state.windows.length = 0;
    existingWindow.handlers.closed?.();
    expect(state.events).toContain("browser-bridge-disposed");

    secondInstance?.();

    await waitUntil(() => {
      expect(state.createdWindows).toHaveLength(2);
    });

    const reopenedWindow = state.createdWindows[1]!;
    expect(reopenedWindow.show).toHaveBeenCalled();
    expect(reopenedWindow.focus).toHaveBeenCalled();
    expect(state.waitForFrontendPort).toHaveBeenCalledTimes(1);
    expect(state.waitForBackendPort).toHaveBeenCalledTimes(1);
    expect(state.registerHubrisProtocol).toHaveBeenCalledTimes(1);
  });

  it("reuses one in-flight startup across concurrent activate events", async () => {
    const state = await loadMainModule();

    state.ready.resolve();

    await waitUntil(() => {
      expect(state.createdWindows).toHaveLength(1);
    });

    state.windows.length = 0;
    state.createdWindows[0]?.handlers.closed?.();

    const activate = state.appOnHandlers.get("activate");
    expect(activate).toBeTypeOf("function");

    activate?.();
    activate?.();

    await waitUntil(() => {
      expect(state.createdWindows).toHaveLength(2);
    });

    expect(state.waitForFrontendPort).toHaveBeenCalledTimes(1);
    expect(state.waitForBackendPort).toHaveBeenCalledTimes(1);
    expect(state.registerHubrisProtocol).toHaveBeenCalledTimes(1);
  });
});
