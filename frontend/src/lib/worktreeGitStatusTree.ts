import type { WorktreeGitFileChange } from "@/lib/api";

export type WorktreeGitStatusTreeNode =
  | {
      kind: "directory";
      name: string;
      path: string;
      children: WorktreeGitStatusTreeNode[];
    }
  | {
      kind: "file";
      name: string;
      path: string;
      change: WorktreeGitFileChange;
    };

type MutableDirectoryNode = {
  kind: "directory";
  name: string;
  path: string;
  directories: Map<string, MutableDirectoryNode>;
  files: Array<WorktreeGitStatusTreeNode>;
};

function createDirectoryNode(name: string, path: string): MutableDirectoryNode {
  return {
    kind: "directory",
    name,
    path,
    directories: new Map(),
    files: [],
  };
}

function finalizeDirectory(
  node: MutableDirectoryNode,
): WorktreeGitStatusTreeNode[] {
  const directories = [...node.directories.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((child) => ({
      kind: "directory" as const,
      name: child.name,
      path: child.path,
      children: finalizeDirectory(child),
    }));
  const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
  return [...directories, ...files];
}

export function buildWorktreeGitStatusTree(
  changes: WorktreeGitFileChange[],
): WorktreeGitStatusTreeNode[] {
  const root = createDirectoryNode("", "");

  for (const change of changes) {
    const segments = change.path.split("/").filter(Boolean);
    if (segments.length === 0) {
      continue;
    }

    let current = root;
    const parentSegments = segments.slice(0, -1);
    for (const segment of parentSegments) {
      const nextPath = current.path ? `${current.path}/${segment}` : segment;
      let next = current.directories.get(segment);
      if (!next) {
        next = createDirectoryNode(segment, nextPath);
        current.directories.set(segment, next);
      }
      current = next;
    }

    const name = segments[segments.length - 1];
    current.files.push({
      kind: "file",
      name,
      path: change.path,
      change,
    });
  }

  return finalizeDirectory(root);
}
