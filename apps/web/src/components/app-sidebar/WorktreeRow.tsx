import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Worktree } from "@/lib/types";
import { AlertTriangle } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import VscodeWorkbenchIndicator from "./VscodeWorkbenchIndicator";
import WorktreeActionMenu from "./WorktreeActionMenu";
import WorktreeIndicator from "./WorktreeIndicator";
import WorktreeRowContent from "./WorktreeRowContent";

export default function WorktreeRow({
  worktree,
  isSelected,
  isSorting,
  onSelect,
  onRename,
  onRemove,
}: {
  worktree: Worktree;
  isSelected: boolean;
  isSorting: boolean;
  onSelect: () => void;
  onRename: () => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: worktree.id });

  const style = {
    transform: isDragging ? undefined : CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0 : undefined,
    pointerEvents: isDragging ? ("none" as const) : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group/worktree-item relative"
      data-worktree-drag-item="true"
      {...attributes}
      {...listeners}
    >
      <WorktreeRowContent
        isSelected={isSelected}
        isSorting={isSorting}
        leadingSlot={<WorktreeIndicator worktreeId={worktree.id} />}
        trailingSlot={<VscodeWorkbenchIndicator worktreeId={worktree.id} />}
        contentSlot={
          <button
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={onSelect}
            type="button"
          >
            <span className="min-w-0 flex-1 truncate">{worktree.name}</span>
            {worktree.missing_on_disk ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="inline-flex items-center text-destructive"
                    aria-label="Worktree missing on disk"
                  >
                    <AlertTriangle className="h-3.5 w-3.5" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" align="center">
                  This worktree was deleted outside Hubris. Remove it from
                  Hubris to clear this entry.
                </TooltipContent>
              </Tooltip>
            ) : null}
          </button>
        }
        actionSlot={
          <WorktreeActionMenu onRename={onRename} onRemove={onRemove} />
        }
      />
    </div>
  );
}
