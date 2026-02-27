<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import TerminalTab from './TerminalTab.svelte';
  import { getTabStore } from '$lib/stores/tabs.svelte';
  import { Plus, X } from '@lucide/svelte';
  import type { Project } from '$lib/types';

  let { project }: { project: Project } = $props();
  const tabStore = getTabStore();

  // Reset tabs when project changes
  $effect(() => {
    project; // track
    tabStore.reset();
  });
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center border-b bg-muted/40 px-2">
    {#if tabStore.tabs.length > 0}
      <div
        class="flex items-center gap-1 overflow-x-auto py-1"
      >
        {#each tabStore.tabs as tab (tab.id)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="inline-flex cursor-pointer items-center
                   gap-1.5 rounded-md px-3 py-1.5 text-sm
                   transition-colors select-none
                   {tab.id === tabStore.activeTabId
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'}"
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
              class="ml-1 rounded-sm opacity-60
                     hover:opacity-100"
              onclick={(e) => {
                e.stopPropagation();
                tabStore.close(tab.id);
              }}
            >
              <X class="h-3 w-3" />
            </button>
          </div>
        {/each}
      </div>
    {/if}
    <Button
      variant="ghost"
      size="icon-sm"
      class="ml-1 shrink-0"
      onclick={() => tabStore.addTerminal()}
    >
      <Plus class="h-4 w-4" />
    </Button>
  </div>

  <div class="relative flex-1 overflow-hidden">
    {#each tabStore.tabs as tab (tab.id)}
      <div
        class="absolute inset-0"
        class:hidden={tab.id !== tabStore.activeTabId}
      >
        {#if tab.type === 'terminal'}
          <TerminalTab
            projectId={project.id}
            visible={tab.id === tabStore.activeTabId}
          />
        {/if}
      </div>
    {/each}
    {#if tabStore.tabs.length === 0}
      <div
        class="flex h-full items-center justify-center
                  text-muted-foreground"
      >
        <p>Click + to open a terminal</p>
      </div>
    {/if}
  </div>
</div>
