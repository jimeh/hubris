<script lang="ts">
  import { onMount } from 'svelte';
  import { AlertTriangle, RefreshCw } from '@lucide/svelte';
  import {
    listProjectWorktreeStartPoints,
    type WorktreeStartPoint,
  } from '$lib/api';
  import { generateWorktreeBranchName } from '$lib/worktreeName';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';

  let {
    projectId,
    projectName,
    onAdd,
    onClose,
  }: {
    projectId: string;
    projectName: string;
    onAdd: (branch: string, startPoint?: string) => Promise<void>;
    onClose: () => void;
  } = $props();

  let branch = $state('');
  let suggestedBranch = $state(generateWorktreeBranchName());
  let startPoint = $state('');
  let startPoints = $state<WorktreeStartPoint[]>([]);
  let defaultStartPoint = $state('');
  let startPointWarning = $state('');
  let submitting = $state(false);
  let error = $state('');
  const startPointDatalistId = $derived(`worktree-start-points-${projectId}`);

  onMount(() => {
    void loadStartPoints();
  });

  async function loadStartPoints(): Promise<void> {
    startPointWarning = '';
    try {
      const response = await listProjectWorktreeStartPoints(projectId);
      startPoints = response.start_points;
      defaultStartPoint = response.default_start_point?.trim() ?? '';
      if (!startPoint.trim() && defaultStartPoint) {
        startPoint = defaultStartPoint;
      }
      if (response.git_error) {
        startPointWarning = response.git_error;
      }
    } catch (err) {
      startPointWarning = `Failed to load branches (${(err as Error).message})`;
      startPoints = [];
      defaultStartPoint = '';
    }
  }

  function rerollSuggestedBranch(): void {
    suggestedBranch = generateWorktreeBranchName(suggestedBranch);
  }

  async function submit() {
    const effectiveBranch = branch.trim() || suggestedBranch;
    const effectiveStartPoint =
      startPoint.trim() || defaultStartPoint || undefined;
    if (!effectiveBranch) {
      return;
    }

    submitting = true;
    error = '';
    try {
      await onAdd(effectiveBranch, effectiveStartPoint);
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
      <div class="space-y-1.5">
        <label for="new-worktree-branch" class="text-sm font-medium">
          Branch name
        </label>
        <div class="flex items-center gap-2">
          <Input
            id="new-worktree-branch"
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
      </div>

      <div class="space-y-1.5">
        <label for="new-worktree-start-point" class="text-sm font-medium">
          Start from
        </label>
        <Input
          id="new-worktree-start-point"
          type="text"
          bind:value={startPoint}
          list={startPointDatalistId}
          placeholder={defaultStartPoint || 'HEAD'}
          disabled={submitting}
          onkeydown={(e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              submit();
            }
          }}
        />
        <datalist id={startPointDatalistId}>
          {#each startPoints as option (option.value)}
            <option
              value={option.value}
              label={option.kind === 'local' ? 'Local' : 'Remote'}
            ></option>
          {/each}
        </datalist>
      </div>

      {#if startPointWarning}
        <p class="flex items-center gap-1.5 text-xs text-amber-600">
          <AlertTriangle class="h-3.5 w-3.5 shrink-0" />
          {startPointWarning}
        </p>
      {/if}

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
