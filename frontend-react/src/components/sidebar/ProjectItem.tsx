import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { SidebarMenuItem, SidebarMenuButton } from "@/components/ui/sidebar";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Plus,
} from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Project, Worktree } from "@/lib/types";
import { ProjectActionMenu } from "./ProjectActionMenu";
import { WorktreeList } from "./WorktreeList";

interface ProjectItemProps {
  project: Project;
  isExpanded: boolean;
  selectedWorktreeId: string | null;
  localWorktree: Worktree | null;
  worktrees: Worktree[];
  projectError: string | null;
  onToggleExpand: () => void;
  onRequestRename: () => void;
  onRequestRemove: () => void;
  onRequestAddWorktree: () => void;
  onSelectWorktree: (id: string) => void;
  onRequestRemoveWorktree: (projectId: string, worktree: Worktree) => void;
  onWorktreeReorder: (projectId: string, ids: string[]) => void;
  listDragging: boolean;
}

export const ProjectItem = React.memo(function ProjectItem({
  project,
  isExpanded,
  selectedWorktreeId,
  localWorktree,
  worktrees,
  projectError,
  onToggleExpand,
  onRequestRename,
  onRequestRemove,
  onRequestAddWorktree,
  onSelectWorktree,
  onRequestRemoveWorktree,
  onWorktreeReorder,
  listDragging,
}: ProjectItemProps) {
  const [enableAnimation, setEnableAnimation] = useState(false);
  const wasListDragging = useRef(false);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0 : undefined,
  };

  // Suppress animation during and right after any list drag so
  // collapsibles don't re-animate when @dnd-kit reorders DOM elements.
  useEffect(() => {
    if (listDragging) {
      wasListDragging.current = true;
    } else if (wasListDragging.current) {
      wasListDragging.current = false;
      setEnableAnimation(false);
    }
  }, [listDragging]);

  const shouldAnimate = enableAnimation && !listDragging;

  const handleOpenChange = useCallback(() => {
    setEnableAnimation(true);
    onToggleExpand();
  }, [onToggleExpand]);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      className="group/menu-item relative rounded-md"
      data-project-drag-item="true"
      data-project-id={project.id}
    >
      <Collapsible
        open={isExpanded}
        onOpenChange={handleOpenChange}
        className="group/collapsible"
      >
        <SidebarMenuItem className="list-none">
          <CollapsibleTrigger asChild>
            <SidebarMenuButton asChild isActive={false} size="default">
              <div
                {...listeners}
                className="relative flex w-full items-center gap-2 overflow-visible px-2 py-1"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <div className="flex items-center gap-2 truncate">
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 group-hover/menu-item:hidden group-data-[state=closed]/collapsible:hidden" />
                    <ChevronDown className="hidden h-3.5 w-3.5 shrink-0 group-hover/menu-item:block group-data-[state=closed]/collapsible:!hidden" />
                    <Folder className="hidden h-3.5 w-3.5 shrink-0 group-data-[state=closed]/collapsible:block group-data-[state=closed]/collapsible:group-hover/menu-item:!hidden" />
                    <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 group-data-[state=closed]/collapsible:group-hover/menu-item:!block" />
                    <span className="truncate">{project.name}</span>
                  </div>
                  {projectError && (
                    <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive">
                      git error
                    </span>
                  )}
                </div>
                <div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover/menu-item:opacity-100">
                  <ProjectActionMenu
                    onRename={onRequestRename}
                    onRemove={onRequestRemove}
                  />
                  <button
                    className="rounded p-1 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-foreground/12 hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-foreground/12"
                    title="New worktree"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRequestAddWorktree();
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </SidebarMenuButton>
          </CollapsibleTrigger>

          <CollapsibleContent
            data-collapsible-content=""
            className={`overflow-hidden ${
              shouldAnimate
                ? "data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down"
                : ""
            }`}
          >
            <WorktreeList
              projectId={project.id}
              worktrees={worktrees}
              localWorktree={localWorktree}
              selectedWorktreeId={selectedWorktreeId}
              projectError={projectError}
              onSelectWorktree={onSelectWorktree}
              onRequestRemoveWorktree={onRequestRemoveWorktree}
              onReorder={onWorktreeReorder}
            />
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    </div>
  );
});
