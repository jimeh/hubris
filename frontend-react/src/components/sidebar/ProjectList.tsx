import { useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { useProjectStore } from "@/lib/stores/projects";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import type { Worktree } from "@/lib/types";
import type { SidebarDialogState } from "./types";
import { ProjectItem } from "./ProjectItem";

interface ProjectListProps {
  setDialogState: React.Dispatch<React.SetStateAction<SidebarDialogState>>;
}

export function ProjectList({ setDialogState }: ProjectListProps) {
  const projects = useProjectStore((s) => s.projects);
  const isExpanded = useProjectStore((s) => s.isExpanded);
  const toggleExpanded = useProjectStore((s) => s.toggleExpanded);
  const reorderProjects = useProjectStore((s) => s.reorder);

  const selectedWorktreeId = useWorktreeStore((s) => s.selectedWorktreeId);
  const worktreesForProject = useWorktreeStore((s) => s.worktreesForProject);
  const selectWorktree = useWorktreeStore((s) => s.select);
  const projectError = useWorktreeStore((s) => s.projectError);
  const reorderWorktrees = useWorktreeStore((s) => s.reorder);

  const [isDragging, setIsDragging] = useState(false);
  const dragSnapshotRef = useRef<{
    html: string;
    width: number;
  } | null>(null);
  const [, forceRender] = useState(0);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  function handleDragStart(event: DragStartEvent) {
    setIsDragging(true);

    // Clone the actual DOM element for a pixel-perfect overlay.
    const el = document.querySelector(
      `[data-project-drag-item="true"][data-project-id="${event.active.id}"]`,
    );
    if (el instanceof HTMLElement) {
      dragSnapshotRef.current = {
        html: el.innerHTML,
        width: el.getBoundingClientRect().width,
      };
    }
    forceRender((n) => n + 1);
  }

  function handleDragEnd(event: DragEndEvent) {
    setIsDragging(false);
    dragSnapshotRef.current = null;
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = projects.findIndex((p) => p.id === active.id);
    const newIndex = projects.findIndex((p) => p.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = [...projects];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);

    reorderProjects(reordered.map((p) => p.id));
  }

  function localWorktree(projectId: string): Worktree | null {
    return worktreesForProject(projectId).find((wt) => wt.is_local) ?? null;
  }

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => {
              setIsDragging(false);
              dragSnapshotRef.current = null;
            }}
          >
            <SortableContext
              items={projects.map((p) => p.id)}
              strategy={verticalListSortingStrategy}
            >
              <div
                className="flex w-full min-w-0 cursor-default select-none flex-col gap-1 overflow-x-hidden"
                data-sidebar-dragging={isDragging || undefined}
              >
                {projects.map((project) => (
                  <ProjectItem
                    key={project.id}
                    project={project}
                    isExpanded={isExpanded(project.id)}
                    selectedWorktreeId={selectedWorktreeId}
                    localWorktree={localWorktree(project.id)}
                    worktrees={worktreesForProject(project.id)}
                    projectError={projectError(project.id)}
                    onToggleExpand={() => toggleExpanded(project.id)}
                    onRequestRename={() => {
                      setDialogState((s) => ({
                        ...s,
                        actionError: null,
                        renameProject: {
                          projectId: project.id,
                          currentName: project.name,
                        },
                      }));
                    }}
                    onRequestRemove={() => {
                      setDialogState((s) => ({
                        ...s,
                        actionError: null,
                        confirmRemoveProject: project.id,
                      }));
                    }}
                    onRequestAddWorktree={() => {
                      setDialogState((s) => ({
                        ...s,
                        actionError: null,
                        addWorktree: {
                          projectId: project.id,
                          projectName: project.name,
                        },
                      }));
                    }}
                    onSelectWorktree={selectWorktree}
                    onRequestRemoveWorktree={(projectId, worktree) => {
                      setDialogState((s) => ({
                        ...s,
                        actionError: null,
                        confirmRemoveWorktree: {
                          projectId,
                          worktree,
                        },
                      }));
                    }}
                    onWorktreeReorder={reorderWorktrees}
                    listDragging={isDragging}
                  />
                ))}
              </div>
            </SortableContext>
            <DragOverlay
              >
              {dragSnapshotRef.current && (
                <div
                  className="group/menu-item relative rounded-md opacity-90"
                  style={{
                    width: dragSnapshotRef.current.width,
                  }}
                  dangerouslySetInnerHTML={{
                    __html: dragSnapshotRef.current.html,
                  }}
                />
              )}
            </DragOverlay>
          </DndContext>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
