import type { HTMLAttributes, ReactNode } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";

type ProjectHeaderRowProps = {
  projectName: string;
  isExpanded: boolean;
  projectError: string | null;
  isSorting: boolean;
  forceChevron?: boolean;
  rowClassName?: string;
  contentClassName?: string;
  actionSlot: ReactNode;
  rowProps?: HTMLAttributes<HTMLDivElement>;
  onToggleExpand?: () => void;
};

export default function ProjectHeaderRow({
  projectName,
  isExpanded,
  projectError,
  isSorting,
  forceChevron = false,
  rowClassName,
  contentClassName,
  actionSlot,
  rowProps,
  onToggleExpand,
}: ProjectHeaderRowProps) {
  const FolderIcon = isExpanded ? FolderOpen : Folder;
  const ChevronIcon = isExpanded ? ChevronDown : ChevronRight;

  return (
    <div
      className={cn(
        "group/project-row flex min-h-8 w-full items-center gap-1 rounded-md px-2 py-1 text-sm transition-colors",
        !isSorting &&
          "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        rowClassName,
      )}
      {...rowProps}
    >
      {onToggleExpand ? (
        <button
          className={cn(
            "m-0 flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent p-0 text-left appearance-none",
            contentClassName,
          )}
          onClick={onToggleExpand}
          type="button"
        >
          <span className="relative size-3.5 shrink-0">
            <FolderIcon
              className={cn(
                "absolute inset-0 h-3.5 w-3.5 transition-all duration-150",
                forceChevron
                  ? "scale-85 opacity-0"
                  : "group-hover/project-row:scale-85 group-hover/project-row:opacity-0",
              )}
            />
            <ChevronIcon
              className={cn(
                "absolute inset-0 h-3.5 w-3.5 transition-all duration-150",
                forceChevron
                  ? "opacity-100"
                  : "opacity-0 group-hover/project-row:opacity-100",
              )}
            />
          </span>
          <span className="truncate">{projectName}</span>
          {projectError ? (
            <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive">
              git error
            </span>
          ) : null}
        </button>
      ) : (
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2",
            contentClassName,
          )}
        >
          <span className="relative size-3.5 shrink-0">
            <FolderIcon
              className={cn(
                "absolute inset-0 h-3.5 w-3.5 transition-all duration-150",
                forceChevron
                  ? "scale-85 opacity-0"
                  : "group-hover/project-row:scale-85 group-hover/project-row:opacity-0",
              )}
            />
            <ChevronIcon
              className={cn(
                "absolute inset-0 h-3.5 w-3.5 transition-all duration-150",
                forceChevron
                  ? "opacity-100"
                  : "opacity-0 group-hover/project-row:opacity-100",
              )}
            />
          </span>
          <span className="truncate">{projectName}</span>
          {projectError ? (
            <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive">
              git error
            </span>
          ) : null}
        </div>
      )}
      {actionSlot}
    </div>
  );
}
