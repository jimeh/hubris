<script lang="ts">
  import Folder from "@lucide/svelte/icons/folder";
  import FolderX from "@lucide/svelte/icons/folder-x";
  import GitBranchPlus from "@lucide/svelte/icons/git-branch-plus";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";

  let {
    projectName,
    forceManagedDelete = false,
    onRemoveOnly,
    onRemoveAndDeleteManaged,
    onClose,
  }: {
    projectName: string;
    forceManagedDelete?: boolean;
    onRemoveOnly: () => void;
    onRemoveAndDeleteManaged: () => void;
    onClose: () => void;
  } = $props();
</script>

<Dialog.Root
  open
  onOpenChange={(open) => {
    if (!open) onClose();
  }}
>
  <Dialog.Content class="sm:max-w-xl">
    <Dialog.Header class="gap-3">
      <div class="flex items-start gap-3">
        <div
          class="mt-0.5 rounded-xl border border-destructive/20 bg-destructive/8 p-2 text-destructive"
        >
          {#if forceManagedDelete}
            <ShieldAlert class="h-4 w-4" />
          {:else}
            <FolderX class="h-4 w-4" />
          {/if}
        </div>
        <div class="space-y-1">
          <Dialog.Title>
            {forceManagedDelete ? "Force remove project" : "Remove project"}
          </Dialog.Title>
          <Dialog.Description>
            {#if forceManagedDelete}
              <span class="font-medium text-foreground">{projectName}</span> has Hubris-managed
              worktrees with uncommitted changes or a busy state.
            {:else}
              Choose how Hubris should remove
              <span class="font-medium text-foreground">{projectName}</span>.
            {/if}
          </Dialog.Description>
        </div>
      </div>
    </Dialog.Header>

    <div class="grid gap-3">
      <section class="rounded-xl border bg-muted/25 p-4">
        <div class="flex items-start gap-3">
          <div
            class="rounded-lg border bg-background p-2 text-muted-foreground"
          >
            <Folder class="h-4 w-4" />
          </div>
          <div class="min-w-0 flex-1 space-y-1">
            <h3 class="text-sm font-semibold">Remove only</h3>
            <p class="text-sm text-muted-foreground">
              Remove the project from Hubris and leave all worktrees and
              directories on disk.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          class="mt-4 w-full justify-center"
          onclick={onRemoveOnly}>Remove only</Button
        >
      </section>

      <section
        class="rounded-xl border border-destructive/20 bg-destructive/6 p-4"
      >
        <div class="flex items-start gap-3">
          <div
            class="rounded-lg border border-destructive/20 bg-background p-2 text-destructive"
          >
            <GitBranchPlus class="h-4 w-4" />
          </div>
          <div class="min-w-0 flex-1 space-y-1">
            <h3 class="text-sm font-semibold text-foreground">
              {#if forceManagedDelete}
                Force remove and delete managed worktrees
              {:else}
                Remove and delete managed worktrees
              {/if}
            </h3>
            <p class="text-sm text-muted-foreground">
              Delete only Hubris-managed worktrees for this project. Git-linked
              worktrees outside Hubris are left alone.
            </p>
          </div>
        </div>
        <Button
          variant="destructive"
          class="mt-4 w-full justify-center"
          onclick={onRemoveAndDeleteManaged}
        >
          {#if forceManagedDelete}
            Force remove + delete managed worktrees
          {:else}
            Remove + delete managed worktrees
          {/if}
        </Button>
      </section>
    </div>

    <Dialog.Footer>
      <Button variant="ghost" onclick={onClose}>Cancel</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
