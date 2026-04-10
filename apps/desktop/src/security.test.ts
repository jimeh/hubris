import { describe, expect, it } from "vitest";

import { createHubrisWindowOptions, isAllowedNavigation } from "./security";
import { desktopSessionPartition } from "./profile";

describe("createHubrisWindowOptions", () => {
  it("uses hardened BrowserWindow defaults in release mode", () => {
    const options = createHubrisWindowOptions("/tmp/preload.js", "release");

    expect(options.title).toBe("Hubris");
    expect(options.width).toBe(1440);
    expect(options.height).toBe(960);
    expect(options.minWidth).toBe(1024);
    expect(options.minHeight).toBe(720);
    expect(options.webPreferences).toMatchObject({
      preload: "/tmp/preload.js",
      partition: desktopSessionPartition("release"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    });
  });

  it("uses a separate persistent partition in dev mode", () => {
    const options = createHubrisWindowOptions("/tmp/preload.js", "dev");

    expect(options.webPreferences?.partition).toBe(
      desktopSessionPartition("dev"),
    );
    expect(options.webPreferences?.partition).not.toBe(
      desktopSessionPartition("release"),
    );
  });
});

describe("isAllowedNavigation", () => {
  it("allows same-origin navigation", () => {
    expect(
      isAllowedNavigation(
        "http://127.0.0.1:3101/deep/link",
        "http://127.0.0.1:3101",
      ),
    ).toBe(true);
  });

  it("blocks cross-origin navigation", () => {
    expect(
      isAllowedNavigation("https://example.com", "http://127.0.0.1:3101"),
    ).toBe(false);
  });
});
