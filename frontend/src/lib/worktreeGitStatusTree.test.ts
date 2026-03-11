import { describe, expect, it } from "vitest";
import { buildWorktreeGitStatusTree } from "./worktreeGitStatusTree";

describe("buildWorktreeGitStatusTree", () => {
  it("groups nested directories and keeps a stable sorted order", () => {
    const tree = buildWorktreeGitStatusTree([
      { path: "zeta.txt", change_type: "modified" },
      { path: "src/z-last.ts", change_type: "modified" },
      { path: "src/a-first.ts", change_type: "added" },
      { path: "src/nested/deep.ts", change_type: "deleted" },
      { path: "docs/guide.md", change_type: "untracked" },
    ]);

    expect(tree.map((node) => node.path)).toEqual(["docs", "src", "zeta.txt"]);

    expect(tree[1]).toMatchObject({
      kind: "directory",
      path: "src",
      children: [
        { kind: "directory", path: "src/nested" },
        { kind: "file", path: "src/a-first.ts" },
        { kind: "file", path: "src/z-last.ts" },
      ],
    });
  });
});
