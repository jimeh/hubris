import type { WorktreeGitFileChange } from "@/lib/api";

export type GitChangeType = WorktreeGitFileChange["changeType"];

const GIT_CHANGE_TYPE_PRIORITY: Record<GitChangeType, number> = {
  conflict: 8,
  deleted: 7,
  modified: 6,
  renamed: 5,
  typechange: 4,
  added: 3,
  untracked: 2,
  copied: 1,
};

export function gitChangeTypeLabel(changeType: GitChangeType): string {
  switch (changeType) {
    case "added":
      return "A";
    case "copied":
      return "C";
    case "renamed":
      return "R";
    case "conflict":
      return "!";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "typechange":
      return "T";
    case "untracked":
      return "U";
  }
}

export function gitChangeTypeClass(changeType: GitChangeType): string {
  switch (changeType) {
    case "added":
      return "text-emerald-500";
    case "copied":
      return "text-sky-500";
    case "renamed":
      return "text-amber-500";
    case "conflict":
      return "text-rose-500";
    case "modified":
      return "text-amber-500";
    case "deleted":
      return "text-rose-500";
    case "typechange":
      return "text-fuchsia-500";
    case "untracked":
      return "text-emerald-500";
  }
}

export function mostSignificantGitChangeType(
  changeTypes: Iterable<GitChangeType>,
): GitChangeType | null {
  let winner: GitChangeType | null = null;

  for (const changeType of changeTypes) {
    if (
      winner === null ||
      GIT_CHANGE_TYPE_PRIORITY[changeType] > GIT_CHANGE_TYPE_PRIORITY[winner]
    ) {
      winner = changeType;
    }
  }

  return winner;
}
