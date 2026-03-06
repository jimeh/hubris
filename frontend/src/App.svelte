<script lang="ts">
  import * as Breadcrumb from "$lib/components/ui/breadcrumb/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import AppSidebar from "$lib/components/AppSidebar.svelte";
  import SidebarResizeHandle from "$lib/components/SidebarResizeHandle.svelte";
  import WorktreeView from "$lib/components/WorktreeView.svelte";
  import { getProjectStore } from "$lib/stores/projects.svelte";
  import { getSidebarWidthStore } from "$lib/stores/sidebarWidth.svelte";
  import { getWorktreeStore } from "$lib/stores/worktrees.svelte";
  import { getTabStore } from "$lib/stores/tabs.svelte";
  import { getThemeStore } from "$lib/stores/theme.svelte";
  import { getTerminalStore } from "$lib/stores/terminal.svelte";
  import { getWorktreeSettingsStore } from "$lib/stores/worktreeSettings.svelte";
  import { getEventClient } from "$lib/events";

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

  // Derive the project for the currently selected worktree
  // so breadcrumbs can show "ProjectName > WorktreeName".
  const selectedProject = $derived(
    worktreeStore.selectedWorktree
      ? (projectStore.projects.find(
          (p) => p.id === worktreeStore.selectedWorktree!.project_id,
        ) ?? null)
      : null,
  );
</script>

<Sidebar.Provider
  class={sidebarWidthStore.isResizing ? "sidebar-resizing" : undefined}
  style="--sidebar-width: {sidebarWidthStore.width}px;"
>
  <AppSidebar {projectStore} {worktreeStore} />
  <SidebarResizeHandle />
  <Sidebar.Inset>
    <header class="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      <Sidebar.Trigger class="-ms-1" />
      <Separator
        orientation="vertical"
        class="me-2 data-[orientation=vertical]:h-4"
      />
      <Breadcrumb.Root>
        <Breadcrumb.List>
          {#if selectedProject}
            <Breadcrumb.Item class="hidden md:block">
              <Breadcrumb.Page>
                {selectedProject.name}
              </Breadcrumb.Page>
            </Breadcrumb.Item>
          {/if}
          {#if selectedProject && worktreeStore.selectedWorktree}
            <Breadcrumb.Separator class="hidden md:block" />
          {/if}
          {#if worktreeStore.selectedWorktree}
            <Breadcrumb.Item>
              <Breadcrumb.Page>
                {worktreeStore.selectedWorktree.name}
              </Breadcrumb.Page>
            </Breadcrumb.Item>
          {/if}
        </Breadcrumb.List>
      </Breadcrumb.Root>
    </header>
    <div class="flex flex-1 flex-col overflow-hidden">
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
  </Sidebar.Inset>
</Sidebar.Provider>
