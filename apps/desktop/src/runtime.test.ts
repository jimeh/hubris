import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildPackagedRuntimeEnv,
  parseDesktopStartupMessage,
  parseDevServerState,
  parseFrontendState,
  readDevServerState,
  runtimeBinaryName,
  waitForFrontendPort,
} from "./runtime";

describe("parseFrontendState", () => {
  it("extracts a port from the dev state file", () => {
    expect(parseFrontendState('{"pid":123,"port":3001}')).toBe(3001);
  });

  it("returns null for invalid state", () => {
    expect(parseFrontendState("not-json")).toBeNull();
  });
});

describe("parseDevServerState", () => {
  it("extracts pid and port from dev state files", () => {
    expect(parseDevServerState('{"pid":123,"port":3001}')).toEqual({
      pid: 123,
      port: 3001,
    });
  });
});

describe("readDevServerState", () => {
  it("reads a current dev-state file from disk", () => {
    const devTmp = fs.mkdtempSync(path.join(os.tmpdir(), "hubris-desktop-"));

    try {
      fs.writeFileSync(
        path.join(devTmp, "dev-dev-id.backend.json"),
        '{"pid":321,"port":4010}',
      );

      expect(readDevServerState("backend", "dev-id", devTmp)).toEqual({
        pid: 321,
        port: 4010,
      });
    } finally {
      fs.rmSync(devTmp, { recursive: true, force: true });
    }
  });
});

describe("runtimeBinaryName", () => {
  it("returns the unix binary name by default", () => {
    expect(runtimeBinaryName("darwin")).toBe("hubris-desktop-runtime");
  });

  it("returns the windows binary name for win32", () => {
    expect(runtimeBinaryName("win32")).toBe("hubris-desktop-runtime.exe");
  });
});

describe("parseDesktopStartupMessage", () => {
  it("accepts a valid startup contract line", () => {
    expect(
      parseDesktopStartupMessage('{"ready":true,"pid":99,"port":4012}'),
    ).toEqual({
      ready: true,
      pid: 99,
      port: 4012,
    });
  });

  it("ignores malformed output", () => {
    expect(parseDesktopStartupMessage("desktop server started")).toBeNull();
  });
});

describe("buildPackagedRuntimeEnv", () => {
  it("maps runtime options into environment variables", () => {
    const env = buildPackagedRuntimeEnv({
      runtimeExecutable: "/runtime",
      dataDir: "/data",
      sessionToken: "session-token",
      bootstrapToken: "bootstrap-token",
      host: "127.0.0.1",
      port: 0,
    });

    expect(env.HUBRIS_DATA_DIR).toBe("/data");
    expect(env.HUBRIS_DESKTOP_SESSION_TOKEN).toBe("session-token");
    expect(env.HUBRIS_DESKTOP_BOOTSTRAP_TOKEN).toBe("bootstrap-token");
    expect(env.HUBRIS_HOST).toBe("127.0.0.1");
    expect(env.HUBRIS_PORT).toBe("0");
  });

  it("defaults packaged runs to an ephemeral loopback port", () => {
    const env = buildPackagedRuntimeEnv({
      runtimeExecutable: "/runtime",
      dataDir: "/data",
      sessionToken: "session-token",
      bootstrapToken: "bootstrap-token",
    });

    expect(env.HUBRIS_HOST).toBe("127.0.0.1");
    expect(env.HUBRIS_PORT).toBe("0");
  });
});

describe("waitForFrontendPort", () => {
  it("reports the configured timeout in its error message", async () => {
    const devTmp = fs.mkdtempSync(path.join(os.tmpdir(), "hubris-desktop-"));

    try {
      await expect(waitForFrontendPort("dev-id", devTmp, 250)).rejects.toThrow(
        "frontend did not report a port within 0.25 seconds",
      );
    } finally {
      fs.rmSync(devTmp, { recursive: true, force: true });
    }
  });
});
