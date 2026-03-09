import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const mockConnect = vi.fn(() => {
  calls.push("connect");
});
const mockDisconnect = vi.fn(() => {
  calls.push("disconnect");
});
const mockResetProjectStore = vi.fn(() => {
  calls.push("reset-projects");
});
const mockResetWorktreeStore = vi.fn(() => {
  calls.push("reset-worktrees");
});
const mockResetTabStore = vi.fn(() => {
  calls.push("reset-tabs");
});

vi.mock("@/lib/stores/projects", () => ({
  initializeProjectStore: () => calls.push("projects"),
  resetProjectStoreForTests: mockResetProjectStore,
}));

vi.mock("@/lib/stores/worktrees", () => ({
  initializeWorktreeStore: () => calls.push("worktrees"),
  resetWorktreeStoreForTests: mockResetWorktreeStore,
}));

vi.mock("@/lib/stores/tabs", () => ({
  initializeTabStore: () => calls.push("tabs"),
  resetTabStoreForTests: mockResetTabStore,
}));

vi.mock("@/lib/stores/theme", () => ({
  useThemeStore: {
    getState: () => ({
      init: () => calls.push("theme"),
    }),
  },
}));

vi.mock("@/lib/stores/terminal", () => ({
  useTerminalStore: {
    getState: () => ({
      init: () => calls.push("terminal"),
    }),
  },
}));

vi.mock("@/lib/stores/worktreeSettings", () => ({
  useWorktreeSettingsStore: {
    getState: () => ({
      init: () => calls.push("worktree-settings"),
    }),
  },
}));

vi.mock("@/lib/events", () => ({
  getEventClient: () => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
  }),
}));

describe("bootstrapApp", () => {
  beforeEach(() => {
    calls.length = 0;
    mockConnect.mockClear();
    mockDisconnect.mockClear();
    mockResetProjectStore.mockClear();
    mockResetWorktreeStore.mockClear();
    mockResetTabStore.mockClear();
  });

  it("initializes stores before connecting the event stream", async () => {
    const mod = await import("./bootstrap");
    mod.resetBootstrapForTests();
    calls.length = 0;

    mod.bootstrapApp();

    expect(calls).toEqual([
      "projects",
      "worktrees",
      "tabs",
      "theme",
      "terminal",
      "worktree-settings",
      "connect",
    ]);
  });

  it("resets store initialization and disconnects events for repeated tests", async () => {
    const mod = await import("./bootstrap");

    mod.resetBootstrapForTests();

    expect(calls).toEqual([
      "reset-projects",
      "reset-worktrees",
      "reset-tabs",
      "disconnect",
    ]);
  });
});
