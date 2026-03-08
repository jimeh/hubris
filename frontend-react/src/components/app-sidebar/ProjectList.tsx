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
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useEffect, useRef, useState } from "react";
import { SidebarMenu } from "@/components/ui/sidebar";
import type { Project, Worktree } from "@/lib/types";
import ProjectDragOverlay from "./ProjectDragOverlay";
import ProjectRow from "./ProjectRow";

type ProjectListProps = {
  projects: Project[];
  expandedById: Record<string, boolean>;
  selectedWorktreeId: string | null;
  worktreesByProject: Record<string, Worktree[]>;
  projectErrors: Record<string, string>;
  onReorderProjects: (orderedIds: string[]) => void;
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
  onReorderProjects,
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
  const [activeProjectDragId, setActiveProjectDragId] = useState<string | null>(
    null,
  );
  const [activeProjectDragWidth, setActiveProjectDragWidth] = useState<
    number | null
  >(null);
  const [projectDragLock, setProjectDragLock] = useState(false);
  const [suppressedProjectAnimations, setSuppressedProjectAnimations] =
    useState<Record<string, boolean>>({});
  const projectDragLockTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const activeProject =
    activeProjectDragId === null
      ? null
      : (projects.find((project) => project.id === activeProjectDragId) ??
        null);

  useEffect(() => {
    return () => {
      if (projectDragLockTimeoutRef.current) {
        clearTimeout(projectDragLockTimeoutRef.current);
      }
    };
  }, []);

  function handleProjectDragStart(event: DragStartEvent): void {
    if (projectDragLockTimeoutRef.current) {
      clearTimeout(projectDragLockTimeoutRef.current);
      projectDragLockTimeoutRef.current = null;
    }

    setProjectDragLock(true);
    setSuppressedProjectAnimations(
      Object.fromEntries(projects.map((project) => [project.id, true])),
    );
    setActiveProjectDragId(String(event.active.id));
    setActiveProjectDragWidth(event.active.rect.current.initial?.width ?? null);
  }

  function releaseProjectDragLock(): void {
    if (projectDragLockTimeoutRef.current) {
      clearTimeout(projectDragLockTimeoutRef.current);
    }

    projectDragLockTimeoutRef.current = setTimeout(() => {
      setProjectDragLock(false);
      projectDragLockTimeoutRef.current = null;
    }, 180);
  }

  function handleProjectDragCancel(): void {
    setActiveProjectDragId(null);
    setActiveProjectDragWidth(null);
    releaseProjectDragLock();
  }

  function handleProjectDragEnd(event: DragEndEvent): void {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = projects.findIndex(
        (project) => project.id === active.id,
      );
      const newIndex = projects.findIndex((project) => project.id === over.id);

      if (oldIndex >= 0 && newIndex >= 0) {
        const next = arrayMove(projects, oldIndex, newIndex);
        onReorderProjects(next.map((project) => project.id));
      }
    }

    handleProjectDragCancel();
  }

  function handleToggleExpand(projectId: string): void {
    setSuppressedProjectAnimations((state) => {
      if (!state[projectId]) {
        return state;
      }

      const next = { ...state };
      delete next[projectId];
      return next;
    });

    onToggleExpand(projectId);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleProjectDragStart}
      onDragEnd={handleProjectDragEnd}
      onDragCancel={handleProjectDragCancel}
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
              onToggleExpand={() => handleToggleExpand(project.id)}
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
