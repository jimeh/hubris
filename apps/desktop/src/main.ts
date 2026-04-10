import path from "node:path";
import {
  app,
  BrowserWindow,
  session,
  type WebContents,
  type Event as ElectronEvent,
} from "electron";

import {
  buildBootstrapUrl,
  createDesktopToken,
  resolvePackagedPaths,
  spawnPackagedRuntime,
  waitForFrontendPort,
  type PackagedRuntimeOptions,
} from "./runtime";
import { createHubrisWindowOptions, isAllowedNavigation } from "./security";
import {
  configureDesktopProfilePaths,
  desktopProfileMode,
  desktopSessionPartition,
} from "./profile";

const APP_DATA_DIR_NAME = ".hubris";
const profileMode = desktopProfileMode(app.isPackaged);

let mainWindow: BrowserWindow | null = null;
let runtimeChild: ReturnType<typeof spawnPackagedRuntime>["child"] | null =
  null;

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
async function resolveHubrisUrl(): Promise<{
  origin: string;
  url: string;
}> {
  if (!app.isPackaged) {
    const devId = process.env.HUBRIS_DEV_ID;
    const devTmp = process.env.HUBRIS_DEV_TMP;
    const bootstrapToken = process.env.HUBRIS_DESKTOP_BOOTSTRAP_TOKEN;

    if (!devId || !devTmp || !bootstrapToken) {
      throw new Error("missing desktop dev environment configuration");
    }

    const frontendPort = await waitForFrontendPort(devId, devTmp);
    const origin = `http://localhost:${frontendPort}`;

    return {
      origin,
      url: buildBootstrapUrl(origin, bootstrapToken),
    };
  }

  const sessionToken = createDesktopToken();
  const bootstrapToken = createDesktopToken();
  const packaged = resolvePackagedPaths(process.resourcesPath);
  const runtime = spawnPackagedRuntime({
    runtimeExecutable: packaged.runtimeExecutable,
    frontendDistDir: packaged.frontendDistDir,
    dataDir: homeDataDir(),
    sessionToken,
    bootstrapToken,
  } satisfies PackagedRuntimeOptions);

  runtimeChild = runtime.child;
  const startup = await runtime.startup;
  const origin = `http://127.0.0.1:${startup.port}`;

  return {
    origin,
    url: buildBootstrapUrl(origin, bootstrapToken),
  };
}

/**
 * Install the session-level permission policy for the Hubris window.
 */
function configureSessionGuards() {
  const desktopSession = session.fromPartition(
    desktopSessionPartition(profileMode),
  );
  desktopSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  desktopSession.setPermissionCheckHandler(() => false);
}

/**
 * Enforce navigation and popup restrictions on the Hubris webview.
 */
function configureWebContentsGuards(
  webContents: WebContents,
  allowedOrigin: string,
) {
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const blockIfDisallowed = (event: ElectronEvent, url: string) => {
    if (!isAllowedNavigation(url, allowedOrigin)) {
      event.preventDefault();
    }
  };

  webContents.on("will-navigate", blockIfDisallowed);
  webContents.on("will-redirect", blockIfDisallowed);
}

/**
 * Create and load the main Hubris BrowserWindow.
 */
async function createMainWindow() {
  const preloadPath = path.resolve(__dirname, "preload.js");
  const { origin, url } = await resolveHubrisUrl();
  const window = new BrowserWindow(
    createHubrisWindowOptions(preloadPath, profileMode),
  );
  mainWindow = window;

  configureWebContentsGuards(window.webContents, origin);

  window.once("ready-to-show", () => {
    window.show();
  });
  window.on("closed", () => {
    mainWindow = null;
  });

  await window.loadURL(url);
}

app.on("before-quit", () => {
  stopRuntimeChild();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createMainWindow();
  }
});

configureDesktopProfilePaths(app, profileMode);

void app.whenReady().then(async () => {
  configureSessionGuards();
  await createMainWindow();
});
