<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';

  let {
    onAdd,
    onClose,
  }: {
    onAdd: (path: string) => Promise<void>;
    onClose: () => void;
  } = $props();

  let path = $state('');
  let submitting = $state(false);
  let error = $state('');

  async function submit() {
    if (!path.trim()) return;
    submitting = true;
    error = '';
    try {
      await onAdd(path.trim());
    } catch (e) {
      error = (e as Error).message;
    } finally {
      submitting = false;
    }
  }
</script>

<Dialog.Root
  open
  onOpenChange={(open) => {
    if (!open) onClose();
  }}
>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Add Project</Dialog.Title>
      <Dialog.Description>
        Enter the path to a local repository.
      </Dialog.Description>
    </Dialog.Header>
    <div class="grid gap-4 py-4">
      <input
        type="text"
        bind:value={path}
        placeholder="/home/user/repos/myproject"
        disabled={submitting}
        class="flex h-9 w-full rounded-md border border-input
               bg-transparent px-3 py-1 text-sm shadow-sm
               placeholder:text-muted-foreground
               focus-visible:outline-none focus-visible:ring-1
               focus-visible:ring-ring disabled:opacity-50"
        onkeydown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
      {#if error}
        <p class="text-sm text-destructive">{error}</p>
      {/if}
    </div>
    <Dialog.Footer>
      <Button
        variant="outline"
        onclick={onClose}
        disabled={submitting}
      >
        Cancel
      </Button>
      <Button
        onclick={submit}
        disabled={submitting || !path.trim()}
      >
        Add
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
