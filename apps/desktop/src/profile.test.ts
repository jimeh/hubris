import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  configureDesktopProfilePaths,
  desktopAppDataName,
  desktopBrowserSessionPartition,
  desktopProfileMode,
  desktopSessionDataPath,
  desktopSessionPartition,
  desktopUserDataPath,
} from "./profile";

describe("desktopProfileMode", () => {
  it("uses a dev profile for unpackaged runs", () => {
    expect(desktopProfileMode(false)).toBe("dev");
  });

  it("uses a release profile for packaged runs", () => {
    expect(desktopProfileMode(true)).toBe("release");
  });
});

describe("desktopAppDataName", () => {
  it("uses Hubris for release builds", () => {
    expect(desktopAppDataName("release")).toBe("Hubris");
  });

  it("uses Hubris Dev for dev builds", () => {
    expect(desktopAppDataName("dev")).toBe("Hubris Dev");
  });
});

describe("desktopSessionPartition", () => {
  it("uses distinct persistent partitions", () => {
    expect(desktopSessionPartition("release")).toBe("persist:hubris-desktop");
    expect(desktopSessionPartition("dev")).toBe("persist:hubris-desktop-dev");
  });
});

describe("desktopBrowserSessionPartition", () => {
  it("uses separate persistent browser partitions", () => {
    expect(desktopBrowserSessionPartition("release")).toBe(
      "persist:hubris-desktop-browser",
    );
    expect(desktopBrowserSessionPartition("dev")).toBe(
      "persist:hubris-desktop-browser-dev",
    );
  });
});

describe("desktop path helpers", () => {
  it("uses native appData-style release paths", () => {
    expect(desktopUserDataPath("/config-root", "release")).toBe(
      "/config-root/Hubris",
    );
    expect(desktopSessionDataPath("/config-root", "release")).toBe(
      "/config-root/Hubris/sessionData",
    );
  });

  it("uses separate native appData-style dev paths", () => {
    expect(desktopUserDataPath("/config-root", "dev")).toBe(
      "/config-root/Hubris Dev",
    );
    expect(desktopSessionDataPath("/config-root", "dev")).toBe(
      "/config-root/Hubris/sessionData",
    );
  });

  it("shares the sessionData root between dev and release", () => {
    expect(desktopSessionDataPath("/config-root", "dev")).toBe(
      desktopSessionDataPath("/config-root", "release"),
    );
  });
});

describe("configureDesktopProfilePaths", () => {
  it("sets userData and sessionData before app startup work", () => {
    const setPath = vi.fn();
    const getPath = vi.fn().mockReturnValue("/config-root");
    const mkdirSync = vi
      .spyOn(fs, "mkdirSync")
      .mockImplementation(() => undefined as unknown as string);

    configureDesktopProfilePaths({ getPath, setPath }, "release");

    expect(getPath).toHaveBeenCalledWith("appData");
    expect(mkdirSync).toHaveBeenNthCalledWith(1, "/config-root/Hubris", {
      recursive: true,
    });
    expect(mkdirSync).toHaveBeenNthCalledWith(
      2,
      "/config-root/Hubris/sessionData",
      { recursive: true },
    );
    expect(setPath).toHaveBeenNthCalledWith(
      1,
      "userData",
      "/config-root/Hubris",
    );
    expect(setPath).toHaveBeenNthCalledWith(
      2,
      "sessionData",
      "/config-root/Hubris/sessionData",
    );

    mkdirSync.mockRestore();
  });
});
