import { AlertTriangle, Trash2 } from "lucide-react";
import type { Worktree } from "$lib/types";

export default function WorktreeDragOverlay({
  worktree,
  isSelected,
  width,
}: {
  worktree: Worktree;
  isSelected: boolean;
  width: number | null;
}) {
  return (
    <div
      className="group/worktree-item relative opacity-60"
      style={width === null ? undefined : { width }}
    >
      <div
        className={[
          "flex min-h-8 cursor-default select-none items-center gap-2 rounded-md px-2 py-1 pr-8 text-sm transition-colors",
          isSelected
            ? "bg-sidebar-primary text-sidebar-primary-foreground"
            : "text-sidebar-foreground/80",
        ].join(" ")}
      >
        <span className="size-3.5 shrink-0" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 items-center text-left">
          <span className="truncate">{worktree.name}</span>
          {worktree.missing_on_disk ? (
            <span className="ml-2 inline-flex items-center text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
            </span>
          ) : null}
        </div>
      </div>
      <span className="pointer-events-none absolute top-1/2 right-1 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md opacity-0">
        <Trash2 className="h-3.5 w-3.5" />
      </span>
    </div>
  );
}
