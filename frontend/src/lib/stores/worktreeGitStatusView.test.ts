// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetWorktreeGitStatusViewStoreForTests,
  useWorktreeGitStatusViewStore,
} from "./worktreeGitStatusView";

const LS_VIEW_MODE_BY_WORKTREE =
  "hubris-worktree-git-status-view-mode-by-worktree";

function getStore() {
  resetWorktreeGitStatusViewStoreForTests();
  return useWorktreeGitStatusViewStore;
}

describe("Worktree git status view store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("defaults to tree mode when nothing is persisted", async () => {
    const store = await getStore();

    expect(store.getState().viewModeByWorktree).toEqual({});
  });

  it("loads persisted view modes per worktree", async () => {
    localStorage.setItem(
      LS_VIEW_MODE_BY_WORKTREE,
      JSON.stringify({
        w1: "list",
        w2: "tree",
      }),
    );

    const store = await getStore();

    expect(store.getState().viewModeByWorktree).toEqual({
      w1: "list",
      w2: "tree",
    });
  });

  it("ignores invalid persisted payloads", async () => {
    localStorage.setItem(
      LS_VIEW_MODE_BY_WORKTREE,
      JSON.stringify({
        w1: "grid",
        w2: "tree",
      }),
    );

    const store = await getStore();

    expect(store.getState().viewModeByWorktree).toEqual({
      w2: "tree",
    });
  });

  it("persists updates per worktree", async () => {
    const store = await getStore();

    store.getState().setViewMode("w1", "list");
    store.getState().setViewMode("w2", "tree");

    expect(store.getState().viewModeByWorktree).toEqual({
      w1: "list",
      w2: "tree",
    });
    expect(localStorage.getItem(LS_VIEW_MODE_BY_WORKTREE)).toBe(
      JSON.stringify({
        w1: "list",
        w2: "tree",
      }),
    );
  });
});
