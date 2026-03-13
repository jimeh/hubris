// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandler, SseEventName } from "@/lib/events";

const mockGetSettings = vi.fn();
const mockSaveSettings = vi.fn();

vi.mock("@/lib/api", () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  saveSettings: (...args: unknown[]) => mockSaveSettings(...args),
}));

class MockEventClient {
  private handlers = new Map<SseEventName, Set<EventHandler<unknown>>>();

  on<K extends SseEventName>(
    event: K,
    handler: EventHandler<unknown>,
  ): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler<unknown>);
    return () =>
      this.handlers.get(event)?.delete(handler as EventHandler<unknown>);
  }

  emit(event: SseEventName, data: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(data);
    }
  }

  handlerCount(event: SseEventName): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

let mockEvents: MockEventClient;

vi.mock("@/lib/events", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/events")>("@/lib/events");
  return {
    ...actual,
    getEventClient: () => {
      if (!mockEvents) {
        mockEvents = new MockEventClient();
      }
      return mockEvents;
    },
  };
});

async function getStore() {
  const mod = await import("./settings");
  mod.resetSettingsStoreForTests();
  mod.initializeSettingsStore();
  return mod;
}

describe("Settings store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    localStorage.clear();
    mockGetSettings.mockReset();
    mockSaveSettings.mockReset();
    mockEvents = new MockEventClient();
  });

  it("hydrates from the SSE snapshot settings payload", async () => {
    const store = await getStore();

    mockEvents.emit("snapshot", {
      tabs: [],
      projects: [],
      worktrees: {},
      project_errors: {},
      settings: {
        appearance: {
          colorScheme: "dark",
          lightTheme: "hubris-light",
          darkTheme: "hubris-dark",
        },
        terminal: {
          fontSource: "bundled",
          systemFontFamily: "",
          bundledFont: "hack-nf",
          fontSize: 16,
        },
        worktree: {
          locationMode: "repoLocalDotHubris",
        },
      },
    });

    expect(store.useSettingsStore.getState().settings).toEqual({
      appearance: {
        colorScheme: "dark",
        lightTheme: "hubris-light",
        darkTheme: "hubris-dark",
      },
      terminal: {
        fontSource: "bundled",
        systemFontFamily: "",
        bundledFont: "hack-nf",
        fontSize: 16,
      },
      worktree: {
        locationMode: "repoLocalDotHubris",
      },
    });
  });

  it("applies live settings_updated events", async () => {
    const store = await getStore();

    mockEvents.emit("settings_updated", {
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
    });

    expect(
      store.useSettingsStore.getState().settings.appearance.colorScheme,
    ).toBe("light");
  });

  it("reverts deleted keys to defaults", async () => {
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

    const store = await getStore();
    store.useSettingsStore.setState({
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

    await store.useSettingsStore.getState().patchSettings({
      appearance: {
        colorScheme: null,
      },
    });

    expect(
      store.useSettingsStore.getState().settings.appearance.colorScheme,
    ).toBe("auto");
  });

  it("ignores self-echoed identical payloads", async () => {
    const store = await getStore();
    const changes: Array<string> = [];
    const unsubscribe = store.useSettingsStore.subscribe((state) => {
      changes.push(state.settings.appearance.colorScheme);
    });

    const settings = {
      appearance: {
        colorScheme: "dark" as const,
        lightTheme: "hubris-light",
        darkTheme: "hubris-dark",
      },
      terminal: {
        fontSource: "default" as const,
        systemFontFamily: "",
        bundledFont: "jetbrainsmono-nf",
        fontSize: 14,
      },
      worktree: {
        locationMode: "dataDir" as const,
      },
    };

    mockEvents.emit("settings_updated", settings);
    mockEvents.emit("settings_updated", settings);
    unsubscribe();

    expect(changes).toEqual(["dark"]);
  });

  it("resetSettingsStoreForTests unsubscribes SSE handlers", async () => {
    const store = await import("./settings");
    store.resetSettingsStoreForTests();
    store.initializeSettingsStore();

    expect(mockEvents.handlerCount("snapshot")).toBe(1);
    expect(mockEvents.handlerCount("settings_updated")).toBe(1);

    store.resetSettingsStoreForTests();

    expect(mockEvents.handlerCount("snapshot")).toBe(0);
    expect(mockEvents.handlerCount("settings_updated")).toBe(0);
  });
});
