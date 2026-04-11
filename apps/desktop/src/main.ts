import path from "node:path";
import {
  app,
  BrowserWindow,
  session,
  shell,
  type Cookies,
  type Session,
  type WebContents,
} from "electron";

import {
  createDesktopToken,
  resolvePackagedPaths,
  spawnPackagedRuntime,
  waitForBackendPort,
  waitForFrontendPort,
  type PackagedRuntimeOptions,
} from "./runtime";
import {
  HUBRIS_ORIGIN,
  type DesktopProtocolTargets,
  registerHubrisProtocol,
  registerHubrisScheme,
} from "./protocol";
import {
  classifyNavigationTarget,
  createHubrisWindowOptions,
} from "./security";
import {
  configureDesktopProfilePaths,
  desktopBrowserSessionPartition,
  desktopProfileMode,
  desktopSessionPartition,
} from "./profile";
import {
  loadDesktopWindowState,
  wireDesktopWindowStatePersistence,
} from "./windowState";
import {
  disposeBrowserViewBridge,
  installBrowserViewBridge,
} from "./browserViews";
import { installWebSocketBridge } from "./wsBridge";

registerHubrisScheme();

const APP_DATA_DIR_NAME = ".hubris";
const profileMode = desktopProfileMode(app.isPackaged);

let mainWindow: BrowserWindow | null = null;
let runtimeChild: ReturnType<typeof spawnPackagedRuntime>["child"] | null =
  null;
let desktopInitialization: Promise<void> | null = null;
let desktopInitialized = false;
let mainWindowStartup: Promise<BrowserWindow> | null = null;

function homeDataDir(): string {
  return path.join(app.getPath("home"), APP_DATA_DIR_NAME);
}

/**
 * Shut down the packaged Rust runtime if it is still running.
 */
function stopRuntimeChild() {
  if (!runtimeChild || runtimeChild.killed) {
    return;
  }

  runtimeChild.kill("SIGTERM");
  runtimeChild = null;
}

/**
 * Resolve the desktop URL that Electron should load.
 */
async function resolveProtocolTargets(): Promise<{
  targets: DesktopProtocolTargets;
  sessionToken: string;
  bootstrapToken?: string;
}> {
  if (!app.isPackaged) {
    const devId = process.env.HUBRIS_DEV_ID;
    const devTmp = process.env.HUBRIS_DEV_TMP;
    const sessionToken = process.env.HUBRIS_DESKTOP_SESSION_TOKEN;

    if (!devId || !devTmp || !sessionToken) {
      throw new Error("missing desktop dev environment configuration");
    }

    const [frontendPort, backendPort] = await Promise.all([
      waitForFrontendPort(devId, devTmp),
      waitForBackendPort(devId, devTmp),
    ]);

    return {
      targets: {
        frontendHttpOrigin: `http://localhost:${frontendPort}`,
        backendHttpOrigin: `http://127.0.0.1:${backendPort}`,
        backendWsOrigin: `ws://127.0.0.1:${backendPort}`,
        viteWsOrigin: `ws://localhost:${frontendPort}`,
      },
      sessionToken,
    };
  }

  const sessionToken = createDesktopToken();
  const bootstrapToken = createDesktopToken();
  const packaged = resolvePackagedPaths(process.resourcesPath);
  const runtime = spawnPackagedRuntime({
    runtimeExecutable: packaged.runtimeExecutable,
    dataDir: homeDataDir(),
    sessionToken,
    bootstrapToken,
  } satisfies PackagedRuntimeOptions);

  runtimeChild = runtime.child;
  const startup = await runtime.startup;

  return {
    targets: {
      frontendDistDir: packaged.frontendDistDir,
      backendHttpOrigin: `http://127.0.0.1:${startup.port}`,
      backendWsOrigin: `ws://127.0.0.1:${startup.port}`,
    },
    sessionToken,
    bootstrapToken,
  };
}

/**
 * Install the session-level permission policy for the Hubris window.
 */
function configureSessionGuards(desktopSession: Session) {
  desktopSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  desktopSession.setPermissionCheckHandler(() => false);
}

/**
 * Apply the stricter embedded-browser policy for browser tab sessions.
 */
function configureBrowserSessionGuards(browserSession: Session) {
  configureSessionGuards(browserSession);
  browserSession.on("will-download", (event) => {
    event.preventDefault();
  });
}

/**
 * Enforce navigation and popup restrictions on the Hubris webview.
 */
function configureWebContentsGuards(
  webContents: WebContents,
  allowedOrigin: string,
) {
  const openExternalUrl = (url: string) => {
    void shell.openExternal(url).catch((error: unknown) => {
      console.error("failed to open external URL", { url, error });
    });
  };

  webContents.setWindowOpenHandler(({ url }) => {
    if (classifyNavigationTarget(url, allowedOrigin) === "external") {
      openExternalUrl(url);
    }

    return { action: "deny" };
  });

  const blockIfDisallowed = ({
    preventDefault,
    url,
  }: {
    preventDefault: () => void;
    url: string;
  }) => {
    const target = classifyNavigationTarget(url, allowedOrigin);
    if (target === "internal") {
      return;
    }

    preventDefault();
    if (target === "external") {
      openExternalUrl(url);
    }
  };

  webContents.on("will-navigate", (details) => {
    blockIfDisallowed(details);
  });
  webContents.on("will-frame-navigate", (details) => {
    blockIfDisallowed(details);
  });
  webContents.on("will-redirect", (details) => {
    blockIfDisallowed(details);
  });
}

