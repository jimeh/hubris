<script lang="ts">
  import { flip } from "svelte/animate";
  import { dndzone } from "svelte-dnd-action";
  import { SHADOW_ITEM_MARKER_PROPERTY_NAME } from "svelte-dnd-action";
  import { Button } from "$lib/components/ui/button/index.js";
  import TerminalTab from "./TerminalTab.svelte";
  import { getTabStore } from "$lib/stores/tabs.svelte";
  import { Plus, X } from "@lucide/svelte";
  import type { Tab, Worktree } from "$lib/types";

  type DndTab = Tab & {
    [SHADOW_ITEM_MARKER_PROPERTY_NAME]?: string;
  };

  const FLIP_MS = 150;

  let { worktree }: { worktree: Worktree } = $props();
  const tabStore = getTabStore();

  $effect(() => {
    tabStore.switchToWorktree(worktree.id);
  });

  let worktreeTabs = $derived(tabStore.tabsForWorktree(worktree.id));

  let dragging = $state(false);
  let dndItems = $state<DndTab[]>([]);

  $effect(() => {
    if (!dragging) {
      dndItems = worktreeTabs.map((t) => ({ ...t }));
    }
  });

  function handleConsider(
    e: CustomEvent<{ items: DndTab[] }>,
  ) {
    dragging = true;
    dndItems = e.detail.items;
  }

  function handleFinalize(
    e: CustomEvent<{ items: DndTab[] }>,
  ) {
    dndItems = e.detail.items;
    dragging = false;
    tabStore.reorder(
      worktree.id,
      e.detail.items.map((t) => t.id),
    );
  }
</script>

<div class="flex h-full flex-col">
  <div
    class="flex items-center border-b border-tab-border bg-tab-bar px-1 py-1"
  >
    <div
      class="flex items-center gap-1 overflow-x-auto"
      use:dndzone={{
        items: dndItems,
        flipDurationMs: FLIP_MS,
        type: `tabs-${worktree.id}`,
        dropTargetStyle: {},
        morphDisabled: true,
      }}
      onconsider={handleConsider}
      onfinalize={handleFinalize}
    >
      {#each dndItems as tab (tab.id)}
        <div
          animate:flip={{ duration: dragging ? FLIP_MS : 0 }}
          class="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors select-none
                 {tab.id === tabStore.activeTabId
            ? 'bg-tab-active text-tab-active-foreground shadow-sm'
            : 'text-tab-inactive-foreground hover:text-foreground'}"
          data-tab-drag-item="true"
          onclick={() => tabStore.activate(tab.id)}
          onkeydown={(e) => {
            if (e.key === "Enter") tabStore.activate(tab.id);
          }}
          role="tab"
          tabindex="0"
          aria-selected={tab.id === tabStore.activeTabId}
        >
          {tab.label}
          <button
            class="ml-1 rounded-sm opacity-60 hover:opacity-100"
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
    <Button
      variant="ghost"
      size="icon-sm"
      class="shrink-0"
      onclick={() => tabStore.addTerminal(worktree.id)}
    >
      <Plus class="h-4 w-4" />
    </Button>
  </div>

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

<style>
  :global(#dnd-action-dragged-el[data-tab-drag-item="true"]) {
    opacity: 0.5 !important;
    z-index: 60;
  }
</style>
