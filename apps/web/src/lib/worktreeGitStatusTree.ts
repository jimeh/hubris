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

function finalizeDirectoryNode(
  node: MutableDirectoryNode,
): Extract<WorktreeGitStatusTreeNode, { kind: "directory" }> {
  const directories = [...node.directories.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((child) => finalizeDirectoryNode(child));
  const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path));

  if (files.length === 0 && directories.length === 1) {
    const [onlyChild] = directories;
    return {
      kind: "directory",
      name: `${node.name}/${onlyChild.name}`,
      path: onlyChild.path,
      children: onlyChild.children,
    };
  }

  return {
    kind: "directory",
    name: node.name,
    path: node.path,
    children: [...directories, ...files],
  };
}

function finalizeRoot(node: MutableDirectoryNode): WorktreeGitStatusTreeNode[] {
  const directories = [...node.directories.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((child) => finalizeDirectoryNode(child));
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

  return finalizeRoot(root);
}
