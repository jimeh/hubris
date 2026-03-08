import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const mockConnect = vi.fn(() => {
  calls.push("connect");
});

vi.mock("$lib/stores/projects", () => ({
  initializeProjectStore: () => calls.push("projects"),
}));

vi.mock("$lib/stores/worktrees", () => ({
  initializeWorktreeStore: () => calls.push("worktrees"),
}));

vi.mock("$lib/stores/tabs", () => ({
  initializeTabStore: () => calls.push("tabs"),
}));

vi.mock("$lib/stores/theme", () => ({
  useThemeStore: {
    getState: () => ({
      init: () => calls.push("theme"),
    }),
  },
}));

vi.mock("$lib/stores/terminal", () => ({
  useTerminalStore: {
    getState: () => ({
      init: () => calls.push("terminal"),
    }),
  },
}));

vi.mock("$lib/stores/worktreeSettings", () => ({
  useWorktreeSettingsStore: {
    getState: () => ({
      init: () => calls.push("worktree-settings"),
    }),
  },
}));

vi.mock("$lib/events", () => ({
  getEventClient: () => ({
    connect: mockConnect,
  }),
}));

describe("bootstrapApp", () => {
  beforeEach(() => {
    calls.length = 0;
    mockConnect.mockClear();
  });

  it("initializes stores before connecting the event stream", async () => {
    const mod = await import("./bootstrap");
    mod.resetBootstrapForTests();

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
});
