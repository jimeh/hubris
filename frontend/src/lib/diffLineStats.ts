import type { WorktreeGitFileChange } from "@/lib/api";

const diffStatFormatter = new Intl.NumberFormat("en-US");

export function formatDiffStat(value: number): string {
  return diffStatFormatter.format(value);
}

export function computeAggregateStats(changes: WorktreeGitFileChange[]): {
  insertions: number;
  deletions: number;
} {
  let insertions = 0;
  let deletions = 0;
  for (const change of changes) {
    insertions += change.insertions ?? 0;
    deletions += change.deletions ?? 0;
  }
  return { insertions, deletions };
}
