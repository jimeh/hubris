import { useEffect, useRef, useMemo } from "react";
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
import { Folder } from "lucide-react";
import { AppSidebar } from "@/components/AppSidebar";
import { SidebarResizeHandle } from "@/components/SidebarResizeHandle";
import { WorktreeView } from "@/components/WorktreeView";
import { useProjectStore } from "@/lib/stores/projects";
import { useSidebarWidthStore } from "@/lib/stores/sidebarWidth";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import { useTabStore } from "@/lib/stores/tabs";
import { useThemeStore } from "@/lib/stores/theme";
import { useTerminalStore } from "@/lib/stores/terminal";
import { useWorktreeSettingsStore } from "@/lib/stores/worktreeSettings";
import { getEventClient } from "@/lib/events";

export default function App() {
  const initialized = useRef(false);

  // Touch all stores to ensure SSE handlers are
  // registered before connect.
  useProjectStore();
  useWorktreeStore();
  useTabStore();

  const themeInit = useThemeStore((s) => s.init);
  const termInit = useTerminalStore((s) => s.init);
  const wtSettingsInit = useWorktreeSettingsStore((s) => s.init);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    // Initialize async stores
    themeInit();
    termInit();
    wtSettingsInit();

    // Start SSE event stream for state sync
    const events = getEventClient();
    events.connect();
  }, [themeInit, termInit, wtSettingsInit]);

  const isResizing = useSidebarWidthStore((s) => s.isResizing);
  const providerRef = useRef<HTMLDivElement>(null);

  // Sync sidebar width to DOM imperatively to avoid full re-renders
  // during resize drag. Only the CSS variable changes, no React
  // reconciliation needed.
  useEffect(() => {
    const el = providerRef.current;
    if (!el) return;
    el.style.setProperty(
      "--sidebar-width",
      `${useSidebarWidthStore.getState().width}px`,
    );
    return useSidebarWidthStore.subscribe((state) => {
      el.style.setProperty("--sidebar-width", `${state.width}px`);
    });
  }, []);

  const projects = useProjectStore((s) => s.projects);
  const selectedWorktree = useWorktreeStore((s) => s.selectedWorktree);
  const worktree = selectedWorktree();

  const selectedProject = useMemo(
    () =>
      worktree
        ? (projects.find((p) => p.id === worktree.project_id) ?? null)
        : null,
    [worktree, projects],
  );

  return (
    <SidebarProvider
      ref={providerRef}
      className={isResizing ? "sidebar-resizing" : undefined}
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
              {selectedProject && (
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbPage className="flex items-center gap-1.5">
                    <Folder className="h-3.5 w-3.5" />
                    {selectedProject.name}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              )}
              {selectedProject && worktree && (
                <BreadcrumbSeparator className="hidden md:block" />
              )}
              {worktree && (
                <BreadcrumbItem>
                  <BreadcrumbPage>{worktree.name}</BreadcrumbPage>
                </BreadcrumbItem>
              )}
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        <div className="flex flex-1 flex-col overflow-hidden">
          {worktree ? (
            <WorktreeView worktree={worktree} />
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
