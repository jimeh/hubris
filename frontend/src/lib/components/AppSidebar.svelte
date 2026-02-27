<script lang="ts">
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import AddProjectDialog from './AddProjectDialog.svelte';
  import { Plus } from '@lucide/svelte';

  let { store } = $props();
  let showDialog = $state(false);
</script>

<Sidebar.Root>
  <Sidebar.Header>
    <h2 class="px-2 text-lg font-semibold">Projects</h2>
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
  <Sidebar.Footer>
    <Button
      variant="outline"
      class="w-full"
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
