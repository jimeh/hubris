import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

const DESKTOP_BOOTSTRAP_PATH = "/_hubris/desktop/bootstrap";

export type DesktopStartupConflict = {
  holderPid: number;
  holderKind: "server" | "desktop_runtime";
  listenUrl?: string;
};

export type DesktopStartupMessage = {
  ready: boolean;
  pid: number;
  port: number;
  error?: string;
  conflict?: DesktopStartupConflict;
};

export type DevServerState = {
  pid: number;
  port: number;
};

export type DevServerKind = "backend" | "frontend";

export type PackagedRuntimeOptions = {
  runtimeExecutable: string;
  dataDir: string;
  sessionToken: string;
  bootstrapToken: string;
  host?: string;
  port?: number;
};

type RuntimeChildProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Error returned when the packaged runtime fails before becoming ready.
 */
export class DesktopRuntimeStartupError extends Error {
  readonly conflict?: DesktopStartupConflict;

  constructor(message: string, options?: { conflict?: DesktopStartupConflict }) {
    super(message);
    this.name = "DesktopRuntimeStartupError";
    this.conflict = options?.conflict;
  }
}

/**
 * Parse a Vite dev-state file and return its frontend port.
 */
export function parseFrontendState(raw: string): number | null {
  return parseDevServerState(raw)?.port ?? null;
}

/**
 * Parse a dev state file emitted by the backend or frontend.
 */
export function parseDevServerState(raw: string): DevServerState | null {
  try {
    const data = JSON.parse(raw) as Partial<DevServerState>;
    if (typeof data.pid !== "number" || typeof data.port !== "number") {
      return null;
    }

    return {
      pid: data.pid,
      port: data.port,
    };
  } catch {
    return null;
  }
}

/**
 * Parse a desktop runtime startup message emitted on stdout.
 */
export function parseDesktopStartupMessage(
  raw: string,
): DesktopStartupMessage | null {
  try {
    const parsed = JSON.parse(raw) as {
      ready?: unknown;
      pid?: unknown;
      port?: unknown;
      error?: unknown;
      conflict?: {
        holder_pid?: unknown;
        holder_kind?: unknown;
        listen_url?: unknown;
      };
    };
    if (
      typeof parsed.ready !== "boolean" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.port !== "number"
    ) {
      return null;
    }
    const conflict = parseDesktopStartupConflict(parsed.conflict);

    return {
      ready: parsed.ready,
      pid: parsed.pid,
      port: parsed.port,
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
      ...(conflict ? { conflict } : {}),
    };
  } catch {
    return null;
  }
}

function parseDesktopStartupConflict(
  conflict: {
    holder_pid?: unknown;
    holder_kind?: unknown;
    listen_url?: unknown;
  } | undefined,
): DesktopStartupConflict | null {
  if (!conflict) {
    return null;
  }
  if (
    typeof conflict.holder_pid !== "number" ||
    (conflict.holder_kind !== "server" &&
      conflict.holder_kind !== "desktop_runtime")
  ) {
    return null;
  }

  return {
    holderPid: conflict.holder_pid,
    holderKind: conflict.holder_kind,
    ...(typeof conflict.listen_url === "string"
      ? { listenUrl: conflict.listen_url }
      : {}),
  };
}

/**
 * Wait for the frontend dev server state file and return its port.
 */
export async function waitForFrontendPort(
  devId: string,
  devTmp: string,
  timeoutMs = 120_000,
): Promise<number> {
  const state = await waitForDevServerState(
    "frontend",
    devId,
    devTmp,
    timeoutMs,
  );
  return state.port;
}

/**
 * Wait for the backend dev server state file and return its port.
 */
export async function waitForBackendPort(
  devId: string,
  devTmp: string,
  timeoutMs = 120_000,
): Promise<number> {
  const state = await waitForDevServerState(
    "backend",
    devId,
    devTmp,
    timeoutMs,
  );
  return state.port;
}

