<script lang="ts">
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import { Ellipsis, Pencil, Plus, Trash2 } from "@lucide/svelte";

  let {
    onRename,
    onRemove,
    onAddWorktree,
  }: {
    onRename: () => void;
    onRemove: () => void;
    onAddWorktree: () => void;
  } = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="rounded p-1 text-sidebar-foreground/70
      transition-colors hover:bg-sidebar-foreground/12
      hover:text-sidebar-accent-foreground
      focus-visible:bg-sidebar-foreground/12"
    onclick={(e: MouseEvent) => e.stopPropagation()}
    title="Project actions"
  >
    <Ellipsis class="h-3.5 w-3.5" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="min-w-32">
    <DropdownMenu.Item onclick={() => onAddWorktree()}>
      <Plus class="mr-2 h-3.5 w-3.5" />
      New Worktree
    </DropdownMenu.Item>
    <DropdownMenu.Item onclick={() => onRename()}>
      <Pencil class="mr-2 h-3.5 w-3.5" />
      Rename
    </DropdownMenu.Item>
    <DropdownMenu.Separator />
    <DropdownMenu.Item
      class="text-destructive focus:text-destructive"
      onclick={() => onRemove()}
    >
      <Trash2 class="mr-2 h-3.5 w-3.5" />
      Remove
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
