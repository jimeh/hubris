import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
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

  const localWorktree = worktrees.find((worktree) => worktree.is_local) ?? null;
  const nonLocalWorktrees = worktrees.filter((worktree) => !worktree.is_local);

  const style = {
    transform: isDragging ? undefined : CSS.Translate.toString(transform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0 : undefined,
    pointerEvents: isDragging ? ("none" as const) : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} className="relative rounded-lg">
      <Collapsible open={isExpanded} onOpenChange={onToggleExpand}>
        <SidebarMenuItem>
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
              onToggleExpand={() => {
                if (dragLock) {
                  return;
                }

                onToggleExpand();
              }}
              actionSlot={
                <div
                  className={cn(
                    "ml-auto flex items-center gap-1 transition-opacity",
                    isSorting
                      ? "pointer-events-none opacity-0"
                      : "opacity-0 group-hover/project-row:opacity-100",
                  )}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <ProjectActionMenu
                    onRename={onRenameProject}
                    onRemove={onRemoveProject}
                  />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="New worktree"
                    onClick={(event) => {
                      event.stopPropagation();
                      onAddWorktree();
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              }
            />
          </SidebarMenuButton>

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
              onRemoveWorktree={onRemoveWorktree}
              onReorder={onReorderWorktrees}
            />
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    </div>
  );
}
