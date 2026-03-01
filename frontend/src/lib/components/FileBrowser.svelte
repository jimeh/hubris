<script lang="ts">
  import { untrack } from 'svelte';
  import { listFiles } from '$lib/api';
  import type { DirEntry } from '$lib/types';
  import * as ScrollArea from '$lib/components/ui/scroll-area/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Skeleton } from '$lib/components/ui/skeleton/index.js';
  import {
    Folder,
    FolderGit2,
    House,
    ArrowUp,
    RotateCcw,
    Eye,
    EyeOff,
  } from '@lucide/svelte';

  let {
    currentPath = $bindable(''),
    onSelect,
  }: {
    currentPath: string;
    onSelect: (path: string) => void;
  } = $props();

  let entries = $state<DirEntry[]>([]);
  let loading = $state(false);
  let error = $state('');
  let homeDir = $state<string | null>(null);
  let showHidden = $state(false);
  let focusedIndex = $state(-1);

  // The path currently displayed in the browser.
  // May differ from currentPath during user typing.
  let browsedPath = $state('');

  // Breadcrumb segments derived from browsedPath
  let pathSegments = $derived.by(() => {
    if (!browsedPath) return [];
    const parts = browsedPath.split('/').filter(Boolean);
    return parts.map((part, i) => ({
      name: part,
      path: '/' + parts.slice(0, i + 1).join('/'),
    }));
  });

  async function fetchEntries(path?: string) {
    loading = true;
    error = '';
    focusedIndex = -1;
    try {
      const res = await listFiles(path, showHidden);
      entries = res.entries;
      browsedPath = res.path;
      currentPath = res.path;
      if (res.home_dir) homeDir = res.home_dir;
    } catch (e) {
      error = (e as Error).message;
      entries = [];
    } finally {
      loading = false;
    }
  }

  function navigateTo(path: string) {
    fetchEntries(path);
  }

  function navigateToEntry(entry: DirEntry) {
    const sep = browsedPath.endsWith('/') ? '' : '/';
    navigateTo(browsedPath + sep + entry.name);
  }

  function navigateToParent() {
    const parent = browsedPath.replace(/\/[^/]+\/?$/, '') || '/';
    navigateTo(parent);
  }

  // Initial load — fetch home directory once on mount
  $effect(() => {
    untrack(() => fetchEntries());
  });

  // Watch for external currentPath changes (user typing)
  let debounceTimer: ReturnType<typeof setTimeout>;
  $effect(() => {
    const path = currentPath;
    if (path === browsedPath) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (path.trim()) {
        fetchEntries(path);
      }
    }, 400);

    return () => clearTimeout(debounceTimer);
  });

  // Watch showHidden toggle — re-fetch, skip initial run
  let showHiddenInitialized = false;
  $effect(() => {
    void showHidden;
    if (!showHiddenInitialized) {
      showHiddenInitialized = true;
      return;
    }
    if (browsedPath) {
      fetchEntries(browsedPath);
    }
  });

  function handleKeydown(e: KeyboardEvent) {
    if (entries.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusedIndex = Math.min(focusedIndex + 1, entries.length - 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusedIndex = Math.max(focusedIndex - 1, 0);
        break;
      case 'Enter':
        e.preventDefault();
        if (focusedIndex >= 0) {
          navigateToEntry(entries[focusedIndex]);
        }
        break;
      case 'Backspace':
        e.preventDefault();
        navigateToParent();
        break;
    }
  }
</script>

<!-- Breadcrumb navigation -->
<div
  class="flex items-center gap-0 overflow-x-auto
         text-[13px] font-mono text-muted-foreground
         pb-2 [scrollbar-width:none]
         [&::-webkit-scrollbar]:hidden"
>
  <button
    class="shrink-0 px-1 hover:text-foreground
           transition-colors"
    onclick={() => navigateTo('/')}>/</button
  >
  {#each pathSegments as segment (segment.path)}
    <button
      class="shrink-0 truncate max-w-[140px] px-0.5
             hover:text-foreground hover:underline
             underline-offset-2 transition-colors"
      onclick={() => navigateTo(segment.path)}>{segment.name}</button
    >
    <span class="shrink-0 opacity-40">/</span>
  {/each}
</div>

<!-- Toolbar -->
<div class="flex items-center gap-0.5 pb-2">
  {#if homeDir}
    <Button
      variant="ghost"
      size="icon-sm"
      onclick={() => navigateTo(homeDir!)}
      title="Home directory"
    >
      <House class="h-3.5 w-3.5" />
    </Button>
  {/if}
  <Button
    variant="ghost"
    size="icon-sm"
    onclick={navigateToParent}
    title="Parent directory"
  >
    <ArrowUp class="h-3.5 w-3.5" />
  </Button>
  <Button
    variant="ghost"
    size="icon-sm"
    onclick={() => fetchEntries(browsedPath)}
    title="Refresh"
  >
    <RotateCcw class="h-3.5 w-3.5" />
  </Button>
  <div class="flex-1"></div>
  <Button
    variant="ghost"
    size="icon-sm"
    onclick={() => (showHidden = !showHidden)}
    class={showHidden ? 'text-foreground' : ''}
    title={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
  >
    {#if showHidden}
      <EyeOff class="h-3.5 w-3.5" />
    {:else}
      <Eye class="h-3.5 w-3.5" />
    {/if}
  </Button>
</div>

<!-- Directory listing -->
<ScrollArea.Root class="h-[280px] rounded-md border">
  <div class="p-1" role="listbox" tabindex="0" onkeydown={handleKeydown}>
    {#if loading}
      {#each Array(6) as _, i (i)}
        <div class="flex items-center gap-2 px-2 py-1.5">
          <Skeleton class="h-4 w-4 rounded" />
          <Skeleton class="h-4 w-32 rounded" />
        </div>
      {/each}
    {:else if error}
      <div
        class="flex flex-col items-center gap-2
               py-8 text-sm text-muted-foreground"
      >
        <p class="text-destructive">{error}</p>
        <Button
          variant="outline"
          size="sm"
          onclick={() => fetchEntries(browsedPath)}
        >
          Retry
        </Button>
      </div>
    {:else if entries.length === 0}
      <div
        class="px-2 py-6 text-[13px] font-mono
               text-muted-foreground/60"
      >
        (empty)
      </div>
    {:else}
      {#each entries as entry, i (entry.name)}
        <button
          class="flex w-full items-center gap-2
                 rounded-sm px-2 py-1 text-sm
                 text-left transition-colors
                 hover:bg-accent/50
                 {i === focusedIndex ? 'bg-accent text-accent-foreground' : ''}
                 {entry.is_git_repo
            ? 'border-l-2 border-primary'
            : 'border-l-2 border-transparent'}"
          onclick={() => navigateToEntry(entry)}
          ondblclick={() => {
            const sep = browsedPath.endsWith('/') ? '' : '/';
            onSelect(browsedPath + sep + entry.name);
          }}
          role="option"
          aria-selected={i === focusedIndex}
        >
          {#if entry.is_git_repo}
            <FolderGit2 class="h-4 w-4 shrink-0 text-primary" />
          {:else}
            <Folder
              class="h-4 w-4 shrink-0
                     text-muted-foreground"
            />
          {/if}
          <span class="truncate font-mono text-[13px]">
            {entry.name}
          </span>
        </button>
      {/each}
    {/if}
  </div>
</ScrollArea.Root>
