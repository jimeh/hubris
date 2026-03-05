<script lang="ts">
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import AppSidebar from '$lib/components/AppSidebar.svelte';
  import SidebarResizeHandle from '$lib/components/SidebarResizeHandle.svelte';
  import WorktreeView from '$lib/components/WorktreeView.svelte';
  import { getProjectStore } from '$lib/stores/projects.svelte';
  import { getSidebarWidthStore } from '$lib/stores/sidebarWidth.svelte';
  import { getWorktreeStore } from '$lib/stores/worktrees.svelte';
  import { getTabStore } from '$lib/stores/tabs.svelte';
  import { getThemeStore } from '$lib/stores/theme.svelte';
  import { getTerminalStore } from '$lib/stores/terminal.svelte';
  import { getWorktreeSettingsStore } from '$lib/stores/worktreeSettings.svelte';
  import { getEventClient } from '$lib/events';

  // Initialize stores BEFORE SSE connect so handlers are
  // registered before the snapshot arrives on connect.
  const projectStore = getProjectStore();
  const sidebarWidthStore = getSidebarWidthStore();
  const worktreeStore = getWorktreeStore();

  // Initialize theme store (loads settings + applies theme)
  const themeStore = getThemeStore();
  themeStore.init();

  // Initialize terminal store (loads font settings)
  const terminalStore = getTerminalStore();
  terminalStore.init();
  const worktreeSettingsStore = getWorktreeSettingsStore();
  worktreeSettingsStore.init();

  getTabStore();

  // Start SSE event stream for state sync
  const events = getEventClient();
  events.connect();
</script>

<Sidebar.Provider
  class={sidebarWidthStore.isResizing ? 'sidebar-resizing' : undefined}
  style="--sidebar-width: {sidebarWidthStore.width}px;"
>
  <AppSidebar {projectStore} {worktreeStore} />
  <SidebarResizeHandle />
  <main class="flex-1 overflow-hidden">
    <div class="flex h-screen flex-col">
      {#if worktreeStore.selectedWorktree}
        <WorktreeView worktree={worktreeStore.selectedWorktree} />
      {:else}
        <div
          class="flex h-full items-center justify-center
                    text-muted-foreground"
        >
          <p>Select a worktree from the sidebar</p>
        </div>
      {/if}
    </div>
  </main>
</Sidebar.Provider>
