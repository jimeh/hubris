import { useEffect, useRef, useState } from "react";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { Plus, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { useProjectStore } from "$lib/stores/projects";
import { useWorktreeStore, worktreesForProject } from "$lib/stores/worktrees";
import ProjectList from "./ProjectList";
import SidebarDialogs from "./SidebarDialogs";
import { initialDialogState } from "./types";

export default function AppSidebarRoot() {
  const projects = useProjectStore((state) => state.projects);
  const reorderProjects = useProjectStore((state) => state.reorder);
  const addProject = useProjectStore((state) => state.add);
  const renameProject = useProjectStore((state) => state.rename);
  const removeProject = useProjectStore((state) => state.remove);
  const toggleExpanded = useProjectStore((state) => state.toggleExpanded);
  const expandedById = useProjectStore((state) => state.expandedById);

  const selectedWorktreeId = useWorktreeStore(
    (state) => state.selectedWorktreeId,
  );
  const selectWorktree = useWorktreeStore((state) => state.select);
  const createWorktree = useWorktreeStore((state) => state.create);
  const removeWorktree = useWorktreeStore((state) => state.remove);
  const reorderWorktrees = useWorktreeStore((state) => state.reorder);

  const [dialogState, setDialogState] = useState(initialDialogState);
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

  useEffect(() => {
    return () => {
      if (projectDragLockTimeoutRef.current) {
        clearTimeout(projectDragLockTimeoutRef.current);
      }
    };
  }, []);

  async function handleRemoveProject(
    projectId: string,
    force = false,
  ): Promise<void> {
    try {
      await removeProject(projectId, force);
      setDialogState((state) => ({ ...state, actionError: null }));
    } catch (error) {
      if (!force && (error as Error).message === "409") {
        setDialogState((state) => ({
          ...state,
          confirmForceRemoveProject: projectId,
        }));
      } else {
        setDialogState((state) => ({
          ...state,
          actionError: `Failed to remove project (${(error as Error).message})`,
        }));
      }
    }
  }

  async function handleRemoveWorktree(
    projectId: string,
    worktreeId: string,
    force = false,
  ): Promise<void> {
    try {
      await removeWorktree(projectId, worktreeId, force);
      setDialogState((state) => ({ ...state, actionError: null }));
    } catch (error) {
      const message = (error as Error).message;
      if (!force && message === "409") {
        const worktree = worktreesForProject(projectId).find(
          (candidate) => candidate.id === worktreeId,
        );
        if (worktree) {
          setDialogState((state) => ({
            ...state,
            confirmForceRemoveWorktree: { projectId, worktree },
          }));
        }
      } else {
        setDialogState((state) => ({
          ...state,
          actionError: `Failed to delete worktree (${message})`,
        }));
      }
    }
  }

  function handleProjectDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = projects.findIndex((project) => project.id === active.id);
    const newIndex = projects.findIndex((project) => project.id === over.id);
    if (oldIndex < 0 || newIndex < 0) {
      return;
    }

    const next = arrayMove(projects, oldIndex, newIndex);
    void reorderProjects(next.map((project) => project.id));
  }

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

  function handleToggleExpand(projectId: string): void {
    setSuppressedProjectAnimations((state) => {
      if (!state[projectId]) {
        return state;
      }

      const next = { ...state };
      delete next[projectId];
      return next;
    });

    toggleExpanded(projectId);
  }

  function handleProjectDragCancel(): void {
    setActiveProjectDragId(null);
    setActiveProjectDragWidth(null);
    releaseProjectDragLock();
  }

  return (
    <>
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center justify-between px-2">
            <h2 className="text-lg font-semibold">Projects</h2>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() =>
                setDialogState((state) => ({
                  ...state,
                  showSettings: true,
                }))
              }
              title="Settings"
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </SidebarHeader>

        <SidebarContent className="overflow-x-hidden overflow-y-auto">
          <ProjectList
            projects={projects}
            expandedById={expandedById}
            selectedWorktreeId={selectedWorktreeId}
            activeProjectDragId={activeProjectDragId}
            activeProjectDragWidth={activeProjectDragWidth}
            projectDragLock={projectDragLock}
            suppressedProjectAnimations={suppressedProjectAnimations}
            onProjectDragStart={handleProjectDragStart}
            onProjectDragEnd={(event) => {
              handleProjectDragEnd(event);
              handleProjectDragCancel();
            }}
            onProjectDragCancel={handleProjectDragCancel}
            onToggleExpand={handleToggleExpand}
            onSelectWorktree={selectWorktree}
            onAddWorktree={(project) =>
              setDialogState((state) => ({
                ...state,
                actionError: null,
                addWorktree: {
                  projectId: project.id,
                  projectName: project.name,
                },
              }))
            }
            onRenameProject={(project) =>
              setDialogState((state) => ({
                ...state,
                actionError: null,
                renameProject: {
                  projectId: project.id,
                  currentName: project.name,
                },
              }))
            }
            onRemoveProject={(project) =>
              setDialogState((state) => ({
                ...state,
                actionError: null,
                confirmRemoveProject: project.id,
              }))
            }
            onRemoveWorktree={(project, worktree) =>
              setDialogState((state) => ({
                ...state,
                actionError: null,
                confirmRemoveWorktree: {
                  projectId: project.id,
                  worktree,
                },
              }))
            }
            onReorderWorktrees={(project, orderedIds) =>
              void reorderWorktrees(project.id, orderedIds)
            }
          />
        </SidebarContent>

        <div className="px-2">
          <SidebarSeparator className="mx-0 w-full" />
        </div>

        <SidebarFooter>
          <Button
            variant="ghost"
            className="w-full text-muted-foreground"
            onClick={() =>
              setDialogState((state) => ({
                ...state,
                addProject: true,
              }))
            }
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Project
          </Button>
        </SidebarFooter>

        {dialogState.actionError ? (
          <p className="px-2 pb-2 text-xs text-destructive">
            {dialogState.actionError}
          </p>
        ) : null}
      </Sidebar>

      <SidebarDialogs
        dialogState={dialogState}
        projects={projects}
        setDialogState={setDialogState}
        onAddProject={addProject}
        onAddWorktree={createWorktree}
        onRenameProject={renameProject}
        onRemoveProject={handleRemoveProject}
        onRemoveWorktree={handleRemoveWorktree}
      />
    </>
  );
}
