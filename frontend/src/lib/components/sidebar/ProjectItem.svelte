<script lang="ts">
  import * as Collapsible from "$lib/components/ui/collapsible/index.js";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import {
    ChevronDown,
    ChevronRight,
    Folder,
    FolderOpen,
  } from "@lucide/svelte";
  import { dragHandle } from "svelte-dnd-action";
  import type { Worktree } from "$lib/types";
  import type { DndProject } from "./types.js";
  import ProjectActionMenu from "./ProjectActionMenu.svelte";
  import WorktreeList from "./WorktreeList.svelte";

  let {
    project,
    isExpanded,
    selectedWorktreeId,
    localWorktree = null,
    worktrees,
    projectError = null,
    onToggleExpand,
    onRequestRename,
    onRequestRemove,
    onRequestAddWorktree,
    onSelectWorktree,
    onRequestRemoveWorktree,
    onWorktreeDraggingChange,
    onWorktreeReorder,
  }: {
    project: DndProject;
    isExpanded: boolean;
    selectedWorktreeId: string | null;
    localWorktree?: Worktree | null;
    worktrees: Worktree[];
    projectError?: string | null;
    onToggleExpand: () => void;
    onRequestRename: () => void;
    onRequestRemove: () => void;
    onRequestAddWorktree: () => void;
    onSelectWorktree: (id: string) => void;
    onRequestRemoveWorktree: (projectId: string, worktree: Worktree) => void;
    onWorktreeDraggingChange: (dragging: boolean) => void;
    onWorktreeReorder: (projectId: string, ids: string[]) => void;
  } = $props();

  function projectHeaderClass(props: Record<string, unknown>): string {
    const base = typeof props.class === "string" ? props.class : "";
    return `${base} relative overflow-visible flex items-center gap-2 px-2 py-1`;
  }
</script>

<Collapsible.Root
  open={isExpanded}
  onOpenChange={() => onToggleExpand()}
  class="group/collapsible"
>
  <Sidebar.MenuItem>
    <Collapsible.Trigger>
      {#snippet child({ props: triggerProps })}
        <Sidebar.MenuButton isActive={false} size="sm" {...triggerProps}>
          {#snippet child({ props })}
            <div
              {...props}
              class={projectHeaderClass(props)}
              data-project-header="true"
            >
              <div
                class="flex min-w-0 flex-1 items-center gap-2"
                use:dragHandle
              >
                <div class="flex items-center gap-2 truncate">
                  <FolderOpen
                    class="h-3.5 w-3.5 shrink-0
                      group-data-[state=closed]/collapsible:hidden"
                  />
                  <ChevronDown
                    class="hidden h-3.5 w-3.5 shrink-0
                      group-hover/collapsible:block
                      group-data-[state=closed]/collapsible:!hidden"
                  />
                  <Folder
                    class="hidden h-3.5 w-3.5 shrink-0
                      group-data-[state=closed]/collapsible:block
                      group-data-[state=closed]/collapsible:group-hover/collapsible:!hidden"
                  />
                  <ChevronRight
                    class="hidden h-3.5 w-3.5 shrink-0
                      group-data-[state=closed]/collapsible:group-hover/collapsible:!block"
                  />
                  <span class="truncate">{project.name}</span>
                </div>
                {#if projectError}
                  <span
                    class="rounded bg-destructive/15 px-1.5
                      py-0.5 text-[10px] text-destructive"
                  >
                    git error
                  </span>
                {/if}
              </div>
              <div
                class="ml-auto flex items-center gap-1
                  opacity-0 transition-opacity
                  group-hover/menu-item:opacity-100"
              >
                <ProjectActionMenu
                  onRename={() => onRequestRename()}
                  onRemove={() => onRequestRemove()}
                  onAddWorktree={() => onRequestAddWorktree()}
                />
              </div>
            </div>
          {/snippet}
        </Sidebar.MenuButton>
      {/snippet}
    </Collapsible.Trigger>

    <Collapsible.Content>
      <WorktreeList
        projectId={project.id}
        {worktrees}
        {localWorktree}
        {selectedWorktreeId}
        {projectError}
        {onSelectWorktree}
        {onRequestRemoveWorktree}
        onDraggingChange={onWorktreeDraggingChange}
        onReorder={onWorktreeReorder}
      />
    </Collapsible.Content>
  </Sidebar.MenuItem>
</Collapsible.Root>
