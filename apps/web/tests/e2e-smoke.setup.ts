import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Global setup for the real-server e2e smoke lane.
 *
 * Boots the actual `hubris-server` binary (debug build with the
 * `embed-frontend` feature, so it serves `apps/web/dist` itself) on an
 * ephemeral port with a fully isolated environment:
 *
 * - `HUBRIS_DATA_DIR` points at a fresh temp dir (state DB, settings,
 *   instance lock all live there).
 * - `HOME`/XDG dirs point at a temp home so the user's real git config,
 *   shell rc files, and settings never leak in.
 * - `HUBRIS_PORT=0` binds an ephemeral port; the debug server writes the
 *   chosen port to the `dev-<id>.backend.json` state file when
 *   `HUBRIS_DEV_ID`/`HUBRIS_DEV_TMP` are set, which we poll.
 *
 * A throwaway git repo fixture (one commit on `main` plus one untracked
 * file) is created for the spec to register as a project.
 *
 * Connection info is handed to the spec via environment variables:
 * `HUBRIS_E2E_BASE_URL`, `HUBRIS_E2E_FIXTURE_REPO`,
 * `HUBRIS_E2E_SERVER_LOG`.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;
const FIXTURE_REPO_NAME = "hubris-e2e-fixture";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveServerBinary(): string {
  const fromEnv = process.env.HUBRIS_E2E_SERVER_BIN;
  if (fromEnv) {
    return fromEnv;
  }

  const targetDir =
    process.env.CARGO_TARGET_DIR ?? path.join(REPO_ROOT, "target");
  return path.join(targetDir, "debug", "hubris-server");
}

function runGit(repoPath: string, homeDir: string, args: string[]): void {
  const result = spawnSync(
    "git",
    [
      "-C",
      repoPath,
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.email=e2e@hubris.test",
      "-c",
      "user.name=Hubris E2E",
      ...args,
    ],
    {
      env: {
        ...process.env,
        HOME: homeDir,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
      stdio: "pipe",
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
}

function createFixtureRepo(tempRoot: string, homeDir: string): string {
  const repoPath = path.join(tempRoot, FIXTURE_REPO_NAME);
  fs.mkdirSync(repoPath, { recursive: true });

  runGit(repoPath, homeDir, ["init", "-q"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# hubris e2e fixture\n");
  runGit(repoPath, homeDir, ["add", "README.md"]);
  runGit(repoPath, homeDir, ["commit", "-q", "-m", "init"]);
  runGit(repoPath, homeDir, ["branch", "-M", "main"]);

  // Left uncommitted on purpose: the spec asserts this file shows up in
  // the git status ("Changes") panel, proving real git status flows
  // from the backend into the UI.
  fs.writeFileSync(path.join(repoPath, "e2e-note.txt"), "untracked note\n");

  return repoPath;
}

function tailLog(logFile: string, lines = 60): string {
  try {
    const content = fs.readFileSync(logFile, "utf8");
    return content.split("\n").slice(-lines).join("\n");
  } catch {
    return "(no server log captured)";
  }
}

type SpawnedServer = {
  child: ReturnType<typeof spawn>;
  exited: Promise<number | null>;
  exitCode: () => number | null;
};

function spawnServer(
  serverBin: string,
  env: NodeJS.ProcessEnv,
  logFile: string,
): SpawnedServer {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(serverBin, [], {
    env,
    stdio: ["ignore", logFd, logFd],
  });
  fs.closeSync(logFd);

  let exitCode: number | null = null;
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      exitCode = code;
      resolve(code);
    });
  });

  return { child, exited, exitCode: () => exitCode };
}

async function waitForPort(
  stateFile: string,
  server: SpawnedServer,
  logFile: string,
): Promise<number> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode() !== null) {
      throw new Error(
        `hubris-server exited early with code ${server.exitCode()}.\n` +
          `--- server log tail ---\n${tailLog(logFile)}`,
      );
    }

    try {
      const raw = fs.readFileSync(stateFile, "utf8");
      const parsed = JSON.parse(raw) as { port?: number };
      if (typeof parsed.port === "number" && parsed.port > 0) {
        return parsed.port;
      }
    } catch {
      // State file not written yet; keep polling.
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for ${stateFile}. The harness needs a debug build ` +
      `of hubris-server (dev mode writes the port state file).\n` +
      `--- server log tail ---\n${tailLog(logFile)}`,
  );
}

async function waitForHttpReady(
  baseUrl: string,
  server: SpawnedServer,
  logFile: string,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode() !== null) {
      throw new Error(
        `hubris-server exited early with code ${server.exitCode()}.\n` +
          `--- server log tail ---\n${tailLog(logFile)}`,
      );
    }

    try {
      const res = await fetch(`${baseUrl}/api/projects`);
      if (res.ok) {
        return;
      }
    } catch {
      // Server not accepting connections yet; keep polling.
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for ${baseUrl}/api/projects to become ready.\n` +
      `--- server log tail ---\n${tailLog(logFile)}`,
  );
}

