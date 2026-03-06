<script lang="ts">
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Plus, Settings } from "@lucide/svelte";
  import {
    createDialogState,
    type ProjectStore,
    type WorktreeStore,
  } from "./sidebar/types.js";
  import ProjectList from "./sidebar/ProjectList.svelte";
  import SidebarDialogs from "./sidebar/SidebarDialogs.svelte";

  let {
    projectStore,
    worktreeStore,
  }: {
    projectStore: ProjectStore;
    worktreeStore: WorktreeStore;
  } = $props();

  let dialogState = $state(createDialogState());
</script>

<Sidebar.Root>
  <Sidebar.Header>
    <div class="flex items-center justify-between px-2">
      <h2 class="text-lg font-semibold">Projects</h2>
      <Button
        variant="ghost"
        size="icon-sm"
        onclick={() => (dialogState.showSettings = true)}
        title="Settings"
      >
        <Settings class="h-4 w-4" />
      </Button>
    </div>
  </Sidebar.Header>

  <Sidebar.Content>
    <ProjectList {projectStore} {worktreeStore} {dialogState} />
  </Sidebar.Content>

  <Sidebar.Separator />

  <Sidebar.Footer>
    <Button
      variant="ghost"
      class="w-full text-muted-foreground"
      onclick={() => (dialogState.addProject = true)}
    >
      <Plus class="mr-2 h-4 w-4" />
      Add Project
    </Button>
  </Sidebar.Footer>
  {#if dialogState.actionError}
    <p class="px-2 pb-2 text-xs text-destructive">
      {dialogState.actionError}
    </p>
  {/if}
</Sidebar.Root>

<SidebarDialogs {dialogState} {projectStore} {worktreeStore} />

<style>
  :global(
    #dnd-action-dragged-el[data-project-drag-item="true"],
    #dnd-action-dragged-el[data-worktree-drag-item="true"]
  ) {
    opacity: 0.5 !important;
    z-index: 60 !important;
    pointer-events: none !important;
    border-radius: var(--radius);
    outline: none !important;
    box-shadow: none !important;
  }

  /* Suppress hover states on sidebar items while dragging */
  :global([data-sidebar-dragging] [data-project-drag-item]),
  :global([data-sidebar-dragging] [data-project-drag-item] *),
  :global([data-sidebar-dragging] [data-worktree-drag-item]),
  :global([data-sidebar-dragging] [data-worktree-drag-item] *) {
    pointer-events: none !important;
  }
</style>
