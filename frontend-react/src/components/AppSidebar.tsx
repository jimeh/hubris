import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderOpen,
  Pencil,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import AddProjectDialog from "@/components/AddProjectDialog";
import AddWorktreeDialog from "@/components/AddWorktreeDialog";
import ConfirmDialog from "@/components/ConfirmDialog";
import RenameProjectDialog from "@/components/RenameProjectDialog";
import SettingsDialog from "@/components/SettingsDialog";
import { cn } from "$lib/utils";
import { useProjectStore } from "$lib/stores/projects";
import {
  projectError,
  useWorktreeStore,
  worktreesForProject,
} from "$lib/stores/worktrees";
import type { Project, Worktree } from "$lib/types";

type DialogState = {
  addProject: boolean;
  showSettings: boolean;
  addWorktree: { projectId: string; projectName: string } | null;
  renameProject: { projectId: string; currentName: string } | null;
  confirmRemoveProject: string | null;
  confirmForceRemoveProject: string | null;
  confirmRemoveWorktree: { projectId: string; worktree: Worktree } | null;
  confirmForceRemoveWorktree: {
    projectId: string;
    worktree: Worktree;
  } | null;
  actionError: string | null;
};

const initialDialogState: DialogState = {
  addProject: false,
  showSettings: false,
  addWorktree: null,
  renameProject: null,
  confirmRemoveProject: null,
  confirmForceRemoveProject: null,
  confirmRemoveWorktree: null,
  confirmForceRemoveWorktree: null,
  actionError: null,
};