async function stopServer(server: SpawnedServer): Promise<void> {
  if (server.exitCode() !== null) {
    return;
  }

  server.child.kill("SIGTERM");
  const result = await Promise.race([
    server.exited,
    sleep(10_000).then(() => "timeout" as const),
  ]);
  if (result === "timeout") {
    server.child.kill("SIGKILL");
    await server.exited;
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const serverBin = resolveServerBinary();
  if (!fs.existsSync(serverBin)) {
    throw new Error(
      `hubris-server binary not found at ${serverBin}. ` +
        `Run "mise run test:e2e:real" (or "cargo build --bin hubris-server ` +
        `--features embed-frontend") first.`,
    );
  }

  const webDistIndex = path.join(REPO_ROOT, "apps/web/dist/index.html");
  if (!fs.existsSync(webDistIndex)) {
    throw new Error(
      `Built frontend not found at ${webDistIndex}. ` +
        `Run "bun run --filter hubris-web build" first (the debug ` +
        `embed-frontend server reads apps/web/dist from disk at runtime).`,
    );
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hubris-e2e-"));
  const dataDir = path.join(tempRoot, "data");
  const homeDir = path.join(tempRoot, "home");
  const devTmp = path.join(tempRoot, "dev-tmp");
  for (const dir of [dataDir, homeDir, devTmp]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const fixtureRepo = createFixtureRepo(tempRoot, homeDir);
  const logFile = path.join(tempRoot, "hubris-server.log");
  const devId = "e2e";
  const stateFile = path.join(devTmp, `dev-${devId}.backend.json`);
  const shell = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, ".config"),
    XDG_DATA_HOME: path.join(homeDir, ".local/share"),
    XDG_CACHE_HOME: path.join(homeDir, ".cache"),
    HUBRIS_DATA_DIR: dataDir,
    HUBRIS_HOST: "127.0.0.1",
    HUBRIS_PORT: "0",
    HUBRIS_DEV_ID: devId,
    HUBRIS_DEV_TMP: devTmp,
    SHELL: shell,
    RUST_LOG: process.env.RUST_LOG ?? "hubris_server=debug",
  };
  // Make sure socket activation and desktop auth never kick in.
  delete env.LISTEN_FDS;
  delete env.LISTEN_PID;
  delete env.LISTEN_FDNAMES;
  delete env.HUBRIS_DESKTOP_SESSION_TOKEN;

  const server = spawnServer(serverBin, env, logFile);

  try {
    const port = await waitForPort(stateFile, server, logFile);
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHttpReady(baseUrl, server, logFile);

    process.env.HUBRIS_E2E_BASE_URL = baseUrl;
    process.env.HUBRIS_E2E_FIXTURE_REPO = fixtureRepo;
    process.env.HUBRIS_E2E_SERVER_LOG = logFile;
  } catch (error) {
    await stopServer(server);
    throw error;
  }

  return async () => {
    await stopServer(server);
    if (process.env.HUBRIS_E2E_KEEP_TMP !== "1") {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  };
}