/**
 * Perform the one-time desktop runtime, protocol, and cookie bootstrap.
 */
async function initializeDesktop() {
  if (desktopInitialized) {
    return;
  }

  if (desktopInitialization) {
    return desktopInitialization;
  }

  const desktopSession = session.fromPartition(
    desktopSessionPartition(profileMode),
  );

  desktopInitialization = (async () => {
    try {
      const { targets, sessionToken, bootstrapToken } =
        await resolveProtocolTargets();
      const protocolContext = await registerHubrisProtocol(
        desktopSession,
        targets,
      );
      installWebSocketBridge(desktopSession, protocolContext, targets);
      if (bootstrapToken) {
        await bootstrapPackagedBackend(
          targets.backendHttpOrigin,
          bootstrapToken,
          sessionToken,
          desktopSession.cookies,
        );
      } else {
        await seedDesktopSessionCookies(
          desktopSession.cookies,
          [HUBRIS_ORIGIN],
          sessionToken,
        );
      }

      desktopInitialized = true;
    } catch (error) {
      stopRuntimeChild();
      throw error;
    }
  })().finally(() => {
    desktopInitialization = null;
  });

  return desktopInitialization;
}

/**
 * Create and load the main Hubris BrowserWindow.
 */
async function createMainWindow() {
  const preloadPath = path.resolve(__dirname, "preload.js");

  await initializeDesktop();
  const userDataPath = app.getPath("userData");
  const savedWindowState = loadDesktopWindowState(userDataPath);

  const window = new BrowserWindow({
    ...createHubrisWindowOptions(preloadPath, profileMode),
    ...savedWindowState?.bounds,
  });
  mainWindow = window;
  wireDesktopWindowStatePersistence(window, userDataPath);

  configureWebContentsGuards(window.webContents, HUBRIS_ORIGIN);
  installBrowserViewBridge(window, profileMode);
  window.once("ready-to-show", () => {
    if (savedWindowState?.isMaximized) {
      window.maximize();
      return;
    }

    window.show();
  });
  window.on("closed", () => {
    disposeBrowserViewBridge();
    mainWindow = null;
  });

  await window.loadURL(`${HUBRIS_ORIGIN}/`);
  return window;
}

function showBrowserWindow(window: BrowserWindow): BrowserWindow {
  if (window.isMinimized()) {
    window.restore();
  }

  window.show();
  window.focus();

  return window;
}

/**
 * Create the main window once, even if multiple startup paths race.
 */
function getOrCreateMainWindow(): Promise<BrowserWindow> {
  if (mainWindow) {
    return Promise.resolve(mainWindow);
  }

  if (mainWindowStartup) {
    return mainWindowStartup;
  }

  mainWindowStartup = createMainWindow().finally(() => {
    mainWindowStartup = null;
  });

  return mainWindowStartup;
}

/**
 * Show the existing window or recreate it if the app is running headless.
 */
async function showMainWindow(): Promise<BrowserWindow> {
  const window = await getOrCreateMainWindow();
  return showBrowserWindow(window);
}

app.on("before-quit", () => {
  stopRuntimeChild();
});

app.on("window-all-closed", () => {
  // Keep Hubris running so background work can continue without a window.
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    void app.whenReady().then(() => showMainWindow());
  });

  configureDesktopProfilePaths(app, profileMode);

  void app.whenReady().then(async () => {
    const desktopSession = session.fromPartition(
      desktopSessionPartition(profileMode),
    );
    const browserSession = session.fromPartition(
      desktopBrowserSessionPartition(profileMode),
    );
    configureSessionGuards(desktopSession);
    configureBrowserSessionGuards(browserSession);
    await showMainWindow();

    app.on("activate", () => {
      void showMainWindow();
    });
  });
}

async function bootstrapPackagedBackend(
  backendHttpOrigin: string,
  bootstrapToken: string,
  sessionToken: string,
  cookies: Cookies,
) {
  const bootstrap = new URL("/_hubris/desktop/bootstrap", backendHttpOrigin);
  bootstrap.searchParams.set("token", bootstrapToken);

  const response = await fetch(bootstrap, { redirect: "manual" });
  if (response.status !== 302) {
    throw new Error(`desktop bootstrap failed with status ${response.status}`);
  }

  await seedDesktopSessionCookies(cookies, [HUBRIS_ORIGIN], sessionToken);
}

async function seedDesktopSessionCookies(
  cookies: Cookies,
  origins: string[],
  sessionToken: string,
) {
  await Promise.all(
    origins.map((origin) =>
      cookies.set({
        url: `${origin}/`,
        name: "hubris_desktop_session",
        value: sessionToken,
        path: "/",
        httpOnly: true,
        sameSite: "strict",
      }),
    ),
  );
}
