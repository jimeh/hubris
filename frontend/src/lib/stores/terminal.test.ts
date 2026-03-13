// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSettings = vi.fn();
const mockSaveSettings = vi.fn();
const mockResolveFont = vi.fn();

vi.mock("@/lib/api", () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  saveSettings: (...args: unknown[]) => mockSaveSettings(...args),
}));

vi.mock("@/lib/terminal/fonts", async () => {
  const actual = await vi.importActual<typeof import("@/lib/terminal/fonts")>(
    "@/lib/terminal/fonts",
  );
  return {
    ...actual,
    resolveFont: (...args: unknown[]) => mockResolveFont(...args),
  };
});

async function getStores() {
  const settings = await import("./settings");
  const terminal = await import("./terminal");
  settings.resetSettingsStoreForTests();
  terminal.resetTerminalStoreForTests();
  return { settings, terminal };
}

async function flushMicrotasks(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await Promise.resolve();
  }
}

describe("Terminal store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mockGetSettings.mockReset();
    mockSaveSettings.mockReset();
    mockResolveFont.mockReset();
  });

  it("discards stale async font resolutions", async () => {
    let firstResolve: ((value: string) => void) | null = null;
    let secondResolve: ((value: string) => void) | null = null;

    mockResolveFont
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            firstResolve = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            secondResolve = resolve;
          }),
      );

    const { settings, terminal } = await getStores();
    settings.useSettingsStore.setState({
      settings: {
        appearance: {
          colorScheme: "auto",
          lightTheme: "hubris-light",
          darkTheme: "hubris-dark",
        },
        terminal: {
          fontSource: "bundled",
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

    await terminal.useTerminalStore.getState().init();

    settings.useSettingsStore.setState({
      settings: {
        ...settings.useSettingsStore.getState().settings,
        terminal: {
          fontSource: "system",
          systemFontFamily: "Fira Code",
          bundledFont: "jetbrainsmono-nf",
          fontSize: 15,
        },
      },
      hasServerState: true,
    });

    if (!secondResolve) {
      throw new Error("second font resolution was not registered");
    }
    const resolveSecond = secondResolve as (value: string) => void;
    resolveSecond("Fira Code");
    await flushMicrotasks();

    expect(terminal.useTerminalStore.getState().fontFamily).toBe("Fira Code");
    expect(terminal.useTerminalStore.getState().settings.fontSize).toBe(15);

    if (!firstResolve) {
      throw new Error("first font resolution was not registered");
    }
    const resolveFirst = firstResolve as (value: string) => void;
    resolveFirst("'JetBrainsMono NF', monospace");
    await flushMicrotasks();

    expect(terminal.useTerminalStore.getState().fontFamily).toBe("Fira Code");
  });
});
