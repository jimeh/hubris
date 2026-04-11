import { AlertTriangle, Ellipsis, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import type { Project, Worktree } from "@/lib/types";
import ProjectHeaderRow from "./ProjectHeaderRow";
import VscodeWorkbenchIndicator from "./VscodeWorkbenchIndicator";
import WorktreeIndicator from "./WorktreeIndicator";
import WorktreeRowContent from "./WorktreeRowContent";

type ProjectPreviewProps = {
  project: Project;
  isExpanded: boolean;
  projectError: string | null;
  worktrees: Worktree[];
  selectedWorktreeId: string | null;
};

export default function ProjectPreview({
  project,
  isExpanded,
  projectError: currentProjectError,
  worktrees,
  selectedWorktreeId,
}: ProjectPreviewProps) {
  const localWorktree = worktrees.find((worktree) => worktree.is_local) ?? null;
  const nonLocalWorktrees = worktrees.filter((worktree) => !worktree.is_local);

  return (
    <>
      <SidebarMenuItem className="list-none">
        <SidebarMenuButton
          asChild
          size="default"
          className="relative h-auto items-start px-0 py-0"
        >
          <ProjectHeaderRow
            projectName={project.name}
            isExpanded={isExpanded}
            projectError={currentProjectError}
            isSorting
            forceChevron
            rowClassName="bg-sidebar-accent text-sidebar-accent-foreground shadow-md hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            actionSlot={
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon-xs" tabIndex={-1}>
                  <Ellipsis className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon-xs" tabIndex={-1}>
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
            }
          />
        </SidebarMenuButton>
      </SidebarMenuItem>

      {isExpanded ? (
        <ProjectPreviewWorktreeList
          localWorktree={localWorktree}
          worktrees={nonLocalWorktrees}
          projectError={currentProjectError}
          selectedWorktreeId={selectedWorktreeId}
        />
      ) : null}
    </>
  );
}

function ProjectPreviewWorktreeList({
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
        <WorktreeRowContent
          isSelected={selectedWorktreeId === localWorktree.id}
          leadingSlot={<WorktreeIndicator worktreeId={localWorktree.id} />}
          trailingSlot={
            <VscodeWorkbenchIndicator worktreeId={localWorktree.id} />
          }
          contentSlot={
            <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <span className="min-w-0 flex-1 truncate">local</span>
            </div>
          }
        />
      ) : null}

      <div className="space-y-1">
        {worktrees.map((worktree) => (
          <div key={worktree.id} className="group/worktree-item relative">
            <WorktreeRowContent
              isSelected={selectedWorktreeId === worktree.id}
              leadingSlot={<WorktreeIndicator worktreeId={worktree.id} />}
              trailingSlot={
                <VscodeWorkbenchIndicator worktreeId={worktree.id} />
              }
              contentSlot={
                <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <span className="min-w-0 flex-1 truncate">
                    {worktree.name}
                  </span>
                  {worktree.missing_on_disk ? (
                    <span className="inline-flex items-center text-destructive">
                      <AlertTriangle className="h-3.5 w-3.5" />
                    </span>
                  ) : null}
                </div>
              }
              actionSlot={
                <span className="pointer-events-none inline-flex size-6 items-center justify-center rounded-md">
                  <Trash2 className="h-3.5 w-3.5" />
                </span>
              }
            />
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
