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

vi.mock("@/lib/stores/worktreeFileManager", () => ({
  initializeWorktreeFileManagerStore: () => calls.push("worktree-file-manager"),
  resetWorktreeFileManagerStoreForTests: () =>
    calls.push("reset-worktree-file-manager"),
}));

vi.mock("@/lib/stores/settings", () => ({
  initializeSettingsStore: () => calls.push("settings"),
  resetSettingsStoreForTests: () => calls.push("reset-settings"),
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
      "worktree-file-manager",
      "settings",
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
      "reset-worktree-file-manager",
      "reset-settings",
      "disconnect",
    ]);
  });
});
