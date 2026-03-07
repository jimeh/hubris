<script lang="ts">
  import TabBar from "./TabBar.svelte";
  import TerminalTab from "./TerminalTab.svelte";
  import { getTabStore } from "$lib/stores/tabs.svelte";
  import type { Worktree } from "$lib/types";

  let { worktree }: { worktree: Worktree } = $props();
  const tabStore = getTabStore();

  $effect(() => {
    tabStore.switchToWorktree(worktree.id);
  });

  let worktreeTabs = $derived(tabStore.tabsForWorktree(worktree.id));
</script>

<div class="flex h-full min-w-0 flex-col">
  <TabBar
    worktreeId={worktree.id}
    tabs={worktreeTabs}
    activeTabId={tabStore.activeTabId}
    onactivate={(id) => tabStore.activate(id)}
    onclose={(id) => tabStore.close(id)}
    onadd={() => tabStore.addTerminal(worktree.id)}
  />

  <div class="relative flex-1 overflow-hidden">
    {#each worktreeTabs as tab (tab.id)}
      <div
        class="absolute inset-0"
        class:hidden={tab.id !== tabStore.activeTabId}
      >
        {#if tab.type === "terminal"}
          <TerminalTab
            tabId={tab.id}
            visible={tab.id === tabStore.activeTabId}
            onclosed={() => tabStore.removeLocal(tab.id)}
          />
        {/if}
      </div>
    {/each}
    {#if worktreeTabs.length === 0}
      <div
        class="flex h-full items-center justify-center text-muted-foreground"
      >
        <p>Click + to open a terminal</p>
      </div>
    {/if}
  </div>
</div>
