import { useMemo } from "react";
import { GitBranch } from "lucide-react";
import {
  CommandDialog,
  CommandGroup,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { executeCommand } from "@/lib/commands";
import { useProjectStore } from "@/lib/stores/projects";
import { useWorktreeHistorySwitcherStore } from "@/lib/stores/worktreeHistorySwitcher";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import type { Project, Worktree } from "@/lib/types";

function worktreeSubtitle(input: {
  branch: string;
  projectName: string;
}): string {
  return [input.projectName, input.branch].filter(Boolean).join(" • ");
}

export default function WorktreeHistorySwitcher() {
  const open = useWorktreeHistorySwitcherStore((state) => state.open);
  const itemIds = useWorktreeHistorySwitcherStore((state) => state.items);
  const selectedIndex = useWorktreeHistorySwitcherStore(
    (state) => state.selectedIndex,
  );
  const cancel = useWorktreeHistorySwitcherStore((state) => state.cancel);
  const selectIndex = useWorktreeHistorySwitcherStore(
    (state) => state.selectIndex,
  );
  const commit = useWorktreeHistorySwitcherStore((state) => state.commit);
  const projects = useProjectStore((state) => state.projects);
  const worktreesByProject = useWorktreeStore(
    (state) => state.worktreesByProject,
  );

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const worktreeById = useMemo(
    () =>
      new Map(
        Object.values(worktreesByProject)
          .flat()
          .map((worktree) => [worktree.id, worktree]),
      ),
    [worktreesByProject],
  );

  const items = useMemo(
    () =>
      itemIds
        .map((worktreeId) => {
          const worktree = worktreeById.get(worktreeId);
          const project = worktree ? projectById.get(worktree.projectId) : null;
          return worktree && project ? { project, worktree } : null;
        })
        .filter(
          (item): item is { project: Project; worktree: Worktree } =>
            item !== null,
        ),
    [itemIds, projectById, worktreeById],
  );

  return (
    <CommandDialog
      className="max-w-lg"
      description="Cycle through recent worktrees."
      open={open}
      showCloseButton={false}
      title="Recent Worktrees"
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          cancel();
        }
      }}
    >
      <CommandList className="max-h-[360px]">
        <CommandGroup heading="Recent Worktrees">
          {items.map(({ project, worktree }, index) => {
            const selected = index === selectedIndex;

            return (
              <button
                key={worktree.id}
                aria-selected={selected}
                className={cn(
                  "relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-2.5 text-left text-sm outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
                  selected && "bg-accent text-accent-foreground",
                )}
                onMouseMove={() => selectIndex(index)}
                onClick={() => {
                  selectIndex(index);
                  const worktreeId = commit();
                  if (!worktreeId) {
                    return;
                  }
                  void executeCommand({
                    args: { worktreeId },
                    id: "worktree.select",
                    source: "keyboard-shortcut",
                  });
                }}
                type="button"
              >
                <GitBranch className="h-4 w-4" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{worktree.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {worktreeSubtitle({
                      branch: worktree.branch,
                      projectName: project.name,
                    })}
                  </span>
                </div>
                {index === 0 ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    Current
                  </span>
                ) : null}
              </button>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
