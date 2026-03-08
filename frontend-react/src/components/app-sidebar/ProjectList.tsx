import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { SidebarMenu } from "@/components/ui/sidebar";
import type { Project, Worktree } from "$lib/types";
import ProjectDragOverlay from "./ProjectDragOverlay";
import ProjectRow from "./ProjectRow";

type ProjectListProps = {
  projects: Project[];
  expandedById: Record<string, boolean>;
  selectedWorktreeId: string | null;
  worktreesByProject: Record<string, Worktree[]>;
  projectErrors: Record<string, string>;
  activeProjectDragId: string | null;
  activeProjectDragWidth: number | null;
  projectDragLock: boolean;
  suppressedProjectAnimations: Record<string, boolean>;
  onProjectDragStart: (event: DragStartEvent) => void;
  onProjectDragEnd: (event: DragEndEvent) => void;
  onProjectDragCancel: () => void;
  onToggleExpand: (projectId: string) => void;
  onSelectWorktree: (id: string) => void;
  onAddWorktree: (project: Project) => void;
  onRenameProject: (project: Project) => void;
  onRemoveProject: (project: Project) => void;
  onRemoveWorktree: (project: Project, worktree: Worktree) => void;
  onReorderWorktrees: (project: Project, orderedIds: string[]) => void;
};

export default function ProjectList({
  projects,
  expandedById,
  selectedWorktreeId,
  worktreesByProject,
  projectErrors,
  activeProjectDragId,
  activeProjectDragWidth,
  projectDragLock,
  suppressedProjectAnimations,
  onProjectDragStart,
  onProjectDragEnd,
  onProjectDragCancel,
  onToggleExpand,
  onSelectWorktree,
  onAddWorktree,
  onRenameProject,
  onRemoveProject,
  onRemoveWorktree,
  onReorderWorktrees,
}: ProjectListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const activeProject =
    activeProjectDragId === null
      ? null
      : (projects.find((project) => project.id === activeProjectDragId) ??
        null);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onProjectDragStart}
      onDragEnd={onProjectDragEnd}
      onDragCancel={onProjectDragCancel}
    >
      <SortableContext
        items={projects.map((project) => project.id)}
        strategy={verticalListSortingStrategy}
      >
        <SidebarMenu className="px-2 py-1">
          {projects.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              isExpanded={expandedById[project.id] ?? true}
              selectedWorktreeId={selectedWorktreeId}
              projectError={projectErrors[project.id] ?? null}
              worktrees={worktreesByProject[project.id] ?? []}
              isSorting={activeProjectDragId !== null}
              dragLock={projectDragLock}
              suppressAnimations={
                suppressedProjectAnimations[project.id] ?? false
              }
              onToggleExpand={() => onToggleExpand(project.id)}
              onSelectWorktree={onSelectWorktree}
              onAddWorktree={() => onAddWorktree(project)}
              onRenameProject={() => onRenameProject(project)}
              onRemoveProject={() => onRemoveProject(project)}
              onRemoveWorktree={(worktree) =>
                onRemoveWorktree(project, worktree)
              }
              onReorderWorktrees={(orderedIds) =>
                onReorderWorktrees(project, orderedIds)
              }
            />
          ))}
        </SidebarMenu>
      </SortableContext>
      <DragOverlay>
        {activeProject ? (
          <ProjectDragOverlay
            project={activeProject}
            isExpanded={expandedById[activeProject.id] ?? true}
            projectError={projectErrors[activeProject.id] ?? null}
            worktrees={worktreesByProject[activeProject.id] ?? []}
            selectedWorktreeId={selectedWorktreeId}
            width={activeProjectDragWidth}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
