// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSettings = vi.fn();
const mockSaveSettings = vi.fn();

vi.mock("$lib/api", () => ({
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

async function getStore() {
  const mod = await import("./theme");
  mod.resetThemeStoreForTests();
  return mod;
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
    mockSaveSettings.mockResolvedValue(undefined);
  });

  it("coerces legacy theme ids to hubris defaults and persists them", async () => {
    mockGetSettings.mockResolvedValue({
      appearance: {
        colorScheme: "auto",
        lightTheme: "catppuccin-latte",
        darkTheme: "catppuccin-mocha",
      },
    });

    const store = await getStore();
    await store.useThemeStore.getState().init();

    expect(store.useThemeStore.getState().settings).toEqual({
      colorScheme: "auto",
      lightTheme: "hubris-light",
      darkTheme: "hubris-dark",
    });
    expect(store.useThemeStore.getState().activeTheme?.id).toBe("hubris-light");
    expect(mockSaveSettings).toHaveBeenCalledWith({
      appearance: {
        colorScheme: "auto",
        lightTheme: "hubris-light",
        darkTheme: "hubris-dark",
      },
    });
  });

  it("falls back to built-ins only and normalizes cached unknown ids", async () => {
    mockGetSettings.mockRejectedValue(new Error("offline"));
    localStorage.setItem(
      "hubris-appearance",
      JSON.stringify({
        colorScheme: "dark",
        lightTheme: "custom-light",
        darkTheme: "custom-dark",
      }),
    );

    const store = await getStore();
    await store.useThemeStore.getState().init();

    expect(store.useThemeStore.getState().settings).toEqual({
      colorScheme: "dark",
      lightTheme: "hubris-light",
      darkTheme: "hubris-dark",
    });
    expect(store.themeEntries().map((theme) => theme.id)).toEqual([
      "hubris-light",
      "hubris-dark",
    ]);
    expect(store.useThemeStore.getState().activeTheme?.id).toBe("hubris-dark");
    expect(mockSaveSettings).not.toHaveBeenCalled();
  });
});
