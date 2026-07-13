import { describe, expect, it } from "vitest";
import {
  buildWorktreeHistoryItems,
  nextWorktreeHistoryIndex,
} from "./worktreeHistorySwitcher";
import type { Worktree } from "@/lib/types";

function makeWorktree(id: string): Worktree {
  return {
    branch: id,
    id,
    isImported: false,
    isLocal: false,
    missingOnDisk: false,
    name: id,
    path: `/tmp/${id}`,
    position: 1,
    projectId: "p1",
    sourceRef: null,
    uiMode: "hubris",
  };
}

describe("worktree history switcher helpers", () => {
  it("builds an MRU list from the selected worktree and back stack", () => {
    expect(
      buildWorktreeHistoryItems({
        navigationBackIds: ["feature", "local"],
        selectedWorktreeId: "release",
        worktreesByProject: {
          p1: [
            makeWorktree("local"),
            makeWorktree("feature"),
            makeWorktree("release"),
          ],
        },
      }),
    ).toEqual(["release", "feature", "local"]);
  });

  it("prunes stale and duplicate history entries", () => {
    expect(
      buildWorktreeHistoryItems({
        navigationBackIds: ["feature", "missing", "feature", "local"],
        selectedWorktreeId: "feature",
        worktreesByProject: {
          p1: [makeWorktree("local"), makeWorktree("feature")],
        },
      }),
    ).toEqual(["feature", "local"]);
  });

  it("cycles backwards and forwards with wrapping", () => {
    expect(nextWorktreeHistoryIndex(0, 3, "back")).toBe(1);
    expect(nextWorktreeHistoryIndex(2, 3, "back")).toBe(0);
    expect(nextWorktreeHistoryIndex(0, 3, "forward")).toBe(2);
    expect(nextWorktreeHistoryIndex(1, 3, "forward")).toBe(0);
  });
});
