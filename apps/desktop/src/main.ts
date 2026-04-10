import path from "node:path";
import {
  app,
  BrowserWindow,
  session,
  type Cookies,
  type Session,
  type WebContents,
  type Event as ElectronEvent,
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
import { createHubrisWindowOptions, isAllowedNavigation } from "./security";
import {
  configureDesktopProfilePaths,
  desktopProfileMode,
  desktopSessionPartition,
} from "./profile";
import { installWebSocketBridge } from "./wsBridge";

registerHubrisScheme();

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
  const desktopSession = session.fromPartition(
    desktopSessionPartition(profileMode),
  );
  const { targets, sessionToken, bootstrapToken } =
    await resolveProtocolTargets();
  const protocolContext = await registerHubrisProtocol(desktopSession, targets);
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
  const window = new BrowserWindow(
    createHubrisWindowOptions(preloadPath, profileMode),
  );
  mainWindow = window;

  configureWebContentsGuards(window.webContents, HUBRIS_ORIGIN);

  window.once("ready-to-show", () => {
    window.show();
  });
  window.on("closed", () => {
    mainWindow = null;
  });

  await window.loadURL(`${HUBRIS_ORIGIN}/`);
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
  const desktopSession = session.fromPartition(
    desktopSessionPartition(profileMode),
  );
  configureSessionGuards(desktopSession);
  await createMainWindow();
});

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
