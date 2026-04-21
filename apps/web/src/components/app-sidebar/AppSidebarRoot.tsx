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
import { executeCommand } from "@/lib/commands";
import { useProjectStore } from "@/lib/stores/projects";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import ProjectList from "./ProjectList";

export default function AppSidebarRoot() {
  const projects = useProjectStore((state) => state.projects);
  const reorderProjects = useProjectStore((state) => state.reorder);
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
  const reorderWorktrees = useWorktreeStore((state) => state.reorder);

  const [showTopFade, setShowTopFade] = useState(false);

  function handleToggleExpand(projectId: string): void {
    toggleExpanded(projectId);
  }

  return (
    <Sidebar className="z-40 md:z-10">
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
                  onClick={() => {
                    void executeCommand({
                      id: "project.add",
                      source: "button",
                    });
                  }}
                >
                  <FolderPlus className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Add project</TooltipContent>
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
          onAddWorktree={(project) => {
            void executeCommand({
              args: { projectId: project.id },
              id: "worktree.create",
              source: "button",
            });
          }}
          onRenameProject={(project) => {
            void executeCommand({
              args: { projectId: project.id },
              id: "project.rename",
              source: "context-menu",
            });
          }}
          onRemoveProject={(project) => {
            void executeCommand({
              args: { projectId: project.id },
              id: "project.remove",
              source: "context-menu",
            });
          }}
          onRenameWorktree={(project, worktree) => {
            void executeCommand({
              args: { projectId: project.id, worktreeId: worktree.id },
              id: "worktree.rename",
              source: "context-menu",
            });
          }}
          onRemoveWorktree={(project, worktree) => {
            void executeCommand({
              args: { projectId: project.id, worktreeId: worktree.id },
              id: "worktree.remove",
              source: "context-menu",
            });
          }}
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
          onClick={() => {
            void executeCommand({
              id: "app.openSettings",
              source: "button",
            });
          }}
        >
          <Settings className="mr-2 h-4 w-4" />
          Settings
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
