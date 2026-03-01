<script lang="ts">
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import AddProjectDialog from './AddProjectDialog.svelte';
  import SettingsDialog from './SettingsDialog.svelte';
  import { Plus, Settings } from '@lucide/svelte';

  let { store } = $props();
  let showDialog = $state(false);
  let showSettings = $state(false);
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
        <Sidebar.Menu>
          {#each store.projects as project (project.id)}
            <Sidebar.MenuItem>
              <Sidebar.MenuButton
                isActive={store.selected?.id === project.id}
                onclick={() => store.select(project)}
              >
                {project.name}
              </Sidebar.MenuButton>
            </Sidebar.MenuItem>
          {/each}
        </Sidebar.Menu>
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
