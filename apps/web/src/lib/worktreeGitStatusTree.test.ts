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

  it("collapses single-child directory chains into one display node", () => {
    const tree = buildWorktreeGitStatusTree([
      { path: "src/nested/deeper/deep.ts", change_type: "modified" },
      { path: "src/peer.ts", change_type: "added" },
    ]);

    expect(tree).toMatchObject([
      {
        kind: "directory",
        path: "src",
        children: [
          {
            kind: "directory",
            name: "nested/deeper",
            path: "src/nested/deeper",
          },
          { kind: "file", path: "src/peer.ts" },
        ],
      },
    ]);
  });

  it("does not collapse directories with mixed files and subdirectories", () => {
    const tree = buildWorktreeGitStatusTree([
      { path: "src/nested/deeper/deep.ts", change_type: "modified" },
      { path: "src/nested/local.ts", change_type: "deleted" },
    ]);

    expect(tree).toMatchObject([
      {
        kind: "directory",
        name: "src/nested",
        path: "src/nested",
        children: [
          { kind: "directory", name: "deeper", path: "src/nested/deeper" },
          { kind: "file", path: "src/nested/local.ts" },
        ],
      },
    ]);
  });
});
