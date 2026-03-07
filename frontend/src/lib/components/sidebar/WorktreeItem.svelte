<script lang="ts">
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import { AlertTriangle, GripVertical, Trash2 } from "@lucide/svelte";
  import { dragHandle } from "svelte-dnd-action";
  import type { Worktree } from "$lib/types";

  let {
    worktree,
    isSelected,
    onSelect,
    onRequestRemove,
  }: {
    worktree: Worktree;
    isSelected: boolean;
    onSelect: () => void;
    onRequestRemove: () => void;
  } = $props();

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onSelect();
  }
</script>

<div class="group/worktree-item relative" data-worktree-drag-item="true">
  <div
    class="flex cursor-default select-none items-center gap-1
      rounded-md px-2 py-1 pr-8 text-sm transition-colors
      hover:bg-sidebar-accent
      {isSelected
      ? 'bg-sidebar-primary text-sidebar-primary-foreground'
      : 'text-sidebar-foreground/80'}"
  >
    <div
      use:dragHandle
      class="flex h-6 w-5 shrink-0 cursor-grab items-center
        justify-center text-sidebar-foreground/60 opacity-0
        transition-opacity
        group-hover/worktree-item:opacity-100
        active:cursor-grabbing"
      title="Drag to reorder"
    >
      <GripVertical class="h-3.5 w-3.5" />
    </div>
    <div
      class="flex min-w-0 flex-1 items-center text-left"
      role="button"
      tabindex="0"
      onclick={() => onSelect()}
      onkeydown={handleKeyDown}
    >
      <span class="truncate">{worktree.name}</span>
      {#if worktree.missing_on_disk}
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <span
                {...props}
                class="ml-2 inline-flex items-center text-destructive"
                aria-label="Worktree missing on disk"
              >
                <AlertTriangle class="h-3.5 w-3.5" />
              </span>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content side="top" align="center">
            This worktree was deleted outside Hubris. Remove it from Hubris to
            clear this entry.
          </Tooltip.Content>
        </Tooltip.Root>
      {/if}
    </div>
  </div>
  <button
    class="pointer-events-none absolute top-1/2 right-1 z-10 flex
      h-6 w-6 -translate-y-1/2 items-center justify-center
      rounded-md text-sidebar-foreground/70 opacity-0
      transition-[opacity,background-color,color]
      group-hover/worktree-item:pointer-events-auto
      group-hover/worktree-item:opacity-100
      hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    title="Delete worktree"
    onclick={(e) => {
      e.stopPropagation();
      onRequestRemove();
    }}
  >
    <Trash2 class="h-3.5 w-3.5" />
  </button>
</div>
