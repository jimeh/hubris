<script lang="ts">
  import { RefreshCw } from '@lucide/svelte';
  import { generateWorktreeBranchName } from '$lib/worktreeName';
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
  let suggestedBranch = $state(generateWorktreeBranchName());
  let submitting = $state(false);
  let error = $state('');

  function rerollSuggestedBranch(): void {
    suggestedBranch = generateWorktreeBranchName(suggestedBranch);
  }

  async function submit() {
    const effectiveBranch = branch.trim() || suggestedBranch;
    if (!effectiveBranch) {
      return;
    }

    submitting = true;
    error = '';
    try {
      await onAdd(effectiveBranch);
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
      <div class="flex items-center gap-2">
        <Input
          type="text"
          bind:value={branch}
          placeholder={suggestedBranch}
          class="flex-1"
          disabled={submitting}
          onkeydown={(e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              submit();
            }
          }}
        />
        <Button
          variant="outline"
          size="icon-sm"
          title="Generate another name"
          aria-label="Generate another name"
          disabled={submitting}
          onclick={rerollSuggestedBranch}
        >
          <RefreshCw class="h-4 w-4" />
        </Button>
      </div>

      {#if error}
        <p class="text-sm text-destructive">{error}</p>
      {/if}
    </div>

    <Dialog.Footer>
      <Button variant="outline" onclick={onClose} disabled={submitting}>
        Cancel
      </Button>
      <Button onclick={submit} disabled={submitting}>Create</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
