import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "$lib/utils";
import ProjectToggleIcon from "./ProjectToggleIcon";

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
          <ProjectToggleIcon
            isExpanded={isExpanded}
            forceChevron={forceChevron}
          />
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
          <ProjectToggleIcon
            isExpanded={isExpanded}
            forceChevron={forceChevron}
          />
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
