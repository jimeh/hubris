import { formatDiffStat } from "@/lib/diffLineStats";

type DiffLineStatsProps = {
  insertions: number | null | undefined;
  deletions: number | null | undefined;
};

export function DiffLineStats({ insertions, deletions }: DiffLineStatsProps) {
  const ins = insertions ?? 0;
  const del = deletions ?? 0;

  if (ins === 0 && del === 0) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums">
      {ins > 0 && (
        <span className="text-emerald-500">+{formatDiffStat(ins)}</span>
      )}
      {del > 0 && <span className="text-rose-500">-{formatDiffStat(del)}</span>}
    </span>
  );
}
