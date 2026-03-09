import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Worktree } from "@/lib/types";
import { AlertTriangle, Trash2 } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import WorktreeRowContent from "./WorktreeRowContent";

export default function WorktreeRow({
  worktree,
  isSelected,
  isSorting,
  onSelect,
  onRemove,
}: {
  worktree: Worktree;
  isSelected: boolean;
  isSorting: boolean;
  onSelect: () => void;
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
        contentSlot={
          <button
            className="flex min-w-0 flex-1 items-center text-left"
            onClick={onSelect}
            type="button"
          >
            <span className="truncate">{worktree.name}</span>
            {worktree.missing_on_disk ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="ml-2 inline-flex items-center text-destructive">
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
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={cn(
                  "pointer-events-none absolute top-1/2 right-1 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center text-sidebar-foreground/55 transition-[opacity,color]",
                  isSorting
                    ? "opacity-0"
                    : "opacity-0 group-hover/worktree-item:pointer-events-auto group-hover/worktree-item:opacity-70 hover:opacity-100 hover:text-sidebar-foreground",
                )}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove();
                }}
                type="button"
                aria-label="Delete worktree"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Delete worktree</TooltipContent>
          </Tooltip>
        }
      />
    </div>
  );
}
