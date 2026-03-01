<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import TerminalTab from './TerminalTab.svelte';
  import { getTabStore } from '$lib/stores/tabs.svelte';
  import { Plus, X } from '@lucide/svelte';
  import type { Project } from '$lib/types';

  let { project }: { project: Project } = $props();
  const tabStore = getTabStore();

  // Switch active tab when project changes
  $effect(() => {
    tabStore.switchToProject(project.id);
  });

  let projectTabs = $derived(
    tabStore.tabsForProject(project.id),
  );
</script>

<div class="flex h-full flex-col">
  <div class="flex min-h-9 items-stretch border-b bg-muted/30">
    {#if projectTabs.length > 0}
      <div
        class="flex items-stretch overflow-x-auto"
        role="tablist"
      >
        {#each projectTabs as tab, i (tab.id)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          {#if i > 0}
            <div class="my-2 w-px bg-border"></div>
          {/if}
          <div
            class="relative inline-flex items-center
                   gap-1.5 pl-4 pr-3 py-2 text-sm
                   transition-colors select-none
                   {tab.id === tabStore.activeTabId
              ? 'text-foreground bg-background'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}"
            onclick={() => tabStore.activate(tab.id)}
            onkeydown={(e) => {
              if (e.key === 'Enter') tabStore.activate(tab.id);
            }}
            role="tab"
            tabindex="0"
            aria-selected={tab.id === tabStore.activeTabId}
          >
            {tab.label}
            <button
              class="ml-1 rounded p-0.5 opacity-50
                     hover:opacity-100 hover:bg-muted
                     focus-visible:opacity-100 focus-visible:ring-1
                     focus-visible:ring-ring
                     transition-all"
              aria-label="Close tab"
              onclick={(e) => {
                e.stopPropagation();
                tabStore.close(tab.id);
              }}
            >
              <X class="h-3 w-3" />
            </button>
            {#if tab.id === tabStore.activeTabId}
              <div class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary"></div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    <div class="my-2 w-px bg-border"></div>
    <Button
      variant="ghost"
      size="icon-sm"
      class="shrink-0 rounded-none"
      aria-label="New tab"
      onclick={() => tabStore.addTerminal(project.id)}
    >
      <Plus class="h-4 w-4" />
    </Button>
  </div>

  <div class="relative flex-1 overflow-hidden">
    {#each projectTabs as tab (tab.id)}
      <div
        class="absolute inset-0"
        class:hidden={tab.id !== tabStore.activeTabId}
      >
        {#if tab.type === 'terminal'}
          <TerminalTab
            tabId={tab.id}
            visible={tab.id === tabStore.activeTabId}
            onclosed={() => tabStore.removeLocal(tab.id)}
          />
        {/if}
      </div>
    {/each}
    {#if projectTabs.length === 0}
      <div
        class="flex h-full items-center justify-center
                  text-muted-foreground"
      >
        <p>Click + to open a terminal</p>
      </div>
    {/if}
  </div>
</div>
