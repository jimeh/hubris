<script lang="ts">
  import { flip } from "svelte/animate";
  import { dndzone } from "svelte-dnd-action";
  import { SHADOW_ITEM_MARKER_PROPERTY_NAME } from "svelte-dnd-action";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Plus, X, ChevronsLeft, ChevronsRight } from "@lucide/svelte";
  import { getTabStore } from "$lib/stores/tabs.svelte";
  import type { Tab } from "$lib/types";

  type DndTab = Tab & {
    [SHADOW_ITEM_MARKER_PROPERTY_NAME]?: string;
  };

  const FLIP_MS = 150;
  const SCROLL_AMOUNT = 200;

  let {
    worktreeId,
    tabs,
    activeTabId,
    onactivate,
    onclose,
    onadd,
  }: {
    worktreeId: string;
    tabs: Tab[];
    activeTabId: string | null;
    onactivate: (tabId: string) => void;
    onclose: (tabId: string) => void;
    onadd: () => void;
  } = $props();

  const tabStore = getTabStore();

  // DnD state
  let dragging = $state(false);
  let dndItems = $state<DndTab[]>([]);

  $effect(() => {
    if (!dragging) {
      dndItems = tabs.map((t) => ({ ...t }));
    }
  });

  // Scroll state
  let tabListEl = $state<HTMLDivElement | null>(null);
  let canScrollLeft = $state(false);
  let canScrollRight = $state(false);

  function updateScrollState() {
    if (!tabListEl) return;
    const { scrollLeft, scrollWidth, clientWidth } = tabListEl;
    canScrollLeft = scrollLeft > 0;
    canScrollRight = scrollLeft + clientWidth < scrollWidth - 1;
  }

  $effect(() => {
    if (!tabListEl) return;
    const observer = new ResizeObserver(() => updateScrollState());
    observer.observe(tabListEl);
    updateScrollState();
    return () => observer.disconnect();
  });

  // Auto-scroll to the right when tabs are added
  let prevTabCount = $state(tabs.length);
  $effect(() => {
    const count = dndItems.length;
    if (count > prevTabCount && tabListEl) {
      requestAnimationFrame(() => {
        tabListEl?.scrollTo({
          left: tabListEl.scrollWidth,
          behavior: "smooth",
        });
      });
    }
    prevTabCount = count;
  });

  // Re-evaluate scroll indicators when tab count changes
  $effect(() => {
    dndItems.length;
    requestAnimationFrame(() => updateScrollState());
  });

  function scrollTabs(direction: "left" | "right") {
    if (!tabListEl) return;
    const delta = direction === "left" ? -SCROLL_AMOUNT : SCROLL_AMOUNT;
    tabListEl.scrollBy({ left: delta, behavior: "smooth" });
  }

  function handleConsider(e: CustomEvent<{ items: DndTab[] }>) {
    dragging = true;
    dndItems = e.detail.items;
  }

  function handleFinalize(e: CustomEvent<{ items: DndTab[] }>) {
    dndItems = e.detail.items;
    dragging = false;
    tabStore.reorder(
      worktreeId,
      e.detail.items.map((t) => t.id),
    );
  }
</script>

<div
  class="flex min-h-9 items-center border-b border-tab-border bg-tab-bar px-1"
>
  <div class="relative min-w-0 flex-1">
    {#if canScrollLeft}
      <button
        class="absolute top-0 bottom-0 left-0 z-10 flex w-6 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground"
        style="background: linear-gradient(to right, var(--tab-bar) 40%, transparent);"
        onclick={() => scrollTabs("left")}
      >
        <ChevronsLeft class="h-3.5 w-3.5" />
      </button>
    {/if}
    <div
      bind:this={tabListEl}
      class="flex items-center gap-1 overflow-x-auto overflow-y-hidden"
      data-tab-dragging={dragging || undefined}
      onscroll={updateScrollState}
      use:dndzone={{
        items: dndItems,
        flipDurationMs: FLIP_MS,
        type: `tabs-${worktreeId}`,
        dropTargetStyle: {},
        morphDisabled: true,
      }}
      onconsider={handleConsider}
      onfinalize={handleFinalize}
    >
      {#each dndItems as tab (tab.id)}
        <div
          animate:flip={{ duration: dragging ? FLIP_MS : 0 }}
          class="inline-flex cursor-default items-center gap-1.5 whitespace-nowrap pl-3 pr-2.5 py-2 text-sm transition-colors select-none
                 {tab.id === activeTabId
            ? 'bg-tab-active text-tab-active-foreground shadow-[inset_0_-2px_0_var(--tab-active-border)]'
            : 'text-tab-inactive-foreground hover:text-foreground'}"
          data-tab-drag-item="true"
          onclick={() => onactivate(tab.id)}
          onkeydown={(e) => {
            if (e.key === "Enter") onactivate(tab.id);
          }}
          role="tab"
          tabindex="0"
          aria-selected={tab.id === activeTabId}
        >
          {tab.label}
          <button
            class="rounded-sm opacity-60 hover:opacity-100"
            onclick={(e) => {
              e.stopPropagation();
              onclose(tab.id);
            }}
          >
            <X class="h-3 w-3" />
          </button>
        </div>
      {/each}
    </div>
    {#if canScrollRight}
      <button
        class="absolute top-0 right-0 bottom-0 z-10 flex w-6 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground"
        style="background: linear-gradient(to left, var(--tab-bar) 40%, transparent);"
        onclick={() => scrollTabs("right")}
      >
        <ChevronsRight class="h-3.5 w-3.5" />
      </button>
    {/if}
  </div>
  <Button variant="ghost" size="icon-sm" class="shrink-0" onclick={onadd}>
    <Plus class="h-4 w-4" />
  </Button>
</div>

<style>
  /* Hide scrollbar on the tab list since we have chevron indicators */
  div[data-tab-dragging],
  div:has(> [data-tab-drag-item]) {
    scrollbar-width: none;
  }
  div[data-tab-dragging]::-webkit-scrollbar,
  div:has(> [data-tab-drag-item])::-webkit-scrollbar {
    display: none;
  }

  /* Override svelte-dnd-action's inline cursor: grab */
  :global([data-tab-drag-item]) {
    cursor: default !important;
  }

  /* Suppress hover states on tabs while dragging */
  :global([data-tab-dragging] [data-tab-drag-item]),
  :global([data-tab-dragging] [data-tab-drag-item] *) {
    pointer-events: none !important;
  }

  :global(#dnd-action-dragged-el[data-tab-drag-item="true"]) {
    opacity: 0.5 !important;
    z-index: 60;
    pointer-events: none !important;
    outline: none !important;
    box-shadow: none !important;
  }
</style>
