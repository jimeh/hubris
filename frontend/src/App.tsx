import { useLayoutEffect, useMemo, useRef } from "react";
import { Folder, PanelRight } from "lucide-react";
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
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import AppSidebar from "@/components/AppSidebar";
import SidebarResizeHandle from "@/components/SidebarResizeHandle";
import WorktreeView from "@/components/WorktreeView";
import { Button } from "@/components/ui/button";
import { useProjectStore } from "@/lib/stores/projects";
import { useSidebarWidthStore } from "@/lib/stores/sidebarWidth";
import { WORKTREE_RIGHT_SIDEBAR_GIT_STATUS_PANEL } from "@/lib/worktreeRightSidebar";
import { useWorktreeRightSidebarStore } from "@/lib/stores/worktreeRightSidebar";
import { useWorktreeStore } from "@/lib/stores/worktrees";

function AppHeader({
  selectedProject,
  selectedWorktree,
}: {
  selectedProject: { name: string } | null;
  selectedWorktree: { name: string } | null;
}) {
  const sidebar = useSidebar();
  const isMobile = sidebar.isMobile;
  const sidebarVisible = sidebar.isMobile
    ? sidebar.openMobile
    : sidebar.state !== "collapsed";
  const desktopOpen = useWorktreeRightSidebarStore(
    (state) => state.desktopOpen,
  );
  const mobileOpen = useWorktreeRightSidebarStore((state) => state.mobileOpen);
  const activePanel = useWorktreeRightSidebarStore(
    (state) => state.activePanel,
  );
  const closeForViewport = useWorktreeRightSidebarStore(
    (state) => state.closeForViewport,
  );
  const openPanel = useWorktreeRightSidebarStore((state) => state.openPanel);
  const gitStatusVisible =
    (isMobile ? mobileOpen : desktopOpen) &&
    activePanel === WORKTREE_RIGHT_SIDEBAR_GIT_STATUS_PANEL;
  const gitStatusLabel = gitStatusVisible
    ? "Hide git status"
    : "Show git status";

  return (
    <header className="flex shrink-0 items-center gap-2 border-b py-2 pl-3 pr-4 md:h-12 md:py-0">
      <div className="mr-2.5 flex shrink-0 items-center gap-1 self-start md:self-auto">
        <Tooltip>
          <TooltipTrigger asChild>
            <SidebarTrigger className="mr-1 shrink-0" />
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {sidebarVisible ? "Hide sidebar" : "Show sidebar"}
          </TooltipContent>
        </Tooltip>
        <Separator
          orientation="vertical"
          className="shrink-0 data-[orientation=vertical]:h-4"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-col gap-0.5 md:hidden">
          {selectedProject ? (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Folder className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{selectedProject.name}</span>
            </div>
          ) : null}
          {selectedWorktree ? (
            <div className="truncate text-base font-medium">
              {selectedWorktree.name}
            </div>
          ) : null}
        </div>
        <Breadcrumb className="hidden md:block">
          <BreadcrumbList>
            {selectedProject ? (
              <BreadcrumbItem>
                <BreadcrumbPage className="flex items-center gap-1.5">
                  <Folder className="h-3.5 w-3.5" />
                  {selectedProject.name}
                </BreadcrumbPage>
              </BreadcrumbItem>
            ) : null}
            {selectedProject && selectedWorktree ? (
              <BreadcrumbSeparator />
            ) : null}
            {selectedWorktree ? (
              <BreadcrumbItem>
                <BreadcrumbPage>{selectedWorktree.name}</BreadcrumbPage>
              </BreadcrumbItem>
            ) : null}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      {selectedWorktree ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={gitStatusLabel}
              onClick={() => {
                if (gitStatusVisible) {
                  closeForViewport(isMobile);
                } else {
                  openPanel(WORKTREE_RIGHT_SIDEBAR_GIT_STATUS_PANEL, isMobile);
                }
              }}
            >
              <PanelRight className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{gitStatusLabel}</TooltipContent>
        </Tooltip>
      ) : null}
    </header>
  );
}

export default function App() {
  const projects = useProjectStore((state) => state.projects);
  const selectedWorktreeId = useWorktreeStore(
    (state) => state.selectedWorktreeId,
  );
  const worktreesByProject = useWorktreeStore(
    (state) => state.worktreesByProject,
  );
  const isResizing = useSidebarWidthStore((state) => state.isResizing);
  const appRootRef = useRef<HTMLDivElement | null>(null);
  const initialSidebarWidthRef = useRef(useSidebarWidthStore.getState().width);

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

  useLayoutEffect(() => {
    const host = appRootRef.current;
    const sidebarWrapper =
      host?.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']") ?? null;
    if (!sidebarWrapper) {
      return;
    }
    const sidebarElement = sidebarWrapper;

    function applySidebarWidth(width: number): void {
      sidebarElement.style.setProperty("--sidebar-width", `${width}px`);
    }

    applySidebarWidth(useSidebarWidthStore.getState().width);

    return useSidebarWidthStore.subscribe((state) => {
      applySidebarWidth(state.width);
    });
  }, []);

  return (
    <div ref={appRootRef}>
      <SidebarProvider
        className={isResizing ? "sidebar-resizing" : undefined}
        style={
          {
            "--sidebar-width": `${initialSidebarWidthRef.current}px`,
          } as React.CSSProperties
        }
      >
        <AppSidebar />
        <SidebarResizeHandle />
        <SidebarInset>
          <AppHeader
            selectedProject={selectedProject}
            selectedWorktree={selectedWorktree}
          />
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
    </div>
  );
}
