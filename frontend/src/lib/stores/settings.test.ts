// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FONT_FAMILY } from "@/lib/terminal/fonts";

const mockGetSettings = vi.fn();
const mockPatchSettings = vi.fn();
const mockResetApiStateForTests = vi.fn();
const okStatus = {
  kind: "ok" as const,
  writesBlocked: false,
  message: null,
};
const invalidStatus = {
  kind: "invalidFile" as const,
  writesBlocked: true,
  message: "settings.toml is invalid",
};

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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
      status: okStatus,
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
      settings_status: okStatus,
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
      status: okStatus,
    });

    expect(
      store.useSettingsStore.getState().settings.appearance.colorScheme,
    ).toBe("dark");
    expect(
      store.useSettingsStore.getState().settings.worktree.locationMode,
    ).toBe("dataDir");
    expect(store.useSettingsStore.getState().generation).toBe("10");
  });

  it("keeps queued edits applied locally after PATCH failure", async () => {
    const firstPatch = deferred<{
      settings: {
        appearance: {
          colorScheme: string;
          lightTheme: string;
          darkTheme: string;
        };
        terminal: {
          fontSource: string;
          systemFontFamily: string;
          bundledFont: string;
          fontSize: number;
        };
        worktree: {
          locationMode: string;
        };
      };
      generation: string;
      status: typeof okStatus;
    }>();
    mockPatchSettings.mockReturnValueOnce(firstPatch.promise);
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
      status: okStatus,
    });

    const store = await getStore();
    store.initializeSettingsStore();

    store.useSettingsStore.getState().updateAppearance({
      colorScheme: "dark",
    });
    await vi.advanceTimersByTimeAsync(250);

    store.useSettingsStore.getState().updateTerminal({
      fontSize: 16,
    });

    firstPatch.reject(new Error("500"));
    await flushAsyncWork();

    expect(mockGetSettings).toHaveBeenCalledTimes(1);
    expect(
      store.useSettingsStore.getState().settings.appearance.colorScheme,
    ).toBe("dark");
    expect(store.useSettingsStore.getState().settings.terminal.fontSize).toBe(
      16,
    );
    expect(store.useSettingsStore.getState().generation).toBe("3");
    expect(store.useSettingsStore.getState().fontFamily).toBe(
      DEFAULT_FONT_FAMILY,
    );
  });

  it("retries queued edits after retryable PATCH failures", async () => {
    mockPatchSettings
      .mockRejectedValueOnce(new Error("500"))
      .mockResolvedValueOnce({
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
            fontSize: 16,
          },
          worktree: {
            locationMode: "dataDir",
          },
        },
        generation: "4",
        status: okStatus,
      });
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
      status: okStatus,
    });

    const store = await getStore();
    store.initializeSettingsStore();

    store.useSettingsStore.getState().updateTerminal({
      fontSize: 16,
    });

    await vi.advanceTimersByTimeAsync(250);
    await flushAsyncWork();

    expect(mockPatchSettings).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(mockPatchSettings).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushAsyncWork();

    expect(mockPatchSettings).toHaveBeenCalledTimes(2);
    expect(mockPatchSettings).toHaveBeenNthCalledWith(2, {
      terminal: { fontSize: 16 },
    });
    expect(store.useSettingsStore.getState().generation).toBe("4");
    expect(store.useSettingsStore.getState().settings.terminal.fontSize).toBe(
      16,
    );
  });

  it("does not auto-retry 409 conflicts but keeps edits queued", async () => {
    mockPatchSettings.mockRejectedValueOnce({
      name: "ApiStatusError",
      status: 409,
      message: "409",
    });
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
      status: invalidStatus,
    });

    const store = await getStore();
    store.initializeSettingsStore();

    store.useSettingsStore.getState().updateAppearance({
      colorScheme: "dark",
    });

    await vi.advanceTimersByTimeAsync(250);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockPatchSettings).toHaveBeenCalledTimes(1);
    expect(
      store.useSettingsStore.getState().settings.appearance.colorScheme,
    ).toBe("dark");
  });

  it("resumes queued flushes after settings recover on the same generation", async () => {
    mockPatchSettings.mockRejectedValueOnce({
      name: "ApiStatusError",
      status: 409,
      message: "409",
    });
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
      status: invalidStatus,
    });

    const store = await getStore();
    store.initializeSettingsStore();

    store.useSettingsStore.getState().updateAppearance({
      colorScheme: "dark",
    });

    await vi.advanceTimersByTimeAsync(250);
    await flushAsyncWork();

    mockPatchSettings.mockResolvedValueOnce({
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
      generation: "5",
      status: okStatus,
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
      generation: "3",
      status: okStatus,
    });

    await vi.advanceTimersByTimeAsync(0);
    await flushAsyncWork();

    expect(mockPatchSettings).toHaveBeenCalledTimes(2);
    expect(mockPatchSettings).toHaveBeenNthCalledWith(2, {
      appearance: { colorScheme: "dark" },
    });
    expect(store.useSettingsStore.getState().generation).toBe("5");
    expect(
      store.useSettingsStore.getState().settings.appearance.colorScheme,
    ).toBe("dark");
    expect(
      store.useSettingsStore.getState().settings.worktree.locationMode,
    ).toBe("repoLocalDotHubris");
  });

  it("updates invalid-file status from equal-generation server events", async () => {
    const store = await getStore();
    store.initializeSettingsStore();

    emit("snapshot", {
      settings: {
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
      },
      settings_generation: "10",
      settings_status: okStatus,
    });

    emit("settings_updated", {
      settings: {
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
      },
      generation: "10",
      status: invalidStatus,
    });

    expect(store.useSettingsStore.getState().generation).toBe("10");
    expect(store.useSettingsStore.getState().status).toEqual(invalidStatus);
  });
});
