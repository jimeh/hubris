<script lang="ts">
  import { onMount } from 'svelte';
  import {
    AlertTriangle,
    ChevronsUpDown,
    GitBranch,
    RefreshCw,
    Sparkles,
  } from '@lucide/svelte';
  import {
    listProjectWorktreeStartPoints,
    type WorktreeStartPoint,
  } from '$lib/api';
  import { getThemeStore } from '$lib/stores/theme.svelte';
  import { deterministicTagStyle } from '$lib/theme/deterministicTagColor';
  import { generateWorktreeBranchName } from '$lib/worktreeName';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import * as Command from '$lib/components/ui/command/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import * as Popover from '$lib/components/ui/popover/index.js';

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
  let startPointPopoverOpen = $state(false);
  let selectedStartPointValue = $state('');
  let useCustomStartPoint = $state(false);
  let customStartPoint = $state('');
  let startPoints = $state<WorktreeStartPoint[]>([]);
  let defaultStartPoint = $state('');
  let startPointWarning = $state('');
  let submitting = $state(false);
  let error = $state('');
  const themeStore = getThemeStore();
  const themeVersion = $derived(themeStore.version);
  const branchBadgeClass =
    'deterministic-tag-badge max-w-full truncate text-xs';

  function branchColorKey(
    ref: string,
    kind: 'local' | 'remote' = 'local',
  ): string {
    const trimmed = ref.trim();
    if (!trimmed) {
      return 'default';
    }

    if (trimmed.startsWith('refs/heads/')) {
      return trimmed.slice('refs/heads/'.length);
    }

    if (trimmed.startsWith('refs/remotes/')) {
      const remainder = trimmed.slice('refs/remotes/'.length);
      const slashIndex = remainder.indexOf('/');
      return slashIndex === -1 ? remainder : remainder.slice(slashIndex + 1);
    }

    if (kind === 'remote') {
      const slashIndex = trimmed.indexOf('/');
      if (slashIndex > 0) {
        return trimmed.slice(slashIndex + 1);
      }
    }

    return trimmed;
  }

  function branchBadgeStyle(
    ref: string,
    kind: 'local' | 'remote' = 'local',
  ): string {
    void themeVersion;
    return deterministicTagStyle(branchColorKey(ref, kind), {
      profile: 'balanced',
      surfaceVar: '--popover',
    });
  }

  const selectedStartPoint = $derived(
    startPoints.find(
      (startPoint) => startPoint.value === selectedStartPointValue,
    ) ?? null,
  );

  const hasStartPointOptions = $derived(startPoints.length > 0);
  const startPointTriggerLabel = $derived.by(() => {
    if (useCustomStartPoint) {
      return customStartPoint.trim() || 'Custom ref…';
    }
    if (selectedStartPoint?.local_ref) {
      return selectedStartPoint.local_ref;
    }
    if (selectedStartPoint?.remote_refs?.length) {
      return selectedStartPoint.remote_refs[0];
    }
    if (defaultStartPoint) {
      return defaultStartPoint;
    }
    return 'Select start point';
  });

  onMount(() => {
    void loadStartPoints();
  });

  async function loadStartPoints(): Promise<void> {
    startPointWarning = '';
    try {
      const response = await listProjectWorktreeStartPoints(projectId);
      startPoints = response.start_points;
      defaultStartPoint = response.default_start_point?.trim() ?? '';

      if (!useCustomStartPoint) {
        const matchedDefault = defaultStartPoint
          ? response.start_points.find(
              (startPoint) =>
                startPoint.value === defaultStartPoint ||
                startPoint.local_ref === defaultStartPoint ||
                startPoint.remote_refs.includes(defaultStartPoint),
            )
          : undefined;

        selectedStartPointValue =
          matchedDefault?.value ||
          response.start_points[0]?.value ||
          selectedStartPointValue;
      }
      if (response.git_error) {
        startPointWarning = response.git_error;
      }
    } catch (err) {
      startPointWarning = `Failed to load branches (${(err as Error).message})`;
      startPoints = [];
      defaultStartPoint = '';
      if (!useCustomStartPoint) {
        selectedStartPointValue = '';
      }
    }
  }

  function rerollSuggestedBranch(): void {
    suggestedBranch = generateWorktreeBranchName(suggestedBranch);
  }

  function selectStartPoint(value: string): void {
    selectedStartPointValue = value;
    useCustomStartPoint = false;
    startPointPopoverOpen = false;
    error = '';
  }

  function selectCustomStartPoint(): void {
    useCustomStartPoint = true;
    startPointPopoverOpen = false;
    error = '';
  }

  async function submit() {
    const effectiveBranch = branch.trim() || suggestedBranch;
    if (!effectiveBranch) {
      return;
    }

    let effectiveStartPoint: string | undefined;
    if (useCustomStartPoint) {
      const custom = customStartPoint.trim();
      if (!custom) {
        error = 'Custom start point is required.';
        return;
      }
      effectiveStartPoint = custom;
    } else {
      effectiveStartPoint =
        selectedStartPointValue || defaultStartPoint || undefined;
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

    <div class="space-y-3 py-2" data-theme-version={themeVersion}>
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
        <Popover.Root bind:open={startPointPopoverOpen}>
          <Popover.Trigger
            id="new-worktree-start-point"
            disabled={submitting}
            role="combobox"
            aria-expanded={startPointPopoverOpen}
            class="border-input ring-offset-background focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex h-9 w-full items-center justify-between rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-[3px]"
          >
            <span
              class="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left"
            >
              {#if useCustomStartPoint}
                <Badge variant="outline" class="text-xs">Custom</Badge>
                <span class="truncate">{startPointTriggerLabel}</span>
              {:else if selectedStartPoint}
                {#if selectedStartPoint.local_ref}
                  <Badge
                    variant="outline"
                    class={branchBadgeClass}
                    style={branchBadgeStyle(selectedStartPoint.local_ref)}
                  >
                    {selectedStartPoint.local_ref}
                  </Badge>
                {/if}
                {#if !selectedStartPoint.local_ref && selectedStartPoint.remote_refs.length === 0}
                  <span class="truncate text-muted-foreground">
                    {startPointTriggerLabel}
                  </span>
                {/if}
                {#each selectedStartPoint.remote_refs as remoteRef (remoteRef)}
                  <Badge
                    variant="outline"
                    class={branchBadgeClass}
                    style={branchBadgeStyle(remoteRef, 'remote')}
                  >
                    {remoteRef}
                  </Badge>
                {/each}
              {:else}
                <span class="truncate text-muted-foreground">
                  {startPointTriggerLabel}
                </span>
              {/if}
            </span>
            <ChevronsUpDown class="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Popover.Trigger>
          <Popover.Content
            class="start-point-popover w-(--bits-popover-anchor-width) p-0"
            align="start"
          >
            <Command.Root class="start-point-command">
              <Command.Input
                class="start-point-command-input"
                placeholder="Search branches..."
              />
              <Command.List>
                <Command.Empty>No start points found.</Command.Empty>
                {#if hasStartPointOptions}
                  <Command.Group heading="Branches">
                    {#each startPoints as startPoint (startPoint.value)}
                      <Command.Item
                        value={startPoint.value}
                        keywords={[
                          startPoint.value,
                          startPoint.sha,
                          startPoint.local_ref ?? '',
                          ...startPoint.remote_refs,
                        ]}
                        class="start-point-command-item"
                        onSelect={() => selectStartPoint(startPoint.value)}
                      >
                        <GitBranch class="h-4 w-4 text-muted-foreground" />
                        <div class="min-w-0 flex-1">
                          <div
                            class="flex min-w-0 flex-wrap items-center gap-1"
                          >
                            {#if startPoint.local_ref}
                              <Badge
                                variant="outline"
                                class={branchBadgeClass}
                                style={branchBadgeStyle(startPoint.local_ref)}
                              >
                                {startPoint.local_ref}
                              </Badge>
                            {/if}
                            {#each startPoint.remote_refs as remoteRef (remoteRef)}
                              <Badge
                                variant="outline"
                                class={branchBadgeClass}
                                style={branchBadgeStyle(remoteRef, 'remote')}
                              >
                                {remoteRef}
                              </Badge>
                            {/each}
                            {#if !startPoint.local_ref && startPoint.remote_refs.length === 0}
                              <span class="truncate">{startPoint.value}</span>
                            {/if}
                          </div>
                          <p class="mt-1 text-[11px] text-muted-foreground">
                            commit {startPoint.sha.slice(0, 8)}
                          </p>
                        </div>
                      </Command.Item>
                    {/each}
                  </Command.Group>
                {/if}
                <Command.Separator class="start-point-command-separator" />
                <Command.Group heading="Advanced">
                  <Command.Item
                    value="custom-ref-option"
                    keywords={['custom', 'manual', 'sha', 'ref']}
                    class="start-point-command-item"
                    onSelect={selectCustomStartPoint}
                  >
                    <Sparkles class="h-4 w-4 text-muted-foreground" />
                    <div class="flex flex-col">
                      <span>Custom ref…</span>
                      <span class="text-xs text-muted-foreground">
                        Use a tag, hash, or custom revision
                      </span>
                    </div>
                  </Command.Item>
                </Command.Group>
              </Command.List>
            </Command.Root>
          </Popover.Content>
        </Popover.Root>

        {#if useCustomStartPoint}
          <Input
            id="new-worktree-custom-start-point"
            type="text"
            bind:value={customStartPoint}
            placeholder={defaultStartPoint || 'origin/main or commit SHA'}
            disabled={submitting}
            oninput={() => {
              if (error === 'Custom start point is required.') {
                error = '';
              }
            }}
            onkeydown={(e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                submit();
              }
            }}
          />
        {/if}
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

<style>
  :global(.start-point-popover) {
    background-color: var(--quick-input-background, var(--popover));
    border-color: var(--quick-input-border, var(--border));
    color: var(--quick-input-foreground, var(--popover-foreground));
    box-shadow: 0 14px 36px
      color-mix(
        in oklab,
        var(--quick-input-border, var(--border)) 22%,
        transparent
      );
  }

  :global(.start-point-command) {
    background-color: transparent;
    color: inherit;
  }

  :global(.start-point-popover [data-slot='command-input-wrapper']) {
    border-color: color-mix(
      in oklab,
      var(--quick-input-border, var(--border)) 78%,
      transparent
    );
    background-color: color-mix(
      in oklab,
      var(--quick-input-background, var(--popover)) 90%,
      var(--background)
    );
  }

  :global(.start-point-popover [cmdk-group-heading]) {
    color: var(--quick-input-group-foreground, var(--muted-foreground));
  }

  :global(.start-point-command-separator) {
    background-color: color-mix(
      in oklab,
      var(--quick-input-border, var(--border)) 74%,
      transparent
    );
  }

  :global(.start-point-command-item[aria-selected='true']) {
    background-color: var(
      --quick-input-focus-background,
      var(--accent)
    ) !important;
    color: var(
      --quick-input-focus-foreground,
      var(--accent-foreground)
    ) !important;
  }

  :global(.deterministic-tag-badge) {
    border-color: color-mix(
      in oklab,
      var(--tag-seed) calc(var(--tag-border-mix) * 1%),
      var(--border)
    );
    background-color: color-mix(
      in oklab,
      var(--tag-seed) calc(var(--tag-bg-mix) * 1%),
      var(--popover)
    );
    color: color-mix(
      in oklab,
      var(--tag-seed) calc(var(--tag-fg-mix) * 1%),
      var(--foreground)
    );
  }
</style>
