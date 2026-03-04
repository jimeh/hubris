<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';

  let {
    currentName,
    onRename,
    onClose,
  }: {
    currentName: string;
    onRename: (name: string) => Promise<void>;
    onClose: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let name = $state(currentName);
  let submitting = $state(false);
  let error = $state('');

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === currentName) {
      onClose();
      return;
    }

    submitting = true;
    error = '';

    try {
      await onRename(trimmed);
      onClose();
    } catch (err) {
      error = (err as Error).message;
      submitting = false;
    }
  }
</script>

<Dialog.Root
  open
  onOpenChange={(open) => {
    if (!open) {
      onClose();
    }
  }}
>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Rename Project</Dialog.Title>
      <Dialog.Description>Update the project display name.</Dialog.Description>
    </Dialog.Header>

    <div class="space-y-3 py-2">
      <Input
        type="text"
        bind:value={name}
        placeholder="Project name"
        disabled={submitting}
        onkeydown={(e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            submit();
          }
        }}
      />
      {#if error}
        <p class="text-sm text-destructive">{error}</p>
      {/if}
    </div>

    <Dialog.Footer>
      <Button variant="outline" onclick={onClose} disabled={submitting}>
        Cancel
      </Button>
      <Button onclick={submit} disabled={submitting || !name.trim()}>
        Rename
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
