import { AlertTriangle, Ellipsis, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import type { Project, Worktree } from "$lib/types";
import ProjectToggleIcon from "./ProjectToggleIcon";

export default function ProjectDragOverlay({
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
