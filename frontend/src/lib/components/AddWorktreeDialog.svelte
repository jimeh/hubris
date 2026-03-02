<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';

  let {
    projectName,
    onAdd,
    onClose,
  }: {
    projectName: string;
    onAdd: (branch: string) => Promise<void>;
    onClose: () => void;
  } = $props();

  let branch = $state('');
  let submitting = $state(false);
  let error = $state('');

  async function submit() {
    const trimmed = branch.trim();
    if (!trimmed) {
      return;
    }

    submitting = true;
    error = '';
    try {
      await onAdd(trimmed);
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
      <Dialog.Title>New Worktree</Dialog.Title>
      <Dialog.Description>
        Create a new linked worktree for {projectName} from a new branch.
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-3 py-2">
      <Input
        type="text"
        bind:value={branch}
        placeholder="feature/my-branch"
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
      <Button onclick={submit} disabled={submitting || !branch.trim()}>
        Create
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
