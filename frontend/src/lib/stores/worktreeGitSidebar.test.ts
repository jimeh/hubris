// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const LS_DESKTOP_OPEN = "hubris-worktree-git-sidebar-open";

async function getStore() {
  const mod = await import("./worktreeGitSidebar");
  mod.resetWorktreeGitSidebarStoreForTests();
  return mod.useWorktreeGitSidebarStore;
}

describe("Worktree git sidebar store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    localStorage.clear();
  });

  it("defaults desktopOpen to true", async () => {
    const store = await getStore();
    expect(store.getState().desktopOpen).toBe(true);
  });

  it("loads persisted desktop state", async () => {
    localStorage.setItem(LS_DESKTOP_OPEN, "false");
    const store = await getStore();
    expect(store.getState().desktopOpen).toBe(false);
  });

  it("toggleDesktop updates localStorage", async () => {
    const store = await getStore();

    store.getState().toggleDesktop();

    expect(store.getState().desktopOpen).toBe(false);
    expect(localStorage.getItem(LS_DESKTOP_OPEN)).toBe("false");
  });
});
