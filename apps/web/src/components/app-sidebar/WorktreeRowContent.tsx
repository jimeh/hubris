import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type WorktreeRowContentProps = {
  isSelected: boolean;
  isSorting?: boolean;
  leadingSlot?: ReactNode;
  contentSlot: ReactNode;
  trailingSlot?: ReactNode;
  actionSlot?: ReactNode;
  rowClassName?: string;
};

export default function WorktreeRowContent({
  isSelected,
  isSorting = false,
  leadingSlot = <span className="size-3.5 shrink-0" aria-hidden="true" />,
  contentSlot,
  trailingSlot = null,
  actionSlot = null,
  rowClassName,
}: WorktreeRowContentProps) {
  return (
    <div
      className={cn(
        "group/worktree-row flex min-h-8 cursor-default select-none items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors",
        !isSorting &&
          !isSelected &&
          "hover:bg-sidebar-accent group-hover/worktree-item:bg-sidebar-accent",
        !isSorting &&
          !isSelected &&
          "focus-within:bg-sidebar-accent focus-within:text-sidebar-accent-foreground group-focus-within/worktree-item:bg-sidebar-accent group-focus-within/worktree-item:text-sidebar-accent-foreground",
        isSelected
          ? "bg-sidebar-primary text-sidebar-primary-foreground"
          : "text-sidebar-foreground/80",
        rowClassName,
      )}
    >
      {leadingSlot}
      <div className="flex min-w-0 flex-1">{contentSlot}</div>
      {actionSlot ? (
        <div
          className={cn(
            "flex max-w-0 items-center gap-1 overflow-hidden transition-[max-width,opacity] duration-150",
            "pointer-events-none opacity-0",
            !isSorting &&
              "group-hover/worktree-row:max-w-24 group-hover/worktree-row:opacity-100 group-hover/worktree-row:pointer-events-auto",
            !isSorting &&
              "group-focus-within/worktree-row:max-w-24 group-focus-within/worktree-row:opacity-100 group-focus-within/worktree-row:pointer-events-auto",
          )}
        >
          {actionSlot}
        </div>
      ) : null}
      {trailingSlot}
    </div>
  );
}
