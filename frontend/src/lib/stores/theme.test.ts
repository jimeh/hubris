// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSettings = vi.fn();
const mockSaveSettings = vi.fn();

vi.mock("@/lib/api", () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  saveSettings: (...args: unknown[]) => mockSaveSettings(...args),
}));

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

async function getStores() {
  const settings = await import("./settings");
  const theme = await import("./theme");
  settings.resetSettingsStoreForTests();
  theme.resetThemeStoreForTests();
  return { settings, theme };
}

describe("Theme store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
    stubMatchMedia(false);
    mockGetSettings.mockReset();
    mockSaveSettings.mockReset();
    mockSaveSettings.mockResolvedValue({
      appearance: {
        colorScheme: "auto",
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
    });
  });

  it("coerces legacy theme ids to hubris defaults and persists them", async () => {
    const { settings, theme } = await getStores();
    settings.useSettingsStore.setState({
      settings: {
        appearance: {
          colorScheme: "auto",
          lightTheme: "catppuccin-latte",
          darkTheme: "catppuccin-mocha",
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
      hasServerState: true,
    });

    await theme.useThemeStore.getState().init();
    await Promise.resolve();

    expect(theme.useThemeStore.getState().settings).toEqual({
      colorScheme: "auto",
      lightTheme: "hubris-light",
      darkTheme: "hubris-dark",
    });
    expect(theme.useThemeStore.getState().activeTheme?.id).toBe("hubris-light");
    expect(mockSaveSettings).toHaveBeenCalledWith({
      appearance: {
        lightTheme: "hubris-light",
        darkTheme: "hubris-dark",
      },
    });
  });

  it("applies canonical dark theme settings without extra saves", async () => {
    const { settings, theme } = await getStores();
    settings.useSettingsStore.setState({
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
      hasServerState: true,
    });

    await theme.useThemeStore.getState().init();
    await Promise.resolve();

    expect(theme.useThemeStore.getState().activeTheme?.id).toBe("hubris-dark");
    expect(theme.themeEntries().map((entry) => entry.id)).toEqual([
      "hubris-light",
      "hubris-dark",
    ]);
    expect(mockSaveSettings).not.toHaveBeenCalled();
  });
});
