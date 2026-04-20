import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, Copy, Folder, PanelRight, Search } from "lucide-react";
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
import BranchInfo from "@/components/BranchInfo";
import CommandDialogs from "@/components/commands/CommandDialogs";
import CommandPalette from "@/components/commands/CommandPalette";
import SettingsStatusNotice from "@/components/SettingsStatusNotice";
import SidebarResizeHandle from "@/components/SidebarResizeHandle";
import ToastViewport from "@/components/ToastViewport";
import VscodeWorkbenchPane from "@/components/VscodeWorkbenchPane";
import WorktreeView from "@/components/WorktreeView";
import { Button } from "@/components/ui/button";
import { executeCommand } from "@/lib/commands";
import { applyMonacoTheme } from "@/lib/monaco";
import { useProjectStore } from "@/lib/stores/projects";
import { useSettingsStore } from "@/lib/stores/settings";
import { useSystemStore } from "@/lib/stores/system";
import { useCommandUiStore } from "@/lib/stores/commandUi";
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
  selectedProject: { name: string; path: string } | null;
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
  const fileManagerVisible = isMobile ? mobileOpen : desktopOpen;
  const fileManagerLabel = fileManagerVisible
    ? "Hide file manager"
    : "Show file manager";
  const isVscodeMode = selectedWorktree?.ui_mode === "vscode";

  const homeDir = useSystemStore((state) => state.homeDir);
  const displayPath = selectedWorktree?.path ?? selectedProject?.path ?? null;
  const shortPath = useMemo(() => {
    if (!displayPath) return null;
    if (
      homeDir &&
      (displayPath === homeDir || displayPath.startsWith(homeDir + "/"))
    ) {
      return "~" + displayPath.slice(homeDir.length);
    }
    return displayPath;
  }, [displayPath, homeDir]);

  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  useEffect(() => () => clearTimeout(copyTimerRef.current!), []);
  const copied = copiedPath === displayPath;
  const copyPath = useCallback(() => {
    if (displayPath) {
      void navigator.clipboard.writeText(displayPath);
      clearTimeout(copyTimerRef.current!);
      setCopiedPath(displayPath);
      copyTimerRef.current = setTimeout(() => setCopiedPath(null), 1500);
    }
  }, [displayPath]);

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
                void executeCommand({
                  args: {
                    projectId: selectedWorktree.project_id,
                    uiMode: "hubris",
                    worktreeId: selectedWorktree.id,
                  },
                  id: "worktree.setUiMode",
                  source: "button",
                });
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
                void executeCommand({
                  args: {
                    projectId: selectedWorktree.project_id,
                    uiMode: "vscode",
                    worktreeId: selectedWorktree.id,
                  },
                  id: "worktree.setUiMode",
                  source: "button",
                });
              }}
            >
              VS Code
            </Button>
          </div>
        ) : null}
      </div>
      <div className="min-w-0 flex-1 md:shrink-0 md:flex-initial">
        {selectedWorktree && !selectedWorktree.is_local ? (
          <BranchInfo
            projectId={selectedWorktree.project_id}
            worktreeId={selectedWorktree.id}
            branch={selectedWorktree.branch}
            sourceRef={selectedWorktree.source_ref ?? null}
          />
        ) : selectedProject ? (
          <div className="flex items-center gap-1.5 truncate text-sm">
            <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{selectedProject.name}</span>
          </div>
        ) : null}
      </div>
      {shortPath ? (
        <div className="hidden min-w-0 flex-1 items-center justify-end gap-1 md:flex">
          <span className="min-w-0 truncate text-xs text-muted-foreground [direction:rtl]">
            <bdi>{shortPath}</bdi>
          </span>
          <button
            type="button"
            className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
            onClick={copyPath}
            aria-label="Copy path"
          >
            {copied ? (
              <Check className="h-3 w-3" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </div>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="inline-flex"
            onClick={() => {
              useCommandUiStore.getState().openPalette();
            }}
          >
            <Search className="h-4 w-4" />
            Commands
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open command palette</TooltipContent>
      </Tooltip>
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
  const selectedWorktreeTabIds = useTabStore((state) =>
    !selectedWorktreeId
      ? ""
      : state.tabs
          .filter((tab) => tab.worktree_id === selectedWorktreeId)
          .map((tab) => tab.id)
          .join("|"),
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
  }, [selectedWorktreeId, selectedWorktreeTabIds, switchToWorktree]);

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
          <CommandPalette />
          <CommandDialogs />
          <ToastViewport />
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
