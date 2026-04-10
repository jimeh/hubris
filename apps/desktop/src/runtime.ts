import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

const DESKTOP_BOOTSTRAP_PATH = "/_hubris/desktop/bootstrap";

export type DesktopStartupMessage = {
  ready: boolean;
  pid: number;
  port: number;
  error?: string;
};

export type PackagedRuntimeOptions = {
  runtimeExecutable: string;
  frontendDistDir: string;
  dataDir: string;
  sessionToken: string;
  bootstrapToken: string;
  host?: string;
  port?: number;
};

type RuntimeChildProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Parse a Vite dev-state file and return its frontend port.
 */
export function parseFrontendState(raw: string): number | null {
  try {
    const data = JSON.parse(raw) as { port?: unknown };
    return typeof data.port === "number" ? data.port : null;
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
    const parsed = JSON.parse(raw) as Partial<DesktopStartupMessage>;
    if (
      typeof parsed.ready !== "boolean" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.port !== "number"
    ) {
      return null;
    }

    return {
      ready: parsed.ready,
      pid: parsed.pid,
      port: parsed.port,
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Wait for the frontend dev server state file and return its port.
 */
export async function waitForFrontendPort(
  devId: string,
  devTmp: string,
  timeoutMs = 120_000,
): Promise<number> {
  const stateFile = path.join(devTmp, `dev-${devId}.frontend.json`);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const port = parseFrontendState(fs.readFileSync(stateFile, "utf-8"));
      if (port) {
        return port;
      }
    } catch {
      // The state file may not exist yet, or the writer may still be flushing.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("frontend did not report a port within 120 seconds");
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
    HUBRIS_FRONTEND_DIST_DIR: options.frontendDistDir,
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
        reject(new Error(startup.error ?? "desktop runtime failed to start"));
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
