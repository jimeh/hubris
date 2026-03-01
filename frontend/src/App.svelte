<script lang="ts">
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import AppSidebar from '$lib/components/AppSidebar.svelte';
  import ProjectView from '$lib/components/ProjectView.svelte';
  import { getProjectStore } from '$lib/stores/projects.svelte';
  import { getTabStore } from '$lib/stores/tabs.svelte';
  import { getThemeStore } from '$lib/stores/theme.svelte';
  import { getTerminalStore } from '$lib/stores/terminal.svelte';
  import { getEventClient } from '$lib/events';

  // Initialize stores BEFORE SSE connect so handlers are
  // registered before the snapshot arrives on connect.
  const store = getProjectStore();

  // Initialize theme store (loads settings + applies theme)
  const themeStore = getThemeStore();
  themeStore.init();

  // Initialize terminal store (loads font settings)
  const terminalStore = getTerminalStore();
  terminalStore.init();

  getTabStore();

  // Start SSE event stream for state sync
  const events = getEventClient();
  events.connect();
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
