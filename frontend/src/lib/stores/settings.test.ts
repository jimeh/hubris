// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FONT_FAMILY } from "@/lib/terminal/fonts";
import { useTerminalSettings } from "@/lib/stores/terminal";

const mockGetSettings = vi.fn();
const mockPatchSettings = vi.fn();
const mockResetApiStateForTests = vi.fn();
const mockShowSettingsInvalidFileToast = vi.fn();
const mockShowSettingsSaveFailedToast = vi.fn();

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

vi.mock("@/lib/stores/toasts", () => ({
  showSettingsInvalidFileToast: () => mockShowSettingsInvalidFileToast(),
  showSettingsSaveFailedToast: () => mockShowSettingsSaveFailedToast(),
}));

function emit(name: string, payload: unknown): void {
  for (const handler of handlers.get(name) ?? []) {
    handler(payload);
  }
}

type MatchMediaStub = {
  media: MediaQueryList;
};

function stubMatchMedia(
  prefersDark = false,
  options: { legacyOnly?: boolean } = {},
): MatchMediaStub {
  const media = {
    matches: prefersDark,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: options.legacyOnly ? undefined : vi.fn(),
    removeEventListener: options.legacyOnly ? undefined : vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => media),
  });

  return { media };
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

function createSettingsState(
  generation: string,
  overrides?: Partial<{
    appearance: Partial<{
      colorScheme: "auto" | "light" | "dark";
      lightTheme: string;
      darkTheme: string;
    }>;
    terminal: Partial<{
      fontSource: "default" | "system" | "bundled";
      systemFontFamily: string;
      bundledFont: string;
      fontSize: number;
    }>;
    worktree: Partial<{
      locationMode: "dataDir" | "repoLocalDotHubris";
    }>;
    status: typeof okStatus | typeof invalidStatus;
  }>,
) {
  return {
    settings: {
      appearance: {
        colorScheme: "light" as const,
        lightTheme: "hubris-light",
        darkTheme: "hubris-dark",
        ...(overrides?.appearance ?? {}),
      },
      terminal: {
        fontSource: "default" as const,
        systemFontFamily: "",
        bundledFont: "jetbrainsmono-nf",
        fontSize: 14,
        ...(overrides?.terminal ?? {}),
      },
      worktree: {
        locationMode: "dataDir" as const,
        ...(overrides?.worktree ?? {}),
      },
    },
    generation,
    status: overrides?.status ?? okStatus,
  };
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
    mockShowSettingsInvalidFileToast.mockReset();
    mockShowSettingsSaveFailedToast.mockReset();

    mockPatchSettings.mockResolvedValue(createSettingsState("2"));
  });

  it("removes the media listener and rebinds on reset", async () => {
    const { media } = stubMatchMedia(false);
    const store = await getStore();
    vi.mocked(media.addEventListener!).mockClear();
    vi.mocked(media.removeEventListener!).mockClear();

    store.initializeSettingsStore();
    expect(media.addEventListener).toHaveBeenCalledTimes(1);

    store.resetSettingsStoreForTests();
    expect(media.removeEventListener).toHaveBeenCalledTimes(1);

    store.initializeSettingsStore();
    expect(media.addEventListener).toHaveBeenCalledTimes(2);
  });

  it("removes legacy media listeners during reset", async () => {
    const { media } = stubMatchMedia(false, { legacyOnly: true });
    const store = await getStore();
    vi.mocked(media.addListener).mockClear();
    vi.mocked(media.removeListener).mockClear();

    store.initializeSettingsStore();
    expect(media.addListener).toHaveBeenCalledTimes(1);

    store.resetSettingsStoreForTests();
    expect(media.removeListener).toHaveBeenCalledTimes(1);

    store.initializeSettingsStore();
    expect(media.addListener).toHaveBeenCalledTimes(2);
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

  it("sends discrete control updates immediately with a leaf patch", async () => {
    const store = await getStore();
    store.initializeSettingsStore();

    act(() => {
      store.useSettingsStore.getState().updateAppearance({
        colorScheme: "dark",
      });
    });

    expect(
      store.useSettingsStore.getState().settings.appearance.colorScheme,
    ).toBe("dark");
    expect(mockPatchSettings).toHaveBeenCalledTimes(1);
    expect(mockPatchSettings).toHaveBeenCalledWith({
      appearance: { colorScheme: "dark" },
    });
  });

  it("debounces system font family typing and sends only the latest value", async () => {
    const store = await getStore();
    store.initializeSettingsStore();

    act(() => {
      store.useSettingsStore
        .getState()
        .updateTerminal(
          { systemFontFamily: "Jet" },
          { debounceKey: "terminal.systemFontFamily" },
        );
      store.useSettingsStore
        .getState()
        .updateTerminal(
          { systemFontFamily: "JetBrains Mono" },
          { debounceKey: "terminal.systemFontFamily" },
        );
    });

    expect(mockPatchSettings).not.toHaveBeenCalled();
    expect(
      store.useSettingsStore.getState().settings.terminal.systemFontFamily,
    ).toBe("JetBrains Mono");

    await vi.advanceTimersByTimeAsync(249);
    expect(mockPatchSettings).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockPatchSettings).toHaveBeenCalledTimes(1);
    expect(mockPatchSettings).toHaveBeenCalledWith({
      terminal: { systemFontFamily: "JetBrains Mono" },
    });
  });

  it("debounces typed font size and sends only the final value", async () => {
    const store = await getStore();
    store.initializeSettingsStore();

    act(() => {
      store.useSettingsStore
        .getState()
        .updateTerminal({ fontSize: 15 }, { debounceKey: "terminal.fontSize" });
      store.useSettingsStore
        .getState()
        .updateTerminal({ fontSize: 16 }, { debounceKey: "terminal.fontSize" });
    });

    expect(mockPatchSettings).not.toHaveBeenCalled();
    expect(store.useSettingsStore.getState().settings.terminal.fontSize).toBe(
      16,
    );

    await vi.advanceTimersByTimeAsync(250);
    expect(mockPatchSettings).toHaveBeenCalledTimes(1);
    expect(mockPatchSettings).toHaveBeenCalledWith({
      terminal: { fontSize: 16 },
    });
  });

  it("preserves unrelated section references for single-section updates", async () => {
    const store = await getStore();
    store.initializeSettingsStore();

    const initialSettings = store.useSettingsStore.getState().settings;

    act(() => {
      store.useSettingsStore.getState().updateAppearance({
        colorScheme: "dark",
      });
    });

    const afterAppearance = store.useSettingsStore.getState().settings;
    expect(afterAppearance.appearance).not.toBe(initialSettings.appearance);
    expect(afterAppearance.terminal).toBe(initialSettings.terminal);
    expect(afterAppearance.worktree).toBe(initialSettings.worktree);

    act(() => {
      store.useSettingsStore.getState().updateTerminal({
        fontSize: 16,
      });
    });

    const afterTerminal = store.useSettingsStore.getState().settings;
    expect(afterTerminal.appearance).toBe(afterAppearance.appearance);
    expect(afterTerminal.terminal).not.toBe(afterAppearance.terminal);
    expect(afterTerminal.worktree).toBe(afterAppearance.worktree);
  });

  it("does not rerender terminal settings consumers on appearance-only updates", async () => {
    const renderSpy = vi.fn();

    function TerminalConsumer() {
      const settings = useTerminalSettings((state) => state.settings);
      renderSpy(settings.fontSize);
      return createElement("div", null, settings.fontSize);
    }

    const store = await getStore();
    store.initializeSettingsStore();

    render(createElement(TerminalConsumer));
    expect(screen.getByText("14")).toBeInTheDocument();
    expect(renderSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      store.useSettingsStore.getState().updateAppearance({
        colorScheme: "dark",
      });
      await flushAsyncWork();
    });
    expect(renderSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      store.useSettingsStore.getState().updateTerminal({
        fontSize: 16,
      });
      await flushAsyncWork();
    });
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByText("16")).toBeInTheDocument();
  });

  it("ignores older settings_updated events", async () => {
    const store = await getStore();
    store.initializeSettingsStore();

    emit("snapshot", {
      settings: createSettingsState("10", {
        appearance: { colorScheme: "dark" },
      }).settings,
      settings_generation: "10",
      settings_status: okStatus,
    });

    emit("settings_updated", {
      ...createSettingsState("9", {
        appearance: { colorScheme: "light" },
        worktree: { locationMode: "repoLocalDotHubris" },
      }),
    });

    expect(
      store.useSettingsStore.getState().settings.appearance.colorScheme,
    ).toBe("dark");
    expect(
      store.useSettingsStore.getState().settings.worktree.locationMode,
    ).toBe("dataDir");
    expect(store.useSettingsStore.getState().generation).toBe("10");
  });

  it("ignores older PATCH responses when a newer generation already applied", async () => {
    const firstPatch = deferred<ReturnType<typeof createSettingsState>>();
    const secondPatch = deferred<ReturnType<typeof createSettingsState>>();
    mockPatchSettings
      .mockReturnValueOnce(firstPatch.promise)
      .mockReturnValueOnce(secondPatch.promise);

    const store = await getStore();
    store.initializeSettingsStore();

    act(() => {
      store.useSettingsStore.getState().updateAppearance({
        colorScheme: "dark",
      });
      store.useSettingsStore.getState().updateTerminal({
        fontSize: 16,
      });
    });

    secondPatch.resolve(
      createSettingsState("6", {
        terminal: { fontSize: 16 },
      }),
    );
    await flushAsyncWork();

    firstPatch.resolve(
      createSettingsState("5", {
        appearance: { colorScheme: "dark" },
      }),
    );
    await flushAsyncWork();

    expect(store.useSettingsStore.getState().generation).toBe("6");
    expect(store.useSettingsStore.getState().settings.terminal.fontSize).toBe(
      16,
    );
    expect(
      store.useSettingsStore.getState().settings.appearance.colorScheme,
    ).toBe("light");
  });

  it("ignores stale failures after a newer request exists", async () => {
    const firstPatch = deferred<ReturnType<typeof createSettingsState>>();
    mockPatchSettings
      .mockReturnValueOnce(firstPatch.promise)
      .mockResolvedValueOnce(
        createSettingsState("6", {
          terminal: { fontSize: 16 },
        }),
      );

    const store = await getStore();
    store.initializeSettingsStore();

    act(() => {
      store.useSettingsStore.getState().updateAppearance({
        colorScheme: "dark",
      });
      store.useSettingsStore.getState().updateTerminal({
        fontSize: 16,
      });
    });
    await flushAsyncWork();

    firstPatch.reject(new Error("500"));
    await flushAsyncWork();

    expect(mockShowSettingsSaveFailedToast).not.toHaveBeenCalled();
    expect(mockShowSettingsInvalidFileToast).not.toHaveBeenCalled();
    expect(mockGetSettings).not.toHaveBeenCalled();
    expect(store.useSettingsStore.getState().generation).toBe("6");
  });

  it("shows a failure toast and refetches canonical settings for the latest failed request", async () => {
    mockPatchSettings.mockRejectedValueOnce(new Error("500"));
    mockGetSettings.mockResolvedValue(createSettingsState("7"));

    const store = await getStore();
    store.initializeSettingsStore();

    act(() => {
      store.useSettingsStore.getState().updateAppearance({
        colorScheme: "dark",
      });
    });
    await flushAsyncWork();

    expect(mockShowSettingsSaveFailedToast).toHaveBeenCalledTimes(1);
    expect(mockGetSettings).toHaveBeenCalledTimes(1);
    expect(
      store.useSettingsStore.getState().settings.appearance.colorScheme,
    ).toBe("light");
    expect(store.useSettingsStore.getState().generation).toBe("7");
  });

  it("shows an invalid-file toast and refetches canonical settings on 409", async () => {
    mockPatchSettings.mockRejectedValueOnce({
      name: "ApiStatusError",
      status: 409,
      message: "409",
    });
    mockGetSettings.mockResolvedValue(
      createSettingsState("3", { status: invalidStatus }),
    );

    const store = await getStore();
    store.initializeSettingsStore();

    act(() => {
      store.useSettingsStore.getState().updateAppearance({
        colorScheme: "dark",
      });
    });
    await flushAsyncWork();

    expect(mockPatchSettings).toHaveBeenCalledTimes(1);
    expect(mockGetSettings).toHaveBeenCalledTimes(1);
    expect(mockShowSettingsInvalidFileToast).toHaveBeenCalledTimes(1);
    expect(mockShowSettingsSaveFailedToast).not.toHaveBeenCalled();
    expect(
      store.useSettingsStore.getState().settings.appearance.colorScheme,
    ).toBe("light");
    expect(store.useSettingsStore.getState().status).toEqual(invalidStatus);
  });

  it("applies equal-generation invalid-file status updates from the server", async () => {
    const store = await getStore();
    store.initializeSettingsStore();

    emit("snapshot", {
      settings: createSettingsState("10", {
        appearance: { colorScheme: "auto" },
      }).settings,
      settings_generation: "10",
      settings_status: okStatus,
    });

    emit("settings_updated", {
      ...createSettingsState("10", {
        appearance: { colorScheme: "auto" },
        status: invalidStatus,
      }),
    });

    expect(store.useSettingsStore.getState().generation).toBe("10");
    expect(store.useSettingsStore.getState().status).toEqual(invalidStatus);
  });

  it("keeps the resolved default font after failed-save refetches", async () => {
    mockPatchSettings.mockRejectedValueOnce(new Error("500"));
    mockGetSettings.mockResolvedValue(createSettingsState("8"));

    const store = await getStore();
    store.initializeSettingsStore();

    act(() => {
      store.useSettingsStore.getState().updateTerminal({
        fontSize: 16,
      });
    });
    await flushAsyncWork();

    expect(store.useSettingsStore.getState().fontFamily).toBe(
      DEFAULT_FONT_FAMILY,
    );
    expect(store.useSettingsStore.getState().settings.terminal.fontSize).toBe(
      14,
    );
  });
});
