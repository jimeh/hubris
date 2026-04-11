import { AlertTriangle, Trash2 } from "lucide-react";
import type { Worktree } from "@/lib/types";
import VscodeWorkbenchIndicator from "./VscodeWorkbenchIndicator";
import WorktreeIndicator from "./WorktreeIndicator";
import WorktreeRowContent from "./WorktreeRowContent";

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
      <WorktreeRowContent
        isSelected={isSelected}
        leadingSlot={<WorktreeIndicator worktreeId={worktree.id} />}
        trailingSlot={<VscodeWorkbenchIndicator worktreeId={worktree.id} />}
        contentSlot={
          <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <span className="min-w-0 flex-1 truncate">{worktree.name}</span>
            {worktree.missing_on_disk ? (
              <span className="inline-flex items-center text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
              </span>
            ) : null}
          </div>
        }
        actionSlot={
          <span className="pointer-events-none inline-flex size-6 items-center justify-center rounded-md">
            <Trash2 className="h-3.5 w-3.5" />
          </span>
        }
      />
    </div>
  );
}
