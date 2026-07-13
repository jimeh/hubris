import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { KeyboardEvent } from "react";
import { Plus } from "lucide-react";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Project, Worktree } from "@/lib/types";
import ProjectActionMenu from "./ProjectActionMenu";
import ProjectHeaderRow from "./ProjectHeaderRow";
import WorktreeList from "./WorktreeList";

export type ProjectRowProps = {
  project: Project;
  isExpanded: boolean;
  selectedWorktreeId: string | null;
  projectError: string | null;
  worktrees: Worktree[];
  isSorting: boolean;
  dragLock: boolean;
  suppressAnimations: boolean;
  onToggleExpand: () => void;
  onSelectWorktree: (id: string) => void;
  onAddWorktree: () => void;
  onRenameProject: () => void;
  onRemoveProject: () => void;
  onRenameWorktree: (worktree: Worktree) => void;
  onRemoveWorktree: (worktree: Worktree) => void;
  onReorderWorktrees: (orderedIds: string[]) => void;
};

export default function ProjectRow({
  project,
  isExpanded,
  selectedWorktreeId,
  projectError: currentProjectError,
  worktrees,
  isSorting,
  dragLock,
  suppressAnimations,
  onToggleExpand,
  onSelectWorktree,
  onAddWorktree,
  onRenameProject,
  onRemoveProject,
  onRenameWorktree,
  onRemoveWorktree,
  onReorderWorktrees,
}: ProjectRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id });

  const localWorktree = worktrees.find((worktree) => worktree.isLocal) ?? null;
  const nonLocalWorktrees = worktrees.filter((worktree) => !worktree.isLocal);

  const style = {
    transform: isDragging ? undefined : CSS.Translate.toString(transform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0 : undefined,
    pointerEvents: isDragging ? ("none" as const) : undefined,
  };

  function handleContextMenuKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
  ): void {
    const isKeyboardContextMenu =
      event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);

    if (!isKeyboardContextMenu) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    );
  }

  return (
    <div ref={setNodeRef} style={style} className="relative rounded-lg">
      <Collapsible open={isExpanded} onOpenChange={onToggleExpand}>
        <SidebarMenuItem>
          <ContextMenu modal={false}>
            <ContextMenuTrigger asChild>
              <SidebarMenuButton
                asChild
                size="default"
                className="relative h-auto items-start px-0 py-0"
              >
                <ProjectHeaderRow
                  projectName={project.name}
                  isExpanded={isExpanded}
                  projectError={currentProjectError}
                  isSorting={isSorting}
                  rowProps={{ ...attributes, ...listeners }}
                  onContentKeyDown={handleContextMenuKeyDown}
                  onToggleExpand={() => {
                    if (dragLock) {
                      return;
                    }

                    onToggleExpand();
                  }}
                  actionSlot={
                    <div
                      className={cn(
                        "ml-auto flex items-center gap-0.5 transition-opacity",
                        isSorting
                          ? "pointer-events-none opacity-0"
                          : "opacity-0 group-hover/project-row:opacity-70",
                      )}
                      onPointerDown={(event) => event.stopPropagation()}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex size-6 items-center justify-center text-sidebar-foreground/55 transition-[color,opacity] outline-none hover:opacity-100 hover:text-sidebar-foreground focus-visible:text-sidebar-foreground"
                            aria-label="New worktree"
                            onContextMenu={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                            }}
                            onClick={(event) => {
                              event.stopPropagation();
                              onAddWorktree();
                            }}
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          New worktree
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  }
                />
              </SidebarMenuButton>
            </ContextMenuTrigger>
            <ProjectActionMenu
              onRename={onRenameProject}
              onRemove={onRemoveProject}
            />
          </ContextMenu>

          <CollapsibleContent
            className={cn(
              "overflow-hidden",
              !suppressAnimations &&
                "data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down",
            )}
          >
            <WorktreeList
              localWorktree={localWorktree}
              worktrees={nonLocalWorktrees}
              projectError={currentProjectError}
              selectedWorktreeId={selectedWorktreeId}
              onSelectWorktree={onSelectWorktree}
              onRenameWorktree={onRenameWorktree}
              onRemoveWorktree={onRemoveWorktree}
              onReorder={onReorderWorktrees}
            />
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    </div>
  );
}
