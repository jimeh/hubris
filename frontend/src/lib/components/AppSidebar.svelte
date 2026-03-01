<script lang="ts">
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import AddProjectDialog from './AddProjectDialog.svelte';
  import SettingsDialog from './SettingsDialog.svelte';
  import { Plus, Settings, X } from '@lucide/svelte';
  import { dndzone, SHADOW_ITEM_MARKER_PROPERTY_NAME } from 'svelte-dnd-action';
  import type { Project } from '$lib/types';

  let { store } = $props();
  let showDialog = $state(false);
  let showSettings = $state(false);

  const FLIP_MS = 150;

  type DndProject = Project & {
    [SHADOW_ITEM_MARKER_PROPERTY_NAME]?: string;
  };

  let dragging = $state(false);
  let dndItems = $state<DndProject[]>([]);

  // Sync dndItems from store when not dragging
  $effect(() => {
    if (!dragging) {
      dndItems = store.projects.map((p: Project) => ({
        ...p,
      }));
    }
  });

  function handleConsider(e: CustomEvent<{ items: DndProject[] }>) {
    dragging = true;
    dndItems = e.detail.items;
  }

  function handleFinalize(e: CustomEvent<{ items: DndProject[] }>) {
    dndItems = e.detail.items;
    dragging = false;
    store.reorder(dndItems.map((p) => p.id));
  }

  function removeProject(e: MouseEvent, id: string) {
    e.stopPropagation();
    store.remove(id);
  }
</script>

<Sidebar.Root>
  <Sidebar.Header>
    <div class="flex items-center justify-between px-2">
      <h2 class="text-lg font-semibold">Projects</h2>
      <Button
        variant="ghost"
        size="icon-sm"
        onclick={() => (showSettings = true)}
        title="Settings"
      >
        <Settings class="h-4 w-4" />
      </Button>
    </div>
  </Sidebar.Header>
  <Sidebar.Content>
    <Sidebar.Group>
      <Sidebar.GroupContent>
        <div
          class="flex w-full min-w-0 flex-col gap-1"
          use:dndzone={{
            items: dndItems,
            flipDurationMs: FLIP_MS,
            type: 'projects',
            dropTargetStyle: {},
          }}
          onconsider={handleConsider}
          onfinalize={handleFinalize}
        >
          {#each dndItems as project (project.id)}
            <div
              class="group/menu-item relative"
              class:shadow-item={project[SHADOW_ITEM_MARKER_PROPERTY_NAME]}
            >
              <Sidebar.MenuButton
                isActive={store.selected?.id === project.id}
                onclick={() => store.select(project)}
                class={dragging ? 'cursor-grabbing' : 'cursor-grab'}
              >
                {#snippet child({ props })}
                  <!-- Render as div, not button — button.value
                       triggers svelte-dnd-action's input guard,
                       preventing drag initiation -->
                  <div {...props}>{project.name}</div>
                {/snippet}
              </Sidebar.MenuButton>
              <Sidebar.MenuAction
                showOnHover
                onclick={(e: MouseEvent) => removeProject(e, project.id)}
              >
                <X class="h-3 w-3" />
              </Sidebar.MenuAction>
            </div>
          {/each}
        </div>
      </Sidebar.GroupContent>
    </Sidebar.Group>
  </Sidebar.Content>
  <Sidebar.Separator />
  <Sidebar.Footer>
    <Button
      variant="ghost"
      class="w-full text-muted-foreground"
      onclick={() => (showDialog = true)}
    >
      <Plus class="mr-2 h-4 w-4" />
      Add Project
    </Button>
  </Sidebar.Footer>
</Sidebar.Root>

{#if showDialog}
  <AddProjectDialog
    onAdd={async (path) => {
      await store.add(path);
      showDialog = false;
    }}
    onClose={() => (showDialog = false)}
  />
{/if}

<SettingsDialog bind:open={showSettings} />

<style>
  :global(.shadow-item) {
    opacity: 0.4;
    border: 1px dashed var(--sidebar-border);
    border-radius: var(--radius);
  }
</style>
