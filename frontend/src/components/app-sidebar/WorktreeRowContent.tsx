import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type WorktreeRowContentProps = {
  isSelected: boolean;
  isSorting?: boolean;
  leadingSlot?: ReactNode;
  contentSlot: ReactNode;
  actionSlot?: ReactNode;
  rowClassName?: string;
};

export default function WorktreeRowContent({
  isSelected,
  isSorting = false,
  leadingSlot = <span className="size-3.5 shrink-0" aria-hidden="true" />,
  contentSlot,
  actionSlot = null,
  rowClassName,
}: WorktreeRowContentProps) {
  return (
    <>
      <div
        className={cn(
          "flex min-h-8 cursor-default select-none items-center gap-2 rounded-md px-2 py-1 pr-8 text-sm transition-colors",
          !isSorting &&
            !isSelected &&
            "hover:bg-sidebar-accent group-hover/worktree-item:bg-sidebar-accent",
          isSelected
            ? "bg-sidebar-primary text-sidebar-primary-foreground"
            : "text-sidebar-foreground/80",
          rowClassName,
        )}
      >
        {leadingSlot}
        {contentSlot}
      </div>
      {actionSlot}
    </>
  );
}
