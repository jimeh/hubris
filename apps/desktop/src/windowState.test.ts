import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

type MockDisplay = {
  workArea: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

function defaultDisplay(): MockDisplay {
  return {
    workArea: { x: 0, y: 0, width: 1440, height: 900 },
  };
}

const electronMocks = vi.hoisted(() => ({
  getAllDisplays: vi.fn<() => MockDisplay[]>(() => []),
  getDisplayMatching: vi.fn((): MockDisplay => defaultDisplay()),
}));

vi.mock("electron", () => ({
  screen: {
    getAllDisplays: electronMocks.getAllDisplays,
    getDisplayMatching: electronMocks.getDisplayMatching,
  },
}));

import {
  desktopWindowStatePath,
  loadDesktopWindowState,
  wireDesktopWindowStatePersistence,
} from "./windowState";

afterEach(() => {
  vi.restoreAllMocks();
  electronMocks.getAllDisplays.mockReset();
  electronMocks.getDisplayMatching.mockReset();
  electronMocks.getAllDisplays.mockReturnValue([]);
  electronMocks.getDisplayMatching.mockReturnValue(defaultDisplay());
});

describe("desktopWindowStatePath", () => {
  it("stores the window state in the desktop userData directory", () => {
    expect(desktopWindowStatePath("/config-root/Hubris")).toBe(
      "/config-root/Hubris/window-state.json",
    );
  });
});

describe("loadDesktopWindowState", () => {
  it("returns null when no persisted state exists", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      const error = new Error("missing state") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });

    expect(loadDesktopWindowState("/config-root/Hubris")).toBeNull();
  });

  it("clamps restored bounds into the active display work area", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        bounds: { x: 3000, y: -200, width: 2200, height: 1600 },
        isMaximized: true,
      }),
    );
    electronMocks.getAllDisplays.mockReturnValue([defaultDisplay()]);
    electronMocks.getDisplayMatching.mockReturnValue(defaultDisplay());

    expect(loadDesktopWindowState("/config-root/Hubris")).toEqual({
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      isMaximized: true,
    });
  });

  it("ignores malformed state files", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        bounds: { x: 10, y: 20, width: "bad", height: 700 },
        isMaximized: false,
      }),
    );

    expect(loadDesktopWindowState("/config-root/Hubris")).toBeNull();
  });
});

describe("wireDesktopWindowStatePersistence", () => {
  it("writes the latest normal bounds on close", () => {
    const handlers: Record<string, (() => void) | undefined> = {};
    const mkdirSync = vi
      .spyOn(fs, "mkdirSync")
      .mockImplementation(() => undefined as unknown as string);
    const writeFileSync = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation(() => undefined);
    const window = {
      getNormalBounds: vi.fn(() => ({
        x: 20,
        y: 30,
        width: 1200,
        height: 800,
      })),
      isMaximized: vi.fn(() => true),
      on: vi.fn((event: string, handler: () => void) => {
        handlers[event] = handler;
        return window;
      }),
    };

    wireDesktopWindowStatePersistence(window as never, "/config-root/Hubris");
    handlers.close?.();

    expect(window.on.mock.calls.map(([event]) => event)).toEqual([
      "move",
      "resize",
      "maximize",
      "unmaximize",
      "close",
    ]);
    expect(mkdirSync).toHaveBeenCalledWith("/config-root/Hubris", {
      recursive: true,
    });
    expect(writeFileSync).toHaveBeenCalledWith(
      "/config-root/Hubris/window-state.json",
      `${JSON.stringify(
        {
          bounds: { x: 20, y: 30, width: 1200, height: 800 },
          isMaximized: true,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  });
});
