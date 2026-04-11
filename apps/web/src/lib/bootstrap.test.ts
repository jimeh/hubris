import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapApp, resetBootstrapForTests } from "./bootstrap";

const {
  calls,
  mockConnect,
  mockDisconnect,
  mockResetProjectStore,
  mockResetWorktreeStore,
  mockResetTabStore,
} = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    mockConnect: vi.fn(() => {
      calls.push("connect");
    }),
    mockDisconnect: vi.fn(() => {
      calls.push("disconnect");
    }),
    mockResetProjectStore: vi.fn(() => {
      calls.push("reset-projects");
    }),
    mockResetWorktreeStore: vi.fn(() => {
      calls.push("reset-worktrees");
    }),
    mockResetTabStore: vi.fn(() => {
      calls.push("reset-tabs");
    }),
  };
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

vi.mock("@/lib/stores/fileEditorTabs", () => ({
  initializeFileEditorStore: () => calls.push("file-editor-tabs"),
  resetFileEditorStoreForTests: () => calls.push("reset-file-editor-tabs"),
}));

vi.mock("@/lib/stores/gitDiffTabs", () => ({
  initializeGitDiffStore: () => calls.push("git-diff-tabs"),
  resetGitDiffStoreForTests: () => calls.push("reset-git-diff-tabs"),
}));

vi.mock("@/lib/stores/worktreeFileManager", () => ({
  initializeWorktreeFileManagerStore: () => calls.push("worktree-file-manager"),
  resetWorktreeFileManagerStoreForTests: () =>
    calls.push("reset-worktree-file-manager"),
}));

vi.mock("@/lib/stores/worktreeRightSidebar", () => ({
  initializeWorktreeRightSidebarStore: () =>
    calls.push("worktree-right-sidebar"),
  resetWorktreeRightSidebarStoreForTests: () =>
    calls.push("reset-worktree-right-sidebar"),
}));

vi.mock("@/lib/stores/vscode", () => ({
  initializeVscodeStore: () => calls.push("vscode"),
  resetVscodeStoreForTests: () => calls.push("reset-vscode"),
}));

vi.mock("@/lib/stores/settings", () => ({
  initializeSettingsStore: () => calls.push("settings"),
  resetSettingsStoreForTests: () => calls.push("reset-settings"),
}));

vi.mock("@/lib/stores/system", () => ({
  initializeSystemStore: () => calls.push("system"),
  resetSystemStoreForTests: () => calls.push("reset-system"),
}));

vi.mock("@/lib/events", () => ({
  getEventClient: () => ({
    on: vi.fn(() => vi.fn()),
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

  it("initializes stores before connecting the event stream", () => {
    resetBootstrapForTests();
    calls.length = 0;

    bootstrapApp();

    expect(calls).toEqual([
      "projects",
      "worktrees",
      "tabs",
      "file-editor-tabs",
      "git-diff-tabs",
      "worktree-file-manager",
      "worktree-right-sidebar",
      "vscode",
      "settings",
      "system",
      "connect",
    ]);
  });

  it("resets store initialization and disconnects events for repeated tests", () => {
    resetBootstrapForTests();

    expect(calls).toEqual([
      "reset-projects",
      "reset-worktrees",
      "reset-tabs",
      "reset-file-editor-tabs",
      "reset-git-diff-tabs",
      "reset-worktree-file-manager",
      "reset-worktree-right-sidebar",
      "reset-vscode",
      "reset-settings",
      "reset-system",
      "disconnect",
    ]);
  });
});
