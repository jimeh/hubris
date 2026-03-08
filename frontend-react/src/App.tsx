import { useMemo } from "react";
import { Folder } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import AppSidebar from "@/components/AppSidebar";
import SidebarResizeHandle from "@/components/SidebarResizeHandle";
import WorktreeView from "@/components/WorktreeView";
import { useProjectStore } from "$lib/stores/projects";
import { useSidebarWidthStore } from "$lib/stores/sidebarWidth";
import { useWorktreeStore } from "$lib/stores/worktrees";

export default function App() {
  const projects = useProjectStore((state) => state.projects);
  const selectedWorktreeId = useWorktreeStore(
    (state) => state.selectedWorktreeId,
  );
  const worktreesByProject = useWorktreeStore(
    (state) => state.worktreesByProject,
  );
  const width = useSidebarWidthStore((state) => state.width);
  const isResizing = useSidebarWidthStore((state) => state.isResizing);

  const selectedWorktree = useMemo(() => {
    if (!selectedWorktreeId) {
      return null;
    }

    return (
      Object.values(worktreesByProject)
        .flat()
        .find((worktree) => worktree.id === selectedWorktreeId) ?? null
    );
  }, [selectedWorktreeId, worktreesByProject]);

  const selectedProject = useMemo(() => {
    if (!selectedWorktree) {
      return null;
    }

    return (
      projects.find((project) => project.id === selectedWorktree.project_id) ??
      null
    );
  }, [projects, selectedWorktree]);

  return (
    <SidebarProvider
      className={isResizing ? "sidebar-resizing" : undefined}
      style={{ "--sidebar-width": `${width}px` } as React.CSSProperties}
    >
      <AppSidebar />
      <SidebarResizeHandle />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ms-1" />
          <Separator
            orientation="vertical"
            className="me-2 data-[orientation=vertical]:h-4"
          />
          <Breadcrumb>
            <BreadcrumbList>
              {selectedProject ? (
                <BreadcrumbItem className="hidden md:flex">
                  <BreadcrumbPage className="flex items-center gap-1.5">
                    <Folder className="h-3.5 w-3.5" />
                    {selectedProject.name}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              ) : null}
              {selectedProject && selectedWorktree ? (
                <BreadcrumbSeparator className="hidden md:block" />
              ) : null}
              {selectedWorktree ? (
                <BreadcrumbItem>
                  <BreadcrumbPage>{selectedWorktree.name}</BreadcrumbPage>
                </BreadcrumbItem>
              ) : null}
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        <div className="flex flex-1 flex-col overflow-hidden">
          {selectedWorktree ? (
            <WorktreeView worktree={selectedWorktree} />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <p>Select a worktree from the sidebar</p>
            </div>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
