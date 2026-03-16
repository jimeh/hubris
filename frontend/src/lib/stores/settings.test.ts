// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FONT_FAMILY } from "@/lib/terminal/fonts";

const mockGetSettings = vi.fn();
const mockPatchSettings = vi.fn();
const mockResetApiStateForTests = vi.fn();

type HandlerMap = Map<string, Set<(payload: unknown) => void>>;
const handlers: HandlerMap = new Map();

vi.mock("@/lib/api", () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  patchSettings: (...args: unknown[]) => mockPatchSettings(...args),
  resetApiStateForTests: () => mockResetApiStateForTests(),
}));

vi.mock("@/lib/events", () => ({
  getEventClient: () => ({
    on: (name: string, handler: (payload: unknown) => void) => {
      const bucket = handlers.get(name) ?? new Set();
      bucket.add(handler);
      handlers.set(name, bucket);
      return () => bucket.delete(handler);
    },
  }),
}));

function emit(name: string, payload: unknown): void {
  for (const handler of handlers.get(name) ?? []) {
    handler(payload);
  }
}

function stubMatchMedia(prefersDark = false) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: prefersDark,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

async function getStore() {
  const mod = await import("./settings");
  mod.resetSettingsStoreForTests();
  return mod;
}

describe("settings store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    handlers.clear();
    localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
    stubMatchMedia(false);
    mockGetSettings.mockReset();
    mockPatchSettings.mockReset();
    mockResetApiStateForTests.mockReset();
    mockPatchSettings.mockResolvedValue({
      settings: {
        appearance: {
          colorScheme: "dark",
          lightTheme: "hubris-light",
          darkTheme: "hubris-dark",
        },
        terminal: {
          fontSource: "default",
          systemFontFamily: "",
          bundledFont: "jetbrainsmono-nf",
          fontSize: 14,
        },
        worktree: {
          locationMode: "dataDir",
        },
      },
      generation: "2",
    });
  });

  it("hydrates from cached settings before SSE connects", async () => {
    localStorage.setItem(
      "hubris-settings",
      JSON.stringify({
        settings: {
          appearance: {
            colorScheme: "dark",
            lightTheme: "hubris-light",
            darkTheme: "hubris-dark",
          },
          terminal: {
            fontSource: "default",
            systemFontFamily: "",
            bundledFont: "jetbrainsmono-nf",
            fontSize: 14,
          },
          worktree: {
            locationMode: "repoLocalDotHubris",
          },
        },
        generation: "1",
      }),
    );

    const store = await getStore();
    store.initializeSettingsStore();

    expect(
      store.useSettingsStore.getState().settings.worktree.locationMode,
    ).toBe("repoLocalDotHubris");
    expect(store.useSettingsStore.getState().generation).toBe("1");
    expect(store.useSettingsStore.getState().activeTheme?.id).toBe(
      "hubris-dark",
    );
  });

  it("debounces minimal PATCH payloads", async () => {
    const store = await getStore();
    store.initializeSettingsStore();

    store.useSettingsStore.getState().updateAppearance({
      colorScheme: "dark",
    });
    store.useSettingsStore.getState().updateTerminal({
      fontSize: 15,
    });

    expect(mockPatchSettings).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();

    expect(mockPatchSettings).toHaveBeenCalledTimes(1);
    expect(mockPatchSettings).toHaveBeenCalledWith({
      appearance: { colorScheme: "dark" },
      terminal: { fontSize: 15 },
    });
  });

  it("ignores older settings_updated events", async () => {
    const store = await getStore();
    store.initializeSettingsStore();

    emit("snapshot", {
      settings: {
        appearance: {
          colorScheme: "dark",
          lightTheme: "hubris-light",
          darkTheme: "hubris-dark",
        },
        terminal: {
          fontSource: "default",
          systemFontFamily: "",
          bundledFont: "jetbrainsmono-nf",
          fontSize: 14,
        },
        worktree: {
          locationMode: "dataDir",
        },
      },
      settings_generation: "10",
    });

    emit("settings_updated", {
      settings: {
        appearance: {
          colorScheme: "light",
          lightTheme: "hubris-light",
          darkTheme: "hubris-dark",
        },
        terminal: {
          fontSource: "default",
          systemFontFamily: "",
          bundledFont: "jetbrainsmono-nf",
          fontSize: 14,
        },
        worktree: {
          locationMode: "repoLocalDotHubris",
        },
      },
      generation: "9",
    });

    expect(
      store.useSettingsStore.getState().settings.appearance.colorScheme,
    ).toBe("dark");
    expect(
      store.useSettingsStore.getState().settings.worktree.locationMode,
    ).toBe("dataDir");
    expect(store.useSettingsStore.getState().generation).toBe("10");
  });

  it("refetches canonical settings after PATCH failure", async () => {
    mockPatchSettings.mockRejectedValueOnce(new Error("500"));
    mockGetSettings.mockResolvedValue({
      settings: {
        appearance: {
          colorScheme: "light",
          lightTheme: "hubris-light",
          darkTheme: "hubris-dark",
        },
        terminal: {
          fontSource: "default",
          systemFontFamily: "",
          bundledFont: "jetbrainsmono-nf",
          fontSize: 14,
        },
        worktree: {
          locationMode: "dataDir",
        },
      },
      generation: "3",
    });

    const store = await getStore();
    store.initializeSettingsStore();

    store.useSettingsStore.getState().updateAppearance({
      colorScheme: "dark",
    });

    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mockGetSettings).toHaveBeenCalledTimes(1);
    expect(
      store.useSettingsStore.getState().settings.appearance.colorScheme,
    ).toBe("light");
    expect(store.useSettingsStore.getState().generation).toBe("3");
    expect(store.useSettingsStore.getState().fontFamily).toBe(
      DEFAULT_FONT_FAMILY,
    );
  });
});