async function waitForDevServerState(
  kind: DevServerKind,
  devId: string,
  devTmp: string,
  timeoutMs: number,
): Promise<DevServerState> {
  const stateFile = devServerStateFile(kind, devId, devTmp);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const state = readDevServerState(kind, devId, devTmp);
    if (state) {
      return state;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `${kind} did not report a port within ${timeoutMs / 1000} seconds`,
  );
}

/**
 * Return the dev-state file path for a given dev server kind.
 */
export function devServerStateFile(
  kind: DevServerKind,
  devId: string,
  devTmp: string,
): string {
  return path.join(devTmp, `dev-${devId}.${kind}.json`);
}

/**
 * Read and parse the current dev-state file for a backend or frontend server.
 */
export function readDevServerState(
  kind: DevServerKind,
  devId: string,
  devTmp: string,
): DevServerState | null {
  try {
    return parseDevServerState(
      fs.readFileSync(devServerStateFile(kind, devId, devTmp), "utf-8"),
    );
  } catch {
    // The state file may not exist yet, or the writer may still be flushing.
    return null;
  }
}

/**
 * Build the desktop bootstrap URL for a given origin and token.
 */
export function buildBootstrapUrl(origin: string, token: string): string {
  const url = new URL(DESKTOP_BOOTSTRAP_PATH, `${origin}/`);
  url.searchParams.set("token", token);
  return url.toString();
}

/**
 * Create a random desktop auth token.
 */
export function createDesktopToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Return the platform-specific desktop runtime binary name.
 */
export function runtimeBinaryName(platform = process.platform): string {
  return platform === "win32"
    ? "hubris-desktop-runtime.exe"
    : "hubris-desktop-runtime";
}

/**
 * Resolve packaged resource paths for the runtime binary and web dist.
 */
export function resolvePackagedPaths(
  resourcesPath: string,
  platform = process.platform,
) {
  const runtimeBinary = runtimeBinaryName(platform);

  return {
    frontendDistDir: path.join(resourcesPath, "dist"),
    runtimeExecutable: path.join(resourcesPath, runtimeBinary),
  };
}

/**
 * Build the environment passed to the packaged Rust runtime.
 */
export function buildPackagedRuntimeEnv(
  options: PackagedRuntimeOptions,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HUBRIS_DATA_DIR: options.dataDir,
    HUBRIS_DESKTOP_SESSION_TOKEN: options.sessionToken,
    HUBRIS_DESKTOP_BOOTSTRAP_TOKEN: options.bootstrapToken,
    HUBRIS_HOST: options.host ?? "127.0.0.1",
    HUBRIS_PORT: String(options.port ?? 0),
  };
}

/**
 * Wait until the packaged Rust runtime reports readiness on stdout.
 */
export function waitForRuntimeStartup(
  child: RuntimeChildProcess,
  timeoutMs = 30_000,
): Promise<DesktopStartupMessage> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      lines.close();
      reject(new Error("desktop runtime did not become ready in time"));
    }, timeoutMs);

    const fail = (error: Error) => {
      clearTimeout(timer);
      lines.close();
      reject(error);
    };

    child.once("error", fail);
    child.once("exit", (code, signal) => {
      fail(
        new Error(
          `desktop runtime exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });

    lines.on("line", (line) => {
      const startup = parseDesktopStartupMessage(line);
      if (!startup) {
        return;
      }

      clearTimeout(timer);
      lines.close();

      if (!startup.ready) {
        reject(
          new DesktopRuntimeStartupError(
            startup.error ?? "desktop runtime failed to start",
            { conflict: startup.conflict },
          ),
        );
        return;
      }

      resolve(startup);
    });
  });
}

/**
 * Spawn the packaged Rust runtime and start waiting for readiness.
 */
export function spawnPackagedRuntime(options: PackagedRuntimeOptions): {
  child: RuntimeChildProcess;
  startup: Promise<DesktopStartupMessage>;
} {
  const child = spawn(options.runtimeExecutable, {
    env: buildPackagedRuntimeEnv(options),
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  return {
    child,
    startup: waitForRuntimeStartup(child),
  };
}
