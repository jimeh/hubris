import { describe, expect, it } from "vitest";

import {
  buildBootstrapUrl,
  buildPackagedRuntimeEnv,
  parseDesktopStartupMessage,
  parseFrontendState,
  runtimeBinaryName,
} from "./runtime";

describe("parseFrontendState", () => {
  it("extracts a port from the dev state file", () => {
    expect(parseFrontendState('{"pid":123,"port":3001}')).toBe(3001);
  });

  it("returns null for invalid state", () => {
    expect(parseFrontendState("not-json")).toBeNull();
  });
});

describe("buildBootstrapUrl", () => {
  it("builds the desktop bootstrap path with the token", () => {
    expect(buildBootstrapUrl("http://localhost:3001", "abc123")).toBe(
      "http://localhost:3001/_hubris/desktop/bootstrap?token=abc123",
    );
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
      frontendDistDir: "/dist",
      dataDir: "/data",
      sessionToken: "session-token",
      bootstrapToken: "bootstrap-token",
      host: "127.0.0.1",
      port: 0,
    });

    expect(env.HUBRIS_DATA_DIR).toBe("/data");
    expect(env.HUBRIS_FRONTEND_DIST_DIR).toBe("/dist");
    expect(env.HUBRIS_DESKTOP_SESSION_TOKEN).toBe("session-token");
    expect(env.HUBRIS_DESKTOP_BOOTSTRAP_TOKEN).toBe("bootstrap-token");
    expect(env.HUBRIS_HOST).toBe("127.0.0.1");
    expect(env.HUBRIS_PORT).toBe("0");
  });
});