export default function AppSidebar() {
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
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleProjectDragStart}
            onDragEnd={(event) => {
              handleProjectDragEnd(event);
              setActiveProjectDragId(null);
              setActiveProjectDragWidth(null);
              releaseProjectDragLock();
            }}
            onDragCancel={() => {
              setActiveProjectDragId(null);
              setActiveProjectDragWidth(null);
              releaseProjectDragLock();
            }}
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
                    projectError={projectError(project.id)}
                    worktrees={worktreesForProject(project.id)}
                    isSorting={activeProjectDragId !== null}
                    dragLock={projectDragLock}
                    suppressAnimations={
                      suppressedProjectAnimations[project.id] ?? false
                    }
                    onToggleExpand={() => handleToggleExpand(project.id)}
                    onSelectWorktree={selectWorktree}
                    onAddWorktree={() =>
                      setDialogState((state) => ({
                        ...state,
                        actionError: null,
                        addWorktree: {
                          projectId: project.id,
                          projectName: project.name,
                        },
                      }))
                    }
                    onRenameProject={() =>
                      setDialogState((state) => ({
                        ...state,
                        actionError: null,
                        renameProject: {
                          projectId: project.id,
                          currentName: project.name,
                        },
                      }))
                    }
                    onRemoveProject={() =>
                      setDialogState((state) => ({
                        ...state,
                        actionError: null,
                        confirmRemoveProject: project.id,
                      }))
                    }
                    onRemoveWorktree={(worktree) =>
                      setDialogState((state) => ({
                        ...state,
                        actionError: null,
                        confirmRemoveWorktree: {
                          projectId: project.id,
                          worktree,
                        },
                      }))
                    }
                    onReorderWorktrees={(orderedIds) =>
                      void reorderWorktrees(project.id, orderedIds)
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
                  projectError={projectError(activeProject.id)}
                  worktrees={worktreesForProject(activeProject.id)}
                  selectedWorktreeId={selectedWorktreeId}
                  width={activeProjectDragWidth}
                />
              ) : null}
            </DragOverlay>
          </DndContext>
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

      {dialogState.addProject ? (
        <AddProjectDialog
          onAdd={async (path) => {
            await addProject(path);
            setDialogState((state) => ({ ...state, addProject: false }));
          }}
          onClose={() =>
            setDialogState((state) => ({ ...state, addProject: false }))
          }
        />
      ) : null}

      {dialogState.addWorktree ? (
        <AddWorktreeDialog
          projectId={dialogState.addWorktree.projectId}
          projectName={dialogState.addWorktree.projectName}
          onAdd={async (branch, startPoint) => {
            await createWorktree(
              dialogState.addWorktree!.projectId,
              branch,
              startPoint,
            );
            setDialogState((state) => ({ ...state, addWorktree: null }));
          }}
          onClose={() =>
            setDialogState((state) => ({ ...state, addWorktree: null }))
          }
        />
      ) : null}

      {dialogState.renameProject ? (
        <RenameProjectDialog
          currentName={dialogState.renameProject.currentName}
          onRename={(name) =>
            renameProject(dialogState.renameProject!.projectId, name)
          }
          onClose={() =>
            setDialogState((state) => ({ ...state, renameProject: null }))
          }
        />
      ) : null}

      {dialogState.confirmRemoveProject ? (
        <ConfirmDialog
          title="Remove Project"
          description={`Remove ${
            projects.find(
              (project) => project.id === dialogState.confirmRemoveProject,
            )?.name ?? "this project"
          } and delete all non-local worktrees for it?`}
          confirmLabel="Remove"
          onConfirm={() => {
            const projectId = dialogState.confirmRemoveProject!;
            setDialogState((state) => ({
              ...state,
              confirmRemoveProject: null,
            }));
            void handleRemoveProject(projectId);
          }}
          onClose={() =>
            setDialogState((state) => ({
              ...state,
              confirmRemoveProject: null,
            }))
          }
        />
      ) : null}

      {dialogState.confirmForceRemoveProject ? (
        <ConfirmDialog
          title="Force Remove Project"
          description={`Project ${
            projects.find(
              (project) => project.id === dialogState.confirmForceRemoveProject,
            )?.name ?? "this project"
          } has linked worktrees with uncommitted changes or busy state. Force remove it anyway?`}
          confirmLabel="Force Remove"
          onConfirm={() => {
            const projectId = dialogState.confirmForceRemoveProject!;
            setDialogState((state) => ({
              ...state,
              confirmForceRemoveProject: null,
            }));
            void handleRemoveProject(projectId, true);
          }}
          onClose={() =>
            setDialogState((state) => ({
              ...state,
              confirmForceRemoveProject: null,
            }))
          }
        />
      ) : null}

      {dialogState.confirmRemoveWorktree ? (
        <ConfirmDialog
          title="Delete Worktree"
          description={`Delete worktree ${dialogState.confirmRemoveWorktree.worktree.name}? This removes the worktree directory from disk.`}
          confirmLabel="Delete"
          onConfirm={() => {
            const target = dialogState.confirmRemoveWorktree!;
            setDialogState((state) => ({
              ...state,
              confirmRemoveWorktree: null,
            }));
            void handleRemoveWorktree(target.projectId, target.worktree.id);
          }}
          onClose={() =>
            setDialogState((state) => ({
              ...state,
              confirmRemoveWorktree: null,
            }))
          }
        />
      ) : null}

      {dialogState.confirmForceRemoveWorktree ? (
        <ConfirmDialog
          title="Force Delete Worktree"
          description={`Worktree ${dialogState.confirmForceRemoveWorktree.worktree.name} has uncommitted changes or is busy. Force delete it anyway?`}
          confirmLabel="Force Delete"
          onConfirm={() => {
            const target = dialogState.confirmForceRemoveWorktree!;
            setDialogState((state) => ({
              ...state,
              confirmForceRemoveWorktree: null,
            }));
            void handleRemoveWorktree(
              target.projectId,
              target.worktree.id,
              true,
            );
          }}
          onClose={() =>
            setDialogState((state) => ({
              ...state,
              confirmForceRemoveWorktree: null,
            }))
          }
        />
      ) : null}

      <SettingsDialog
        open={dialogState.showSettings}
        onOpenChange={(open) =>
          setDialogState((state) => ({
            ...state,
            showSettings: open,
          }))
        }
      />
    </>
  );
}

