// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB } from "@/lib/worktreeRightSidebar";

const LS_DESKTOP_OPEN = "hubris-worktree-right-sidebar-open";

async function getStore() {
  const mod = await import("./worktreeRightSidebar");
  mod.resetWorktreeRightSidebarStoreForTests();
  return mod.useWorktreeRightSidebarStore;
}

describe("Worktree right sidebar store", () => {
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

  it("openTab selects the requested tab and opens the sidebar", async () => {
    const store = await getStore();

    store.getState().closeForViewport(false);
    store.getState().openTab(WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB, false);

    expect(store.getState().desktopOpen).toBe(true);
    expect(store.getState().activeTab).toBe(WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB);
    expect(localStorage.getItem(LS_DESKTOP_OPEN)).toBe("true");
  });
});
