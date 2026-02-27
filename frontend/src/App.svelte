<script lang="ts">
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import AppSidebar from '$lib/components/AppSidebar.svelte';
  import ProjectView from '$lib/components/ProjectView.svelte';
  import { getProjectStore } from '$lib/stores/projects.svelte';

  const store = getProjectStore();
  store.refresh();
</script>

<Sidebar.Provider>
  <AppSidebar {store} />
  <main class="flex-1 overflow-hidden">
    <div class="flex h-screen flex-col">
      {#if store.selected}
        <ProjectView project={store.selected} />
      {:else}
        <div
          class="flex h-full items-center justify-center
                    text-muted-foreground"
        >
          <p>Select a project from the sidebar</p>
        </div>
      {/if}
    </div>
  </main>
</Sidebar.Provider>
