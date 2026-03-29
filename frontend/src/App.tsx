import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
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
import SettingsStatusNotice from "@/components/SettingsStatusNotice";
import SidebarResizeHandle from "@/components/SidebarResizeHandle";
import ToastViewport from "@/components/ToastViewport";
import VscodeWorkbenchPane from "@/components/VscodeWorkbenchPane";
import WorktreeView from "@/components/WorktreeView";
import { Button } from "@/components/ui/button";
import { applyMonacoTheme } from "@/lib/monaco";
import { useProjectStore } from "@/lib/stores/projects";
import { useSettingsStore } from "@/lib/stores/settings";
import { useSidebarWidthStore } from "@/lib/stores/sidebarWidth";
import { useTabStore } from "@/lib/stores/tabs";
import { useHubrisWorkbenchStore } from "@/lib/stores/hubrisWorkbench";
import { useVscodeWorkbenchStore } from "@/lib/stores/vscodeWorkbench";
import { useWorktreeRightSidebarStore } from "@/lib/stores/worktreeRightSidebar";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import type { Worktree } from "@/lib/types";

function AppHeader({
  selectedProject,
  selectedWorktree,
}: {
  selectedProject: { name: string } | null;
  selectedWorktree: Worktree | null;
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
  const closeForViewport = useWorktreeRightSidebarStore(
    (state) => state.closeForViewport,
  );
  const openTab = useWorktreeRightSidebarStore((state) => state.openTab);
  const activeTab = useWorktreeRightSidebarStore((state) => state.activeTab);
  const updateUiMode = useWorktreeStore((state) => state.updateUiMode);
  const fileManagerVisible = isMobile ? mobileOpen : desktopOpen;
  const fileManagerLabel = fileManagerVisible
    ? "Hide file manager"
    : "Show file manager";
  const isVscodeMode = selectedWorktree?.ui_mode === "vscode";

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
        {selectedWorktree ? (
          <div
            className="ml-1 inline-flex items-center rounded-md border border-border/80 bg-muted/35 p-1"
            role="group"
            aria-label="Worktree mode"
          >
            <Button
              variant={isVscodeMode ? "ghost" : "secondary"}
              size="sm"
              className="h-7 px-3"
              aria-pressed={!isVscodeMode}
              onClick={() => {
                void updateUiMode(
                  selectedWorktree.project_id,
                  selectedWorktree.id,
                  "hubris",
                );
              }}
            >
              Hubris
            </Button>
            <Button
              variant={isVscodeMode ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-3"
              aria-pressed={isVscodeMode}
              onClick={() => {
                void updateUiMode(
                  selectedWorktree.project_id,
                  selectedWorktree.id,
                  "vscode",
                );
              }}
            >
              VS Code
            </Button>
          </div>
        ) : null}
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
        !isVscodeMode ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={fileManagerLabel}
                onClick={() => {
                  if (fileManagerVisible) {
                    closeForViewport(isMobile);
                  } else {
                    openTab(activeTab, isMobile);
                  }
                }}
              >
                <PanelRight className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{fileManagerLabel}</TooltipContent>
          </Tooltip>
        ) : null
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
  const activeTheme = useSettingsStore((state) => state.activeTheme);
  const editorThemeData = useSettingsStore((state) => state.editorThemeData);
  const settingsStatus = useSettingsStore((state) => state.status);
  const isResizing = useSidebarWidthStore((state) => state.isResizing);
  const switchToWorktree = useTabStore((state) => state.switchToWorktree);
  const cachedHubrisWorktreeIds = useHubrisWorkbenchStore(
    (state) => state.loadedWorktreeIds,
  );
  const markHubrisWorkbenchLoaded = useHubrisWorkbenchStore(
    (state) => state.markLoaded,
  );
  const pruneMissingHubrisWorktrees = useHubrisWorkbenchStore(
    (state) => state.pruneMissing,
  );
  const cachedVscodeWorktreeIds = useVscodeWorkbenchStore(
    (state) => state.loadedWorktreeIds,
  );
  const markVscodeWorkbenchLoaded = useVscodeWorkbenchStore(
    (state) => state.markLoaded,
  );
  const pruneMissingVscodeWorktrees = useVscodeWorkbenchStore(
    (state) => state.pruneMissing,
  );
  const appRootRef = useRef<HTMLDivElement | null>(null);
  const initialSidebarWidthRef = useRef(useSidebarWidthStore.getState().width);
  const allWorktrees = useMemo(
    () => Object.values(worktreesByProject).flat(),
    [worktreesByProject],
  );
  const worktreesById = useMemo(
    () =>
      Object.fromEntries(
        allWorktrees.map((worktree) => [worktree.id, worktree]),
      ),
    [allWorktrees],
  );

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

  useEffect(() => {
    applyMonacoTheme(activeTheme, editorThemeData);
  }, [activeTheme, editorThemeData]);

  useEffect(() => {
    if (!selectedWorktreeId) {
      return;
    }

    switchToWorktree(selectedWorktreeId);
  }, [selectedWorktreeId, switchToWorktree]);

  useEffect(() => {
    const ids = allWorktrees.map((worktree) => worktree.id);
    pruneMissingHubrisWorktrees(ids);
    pruneMissingVscodeWorktrees(ids);
  }, [allWorktrees, pruneMissingHubrisWorktrees, pruneMissingVscodeWorktrees]);

  useEffect(() => {
    if (selectedWorktree?.ui_mode === "hubris") {
      markHubrisWorkbenchLoaded(selectedWorktree.id);
    } else if (selectedWorktree?.ui_mode === "vscode") {
      markVscodeWorkbenchLoaded(selectedWorktree.id);
    }
  }, [markHubrisWorkbenchLoaded, markVscodeWorkbenchLoaded, selectedWorktree]);

  const activeHubrisWorktreeId =
    selectedWorktree?.ui_mode === "hubris" ? selectedWorktree.id : null;
  const visibleHubrisWorktreeIds = useMemo(() => {
    if (
      activeHubrisWorktreeId &&
      !cachedHubrisWorktreeIds.includes(activeHubrisWorktreeId)
    ) {
      return [...cachedHubrisWorktreeIds, activeHubrisWorktreeId];
    }

    return cachedHubrisWorktreeIds;
  }, [activeHubrisWorktreeId, cachedHubrisWorktreeIds]);
  const cachedHubrisWorktrees = useMemo(
    () =>
      visibleHubrisWorktreeIds
        .map((worktreeId) => worktreesById[worktreeId] ?? null)
        .filter((worktree): worktree is Worktree => worktree !== null),
    [visibleHubrisWorktreeIds, worktreesById],
  );

  const activeVscodeWorktreeId =
    selectedWorktree?.ui_mode === "vscode" ? selectedWorktree.id : null;
  const visibleVscodeWorktreeIds = useMemo(() => {
    if (
      activeVscodeWorktreeId &&
      !cachedVscodeWorktreeIds.includes(activeVscodeWorktreeId)
    ) {
      return [...cachedVscodeWorktreeIds, activeVscodeWorktreeId];
    }

    return cachedVscodeWorktreeIds;
  }, [activeVscodeWorktreeId, cachedVscodeWorktreeIds]);
  const cachedVscodeWorktrees = useMemo(
    () =>
      visibleVscodeWorktreeIds
        .map((worktreeId) => worktreesById[worktreeId] ?? null)
        .filter((worktree): worktree is Worktree => worktree !== null),
    [visibleVscodeWorktreeIds, worktreesById],
  );

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
          <SettingsStatusNotice status={settingsStatus} />
          <div className="relative flex flex-1 overflow-hidden">
            {selectedWorktree ? (
              <>
                {cachedHubrisWorktrees.map((worktree) => (
                  <WorktreeView
                    key={worktree.id}
                    worktree={worktree}
                    active={
                      worktree.id === selectedWorktree.id &&
                      selectedWorktree.ui_mode === "hubris"
                    }
                  />
                ))}
                {cachedVscodeWorktrees.map((worktree) => (
                  <VscodeWorkbenchPane
                    key={worktree.id}
                    worktree={worktree}
                    active={
                      worktree.id === selectedWorktree.id &&
                      selectedWorktree.ui_mode === "vscode"
                    }
                  />
                ))}
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-muted-foreground">
                <p>Select a worktree from the sidebar</p>
              </div>
            )}
          </div>
          <ToastViewport />
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
