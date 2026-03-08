import { useState } from "react";
import { FolderPlus, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProjectStore } from "@/lib/stores/projects";
import { useWorktreeStore } from "@/lib/stores/worktrees";
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
  const worktreesByProject = useWorktreeStore(
    (state) => state.worktreesByProject,
  );
  const projectErrors = useWorktreeStore((state) => state.projectErrors);
  const selectWorktree = useWorktreeStore((state) => state.select);
  const createWorktree = useWorktreeStore((state) => state.create);
  const removeWorktree = useWorktreeStore((state) => state.remove);
  const reorderWorktrees = useWorktreeStore((state) => state.reorder);

  const [dialogState, setDialogState] = useState(initialDialogState);
  const [showTopFade, setShowTopFade] = useState(false);

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
        const worktree = (worktreesByProject[projectId] ?? []).find(
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

  function handleToggleExpand(projectId: string): void {
    toggleExpanded(projectId);
  }

  function handleOpenSettings(): void {
    setDialogState((state) => ({
      ...state,
      showSettings: true,
    }));
  }

  return (
    <>
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center justify-between pl-2 pr-1">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Projects</h2>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Add project"
                    onClick={() =>
                      setDialogState((state) => ({
                        ...state,
                        addProject: true,
                      }))
                    }
                  >
                    <FolderPlus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Add project</TooltipContent>
              </Tooltip>
            </div>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <SidebarTrigger className="size-8 md:hidden" />
                </TooltipTrigger>
                <TooltipContent side="bottom">Hide sidebar</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent
          className={`h-full gap-0 overflow-x-hidden overflow-y-auto${
            showTopFade ? " sidebar-scroll-fade-top" : ""
          }`}
          onScroll={(event) => {
            setShowTopFade(event.currentTarget.scrollTop > 0);
          }}
        >
          <ProjectList
            projects={projects}
            expandedById={expandedById}
            selectedWorktreeId={selectedWorktreeId}
            worktreesByProject={worktreesByProject}
            projectErrors={projectErrors}
            onReorderProjects={(orderedIds) => void reorderProjects(orderedIds)}
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

        <SidebarFooter className="relative pt-3">
          <div className="pointer-events-none absolute inset-x-0 -top-3 h-4 bg-gradient-to-b from-transparent via-sidebar/85 to-sidebar" />
          <Button
            variant="ghost"
            className="h-8 w-full justify-start text-muted-foreground"
            title="Settings"
            aria-label="Settings"
            onClick={handleOpenSettings}
          >
            <Settings className="mr-2 h-4 w-4" />
            Settings
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