type ProjectRowProps = {
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

function ProjectRow({
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
    <div
      ref={setNodeRef}
      style={style}
      className="group/menu-item relative rounded-lg"
    >
      <Collapsible open={isExpanded} onOpenChange={onToggleExpand}>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="default"
            className="relative h-auto items-start px-0 py-0 hover:bg-transparent"
          >
            <div
              className={cn(
                "flex w-full items-center gap-1 rounded-md px-2 py-1 text-sm transition-colors",
                !isSorting &&
                  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
              {...attributes}
              {...listeners}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => {
                  if (dragLock) {
                    return;
                  }

                  onToggleExpand();
                }}
                type="button"
              >
                <ProjectToggleIcon isExpanded={isExpanded} />
                <span className="truncate">{project.name}</span>
                {currentProjectError ? (
                  <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive">
                    git error
                  </span>
                ) : null}
              </button>
              <div
                className={cn(
                  "ml-auto flex items-center gap-1 transition-opacity",
                  isSorting
                    ? "pointer-events-none opacity-0"
                    : "opacity-0 group-hover/menu-item:opacity-100",
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
            </div>
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

function ProjectDragOverlay({
  project,
  isExpanded,
  projectError: currentProjectError,
  worktrees,
  selectedWorktreeId,
  width,
}: {
  project: Project;
  isExpanded: boolean;
  projectError: string | null;
  worktrees: Worktree[];
  selectedWorktreeId: string | null;
  width: number | null;
}) {
  const localWorktree = worktrees.find((worktree) => worktree.is_local) ?? null;
  const nonLocalWorktrees = worktrees.filter((worktree) => !worktree.is_local);

  return (
    <div
      className="group/menu-item rounded-lg opacity-60"
      style={width === null ? undefined : { width }}
    >
      <SidebarMenuItem className="list-none">
        <SidebarMenuButton
          size="default"
          className="relative h-auto items-start px-0 py-0 hover:bg-transparent"
        >
          <div className="flex w-full items-center gap-1 rounded-md bg-sidebar-accent px-2 py-1 text-sm text-sidebar-accent-foreground shadow-md">
            <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <ProjectToggleIcon isExpanded={isExpanded} forceChevron />
              <span className="truncate">{project.name}</span>
              {currentProjectError ? (
                <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive">
                  git error
                </span>
              ) : null}
            </div>
            <div className="invisible ml-auto flex items-center gap-1">
              <Button variant="ghost" size="icon-xs" tabIndex={-1}>
                <Ellipsis className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon-xs" tabIndex={-1}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
      {isExpanded ? (
        <ProjectDragWorktreeList
          localWorktree={localWorktree}
          worktrees={nonLocalWorktrees}
          projectError={currentProjectError}
          selectedWorktreeId={selectedWorktreeId}
        />
      ) : null}
    </div>
  );
}

function ProjectDragWorktreeList({
  localWorktree,
  worktrees,
  projectError: currentProjectError,
  selectedWorktreeId,
}: {
  localWorktree: Worktree | null;
  worktrees: Worktree[];
  projectError: string | null;
  selectedWorktreeId: string | null;
}) {
  return (
    <div className="mt-1 space-y-1" role="presentation">
      {localWorktree ? (
        <div
          className={[
            "flex min-h-8 w-full select-none items-center gap-2 rounded-md px-2 py-1 text-left text-sm",
            selectedWorktreeId === localWorktree.id
              ? "bg-sidebar-primary text-sidebar-primary-foreground"
              : "text-sidebar-foreground/80",
          ].join(" ")}
        >
          <span className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">local</span>
        </div>
      ) : null}

      <div className="space-y-1">
        {worktrees.map((worktree) => (
          <div key={worktree.id} className="group/worktree-item relative">
            <div
              className={[
                "flex min-h-8 cursor-default select-none items-center gap-2 rounded-md px-2 py-1 pr-8 text-sm transition-colors",
                selectedWorktreeId === worktree.id
                  ? "bg-sidebar-primary text-sidebar-primary-foreground"
                  : "text-sidebar-foreground/80",
              ].join(" ")}
            >
              <span className="size-3.5 shrink-0" aria-hidden="true" />
              <div className="flex min-w-0 flex-1 items-center text-left">
                <span className="truncate">{worktree.name}</span>
                {worktree.missing_on_disk ? (
                  <span className="ml-2 inline-flex items-center text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5" />
                  </span>
                ) : null}
              </div>
            </div>
            <span className="pointer-events-none absolute top-1/2 right-1 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md opacity-0">
              <Trash2 className="h-3.5 w-3.5" />
            </span>
          </div>
        ))}
      </div>

      {currentProjectError ? (
        <p className="px-2 pb-1 text-xs text-destructive">
          {currentProjectError}
        </p>
      ) : null}
    </div>
  );
}

function ProjectToggleIcon({
  isExpanded,
  forceChevron = false,
}: {
  isExpanded: boolean;
  forceChevron?: boolean;
}) {
  const FolderIcon = isExpanded ? FolderOpen : Folder;
  const ChevronIcon = isExpanded ? ChevronDown : ChevronRight;

  return (
    <span className="relative size-3.5 shrink-0">
      <FolderIcon
        className={cn(
          "absolute inset-0 h-3.5 w-3.5 transition-all duration-150",
          forceChevron
            ? "scale-85 opacity-0"
            : "group-hover/menu-item:scale-85 group-hover/menu-item:opacity-0",
        )}
      />
      <ChevronIcon
        className={cn(
          "absolute inset-0 h-3.5 w-3.5 transition-all duration-150",
          forceChevron
            ? "opacity-100"
            : "opacity-0 group-hover/menu-item:opacity-100",
        )}
      />
    </span>
  );
}

function ProjectActionMenu({
  onRename,
  onRemove,
}: {
  onRename: () => void;
  onRemove: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(event) => event.stopPropagation()}
          title="Project actions"
        >
          <Ellipsis className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        <DropdownMenuItem onClick={onRename}>
          <Pencil className="mr-2 h-3.5 w-3.5" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={onRemove}
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type WorktreeListProps = {
  localWorktree: Worktree | null;
  worktrees: Worktree[];
  projectError: string | null;
  selectedWorktreeId: string | null;
  onSelectWorktree: (id: string) => void;
  onRemoveWorktree: (worktree: Worktree) => void;
  onReorder: (orderedIds: string[]) => void;
};

function WorktreeList({
  localWorktree,
  worktrees,
  projectError: currentProjectError,
  selectedWorktreeId,
  onSelectWorktree,
  onRemoveWorktree,
  onReorder,
}: WorktreeListProps) {
  const [activeWorktreeDragId, setActiveWorktreeDragId] = useState<
    string | null
  >(null);
  const [activeWorktreeDragWidth, setActiveWorktreeDragWidth] = useState<
    number | null
  >(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
  );
  const activeWorktree =
    activeWorktreeDragId === null
      ? null
      : (worktrees.find((worktree) => worktree.id === activeWorktreeDragId) ??
        null);

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = worktrees.findIndex(
      (worktree) => worktree.id === active.id,
    );
    const newIndex = worktrees.findIndex((worktree) => worktree.id === over.id);
    if (oldIndex < 0 || newIndex < 0) {
      return;
    }

    const next = arrayMove(worktrees, oldIndex, newIndex);
    onReorder(next.map((worktree) => worktree.id));
  }

  return (
    <div className="mt-1 space-y-1" role="presentation">
      {localWorktree ? (
        <button
          className={[
            "flex min-h-8 w-full cursor-default select-none items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-sidebar-accent",
            selectedWorktreeId === localWorktree.id
              ? "bg-sidebar-primary text-sidebar-primary-foreground"
              : "text-sidebar-foreground/80",
          ].join(" ")}
          onClick={() => onSelectWorktree(localWorktree.id)}
          type="button"
        >
          <span className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">local</span>
        </button>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={(event) => {
          setActiveWorktreeDragId(String(event.active.id));
          setActiveWorktreeDragWidth(
            event.active.rect.current.initial?.width ?? null,
          );
        }}
        onDragEnd={(event) => {
          handleDragEnd(event);
          setActiveWorktreeDragId(null);
          setActiveWorktreeDragWidth(null);
        }}
        onDragCancel={() => {
          setActiveWorktreeDragId(null);
          setActiveWorktreeDragWidth(null);
        }}
      >
        <SortableContext
          items={worktrees.map((worktree) => worktree.id)}
          strategy={rectSortingStrategy}
        >
          <div className="space-y-1">
            {worktrees.map((worktree) => (
              <WorktreeRow
                key={worktree.id}
                worktree={worktree}
                isSelected={selectedWorktreeId === worktree.id}
                isSorting={activeWorktreeDragId !== null}
                onSelect={() => onSelectWorktree(worktree.id)}
                onRemove={() => onRemoveWorktree(worktree)}
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay>
          {activeWorktree ? (
            <WorktreeDragOverlay
              worktree={activeWorktree}
              isSelected={selectedWorktreeId === activeWorktree.id}
              width={activeWorktreeDragWidth}
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      {currentProjectError ? (
        <p className="px-2 pb-1 text-xs text-destructive">
          {currentProjectError}
        </p>
      ) : null}
    </div>
  );
}

function WorktreeRow({
  worktree,
  isSelected,
  isSorting,
  onSelect,
  onRemove,
}: {
  worktree: Worktree;
  isSelected: boolean;
  isSorting: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: worktree.id });

  const style = {
    transform: isDragging ? undefined : CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0 : undefined,
    pointerEvents: isDragging ? ("none" as const) : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group/worktree-item relative"
      data-worktree-drag-item="true"
      {...attributes}
      {...listeners}
    >
      <div
        className={[
          "flex min-h-8 cursor-default select-none items-center gap-2 rounded-md px-2 py-1 pr-8 text-sm transition-colors",
          isSorting ? "" : "hover:bg-sidebar-accent",
          isSelected
            ? "bg-sidebar-primary text-sidebar-primary-foreground"
            : "text-sidebar-foreground/80",
        ].join(" ")}
      >
        <span className="size-3.5 shrink-0" aria-hidden="true" />
        <button
          className="flex min-w-0 flex-1 items-center text-left"
          onClick={onSelect}
          type="button"
        >
          <span className="truncate">{worktree.name}</span>
          {worktree.missing_on_disk ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="ml-2 inline-flex items-center text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" align="center">
                This worktree was deleted outside Hubris. Remove it from Hubris
                to clear this entry.
              </TooltipContent>
            </Tooltip>
          ) : null}
        </button>
      </div>
      <button
        className={cn(
          "pointer-events-none absolute top-1/2 right-1 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-sidebar-foreground/70 transition-[opacity,background-color,color]",
          isSorting
            ? "opacity-0"
            : "opacity-0 group-hover/worktree-item:pointer-events-auto group-hover/worktree-item:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        )}
        title="Delete worktree"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        type="button"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function WorktreeDragOverlay({
  worktree,
  isSelected,
  width,
}: {
  worktree: Worktree;
  isSelected: boolean;
  width: number | null;
}) {
  return (
    <div
      className="group/worktree-item relative opacity-60"
      style={width === null ? undefined : { width }}
    >
      <div
        className={[
          "flex min-h-8 cursor-default select-none items-center gap-2 rounded-md px-2 py-1 pr-8 text-sm transition-colors",
          isSelected
            ? "bg-sidebar-primary text-sidebar-primary-foreground"
            : "text-sidebar-foreground/80",
        ].join(" ")}
      >
        <span className="size-3.5 shrink-0" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 items-center text-left">
          <span className="truncate">{worktree.name}</span>
          {worktree.missing_on_disk ? (
            <span className="ml-2 inline-flex items-center text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
            </span>
          ) : null}
        </div>
      </div>
      <span className="pointer-events-none absolute top-1/2 right-1 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md opacity-0">
        <Trash2 className="h-3.5 w-3.5" />
      </span>
    </div>
  );
}
