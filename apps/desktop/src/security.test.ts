import { describe, expect, it } from "vitest";

import {
  HUBRIS_SESSION_PARTITION,
  createHubrisWindowOptions,
  isAllowedNavigation,
} from "./security";

describe("createHubrisWindowOptions", () => {
  it("uses hardened BrowserWindow defaults", () => {
    const options = createHubrisWindowOptions("/tmp/preload.js");

    expect(options.title).toBe("Hubris");
    expect(options.width).toBe(1440);
    expect(options.height).toBe(960);
    expect(options.minWidth).toBe(1024);
    expect(options.minHeight).toBe(720);
    expect(options.webPreferences).toMatchObject({
      preload: "/tmp/preload.js",
      partition: HUBRIS_SESSION_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    });
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
