<script lang="ts">
  import { dragHandleZone } from "svelte-dnd-action";
  import { flip } from "svelte/animate";
  import type { Worktree } from "$lib/types";
  import type { DndWorktree } from "./types.js";
  import LocalWorktreeItem from "./LocalWorktreeItem.svelte";
  import WorktreeItem from "./WorktreeItem.svelte";

  const FLIP_MS = 150;

  let {
    projectId,
    worktrees,
    localWorktree = null,
    selectedWorktreeId,
    projectError = null,
    onSelectWorktree,
    onRequestRemoveWorktree,
    onDraggingChange,
    onReorder,
  }: {
    projectId: string;
    worktrees: Worktree[];
    localWorktree?: Worktree | null;
    selectedWorktreeId: string | null;
    projectError?: string | null;
    onSelectWorktree: (id: string) => void;
    onRequestRemoveWorktree: (projectId: string, worktree: Worktree) => void;
    onDraggingChange: (dragging: boolean) => void;
    onReorder: (projectId: string, ids: string[]) => void;
  } = $props();

  let dragging = $state(false);
  let dndItems = $state<DndWorktree[]>([]);

  $effect(() => {
    if (!dragging) {
      dndItems = worktrees
        .filter((wt: Worktree) => !wt.is_local)
        .map((wt: Worktree) => ({ ...wt }));
    }
  });

  function handleConsider(e: CustomEvent<{ items: DndWorktree[] }>) {
    dragging = true;
    onDraggingChange(true);
    dndItems = e.detail.items;
  }

  function handleFinalize(e: CustomEvent<{ items: DndWorktree[] }>) {
    dndItems = e.detail.items;
    dragging = false;
    onDraggingChange(false);
    onReorder(
      projectId,
      e.detail.items.map((wt) => wt.id),
    );
  }
</script>

<div
  class="mt-1 space-y-1"
  role="presentation"
  onmousedown={(e) => e.stopPropagation()}
  ontouchstart={(e) => e.stopPropagation()}
>
  {#if localWorktree}
    <LocalWorktreeItem
      isSelected={selectedWorktreeId === localWorktree.id}
      onSelect={() => onSelectWorktree(localWorktree!.id)}
    />
  {/if}

  <div
    use:dragHandleZone={{
      items: dndItems,
      flipDurationMs: FLIP_MS,
      type: `worktrees-${projectId}`,
      dropTargetStyle: {},
      centreDraggedOnCursor: false,
      useCursorForDetection: true,
      morphDisabled: true,
    }}
    onconsider={handleConsider}
    onfinalize={handleFinalize}
    class="space-y-1"
  >
    {#each dndItems as worktree (worktree.id)}
      <div animate:flip={{ duration: dragging ? FLIP_MS : 0 }}>
        <WorktreeItem
          {worktree}
          isSelected={selectedWorktreeId === worktree.id}
          onSelect={() => onSelectWorktree(worktree.id)}
          onRequestRemove={() => onRequestRemoveWorktree(projectId, worktree)}
        />
      </div>
    {/each}
  </div>

  {#if projectError}
    <p class="px-2 pb-1 text-xs text-destructive">
      {projectError}
    </p>
  {/if}
</div>
