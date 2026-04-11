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
  webContents: {
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  handlers: Record<string, (() => void) | undefined>;
  once: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
};

async function loadMainModule({
  frontendPorts = [Promise.resolve(3001)],
  backendPorts = [Promise.resolve(4001)],
}: {
  frontendPorts?: Array<Promise<number>>;
  backendPorts?: Array<Promise<number>>;
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
  };

  const app = {
    isPackaged: false,
    getPath: vi.fn((name: string) =>
      name === "home" ? "/Users/tester" : "/Users/tester/Library",
    ),
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

    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    };

    handlers: Record<string, (() => void) | undefined> = {};
    once = vi.fn((event: string, handler: () => void) => {
      this.handlers[event] = handler;
      return this;
    });
    on = vi.fn((event: string, handler: () => void) => {
      this.handlers[event] = handler;
      return this;
    });
    loadURL = vi.fn(async () => {});
    show = vi.fn();

    constructor() {
      windows.push(this);
      createdWindows.push(this);
      events.push("window-created");
    }
  }

  const waitForFrontendPort = vi.fn(() => frontendPorts.shift()!);
  const waitForBackendPort = vi.fn(() => backendPorts.shift()!);
  const registerHubrisProtocol = vi.fn(async () => ({}));

  vi.doMock("electron", () => ({
    app,
    BrowserWindow: BrowserWindowMock,
    session: {
      fromPartition: vi.fn(() => desktopSession),
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
    classifyNavigationTarget: vi.fn(() => "internal"),
    createHubrisWindowOptions: vi.fn(() => ({})),
  }));

  vi.doMock("./profile", () => ({
    configureDesktopProfilePaths: vi.fn(() => {
      events.push("profile-configured");
    }),
    desktopProfileMode: vi.fn(() => "dev"),
    desktopSessionPartition: vi.fn(() => "persist:hubris-desktop-dev"),
  }));

  vi.doMock("./wsBridge", () => ({
    installWebSocketBridge: vi.fn(() => {
      events.push("ws-bridge-installed");
    }),
  }));

  await import("./main.js");

  return {
    app,
    appOnHandlers,
    createdWindows,
    desktopSession,
    events,
    ready,
    registerHubrisProtocol,
    waitForBackendPort,
    waitForFrontendPort,
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
    expect(state.events.indexOf("window-created")).toBeGreaterThan(-1);
    expect(state.events.indexOf("activate-registered")).toBeGreaterThan(-1);
    expect(state.events.indexOf("guard-request")).toBeLessThan(
      state.events.indexOf("window-created"),
    );
    expect(state.events.indexOf("window-created")).toBeLessThan(
      state.events.indexOf("activate-registered"),
    );
  });

  it("reuses one in-flight startup across concurrent activate events", async () => {
    const nextFrontend = deferred<number>();
    const nextBackend = deferred<number>();
    const state = await loadMainModule({
      frontendPorts: [Promise.resolve(3001), nextFrontend.promise],
      backendPorts: [Promise.resolve(4001), nextBackend.promise],
    });

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
      expect(state.waitForFrontendPort).toHaveBeenCalledTimes(2);
      expect(state.waitForBackendPort).toHaveBeenCalledTimes(2);
    });

    nextFrontend.resolve(3002);
    nextBackend.resolve(4002);

    await waitUntil(() => {
      expect(state.createdWindows).toHaveLength(2);
      expect(state.registerHubrisProtocol).toHaveBeenCalledTimes(2);
    });
  });
});
