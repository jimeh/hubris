import { describe, expect, it } from "vitest";

import {
  allowedHubrisOrigins,
  classifyNavigationTarget,
  createHubrisWindowOptions,
  isAllowedNavigation,
} from "./security";
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
      nodeIntegrationInSubFrames: true,
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
    expect(options.webPreferences?.nodeIntegrationInSubFrames).toBe(true);
    expect(options.webPreferences?.partition).not.toBe(
      desktopSessionPartition("release"),
    );
  });
});

describe("isAllowedNavigation", () => {
  it("allows same-origin navigation", () => {
    expect(
      isAllowedNavigation(
        "https://vscode-cli.desktop.internal.hubris.build/deep/link",
        allowedHubrisOrigins(),
      ),
    ).toBe(true);
  });

  it("blocks cross-origin navigation", () => {
    expect(
      isAllowedNavigation("https://example.com", allowedHubrisOrigins()),
    ).toBe(false);
  });
});

describe("classifyNavigationTarget", () => {
  const allowedOrigins = allowedHubrisOrigins();

  it("classifies same-origin URLs as internal", () => {
    expect(
      classifyNavigationTarget(
        "https://desktop.internal.hubris.build/deep/link",
        allowedOrigins,
      ),
    ).toBe("internal");
    expect(
      classifyNavigationTarget(
        "https://code-server.desktop.internal.hubris.build/deep/link",
        allowedOrigins,
      ),
    ).toBe("internal");
  });

  it("classifies external http URLs as external", () => {
    expect(
      classifyNavigationTarget("http://example.com/docs", allowedOrigins),
    ).toBe("external");
  });

  it("classifies external https URLs as external", () => {
    expect(
      classifyNavigationTarget("https://example.com/docs", allowedOrigins),
    ).toBe("external");
  });

  it("rejects non-http schemes", () => {
    expect(
      classifyNavigationTarget("mailto:test@example.com", allowedOrigins),
    ).toBe("deny");
  });

  it("rejects malformed URLs", () => {
    expect(classifyNavigationTarget("not a url", allowedOrigins)).toBe("deny");
  });
});
