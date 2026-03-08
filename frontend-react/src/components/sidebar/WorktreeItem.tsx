import React, { useCallback } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AlertTriangle, Trash2 } from "lucide-react";
import type { Worktree } from "@/lib/types";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface WorktreeItemProps {
  worktree: Worktree;
  isSelected: boolean;
  onSelect: () => void;
  onRequestRemove?: () => void;
}

export const WorktreeItem = React.memo(function WorktreeItem({
  worktree,
  isSelected,
  onSelect,
  onRequestRemove,
}: WorktreeItemProps) {
  const isLocal = worktree.is_local;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: worktree.id, disabled: isLocal });

  const style = isLocal
    ? undefined
    : {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0 : undefined,
      };

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      onSelect();
    },
    [onSelect],
  );

  return (
    <div
      ref={isLocal ? undefined : setNodeRef}
      style={style}
      {...(isLocal ? {} : attributes)}
      {...(isLocal ? {} : listeners)}
      className="group/worktree-item relative"
      data-worktree-drag-item={isLocal ? undefined : "true"}
      data-worktree-id={isLocal ? undefined : worktree.id}
    >
      <div
        className={`flex cursor-default select-none items-center gap-1 rounded-md px-2 py-1 text-sm transition-colors hover:bg-sidebar-accent ${
          onRequestRemove ? "pr-8" : ""
        } ${
          isSelected
            ? "bg-sidebar-primary text-sidebar-primary-foreground"
            : "text-sidebar-foreground/80"
        }`}
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={handleKeyDown}
      >
        <span
          className="flex h-6 w-5 shrink-0 items-center justify-center"
          aria-hidden="true"
        />
        <span className="truncate">{worktree.name}</span>
        {worktree.missing_on_disk && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="ml-2 inline-flex items-center text-destructive"
                aria-label="Worktree missing on disk"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" align="center">
              This worktree was deleted outside Hubris. Remove it from Hubris to
              clear this entry.
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {onRequestRemove && (
        <button
          className="pointer-events-none absolute top-1/2 right-1 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-sidebar-foreground/70 opacity-0 transition-[opacity,background-color,color] group-hover/worktree-item:pointer-events-auto group-hover/worktree-item:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          title="Delete worktree"
          onClick={(e) => {
            e.stopPropagation();
            onRequestRemove();
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
});
