<script lang="ts">
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import AddProjectDialog from './AddProjectDialog.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import SettingsDialog from './SettingsDialog.svelte';
  import {
    ChevronDown,
    ChevronRight,
    Plus,
    Settings,
    Trash2,
    X,
  } from '@lucide/svelte';
  import { dndzone, SHADOW_ITEM_MARKER_PROPERTY_NAME } from 'svelte-dnd-action';
  import type { Project, Worktree } from '$lib/types';

  interface ProjectStore {
    projects: Project[];
    add(path: string): Promise<Project>;
    remove(id: string, force?: boolean): Promise<void>;
    reorder(orderedIds: string[]): Promise<void>;
    toggleExpanded(projectId: string): void;
    isExpanded(projectId: string): boolean;
  }

  interface WorktreeStore {
    selectedWorktreeId: string | null;
    worktreesForProject(projectId: string): Worktree[];
    select(worktreeId: string): void;
    create(projectId: string, branch: string): Promise<Worktree>;
    remove(
      projectId: string,
      worktreeId: string,
      force?: boolean,
    ): Promise<void>;
    reorder(projectId: string, orderedIds: string[]): Promise<void>;
    projectError(projectId: string): string | null;
  }

  let {
    projectStore,
    worktreeStore,
  }: {
    projectStore: ProjectStore;
    worktreeStore: WorktreeStore;
  } = $props();

  let showDialog = $state(false);
  let showSettings = $state(false);
  let confirmRemoveProjectId = $state<string | null>(null);

  const FLIP_MS = 150;

  type DndProject = Project & {
    [SHADOW_ITEM_MARKER_PROPERTY_NAME]?: string;
  };

  type DndWorktree = Worktree & {
    [SHADOW_ITEM_MARKER_PROPERTY_NAME]?: string;
  };

  let draggingProjects = $state(false);
  let dndProjects = $state<DndProject[]>([]);
  let dndWorktrees = $state<Record<string, DndWorktree[]>>({});

  $effect(() => {
    if (!draggingProjects) {
      dndProjects = projectStore.projects.map((project: Project) => ({
        ...project,
      }));
    }

    const next: Record<string, DndWorktree[]> = {};
    for (const project of projectStore.projects) {
      next[project.id] = worktreeStore
        .worktreesForProject(project.id)
        .filter((worktree: Worktree) => !worktree.is_local)
        .map((worktree: Worktree) => ({ ...worktree }));
    }
    dndWorktrees = next;
  });

  function handleProjectConsider(e: CustomEvent<{ items: DndProject[] }>) {
    draggingProjects = true;
    dndProjects = e.detail.items;
  }

  function handleProjectFinalize(e: CustomEvent<{ items: DndProject[] }>) {
    dndProjects = e.detail.items;
    draggingProjects = false;
    projectStore.reorder(dndProjects.map((project) => project.id));
  }

  function handleWorktreeConsider(
    projectId: string,
    e: CustomEvent<{ items: DndWorktree[] }>,
  ) {
    dndWorktrees[projectId] = e.detail.items;
    dndWorktrees = { ...dndWorktrees };
  }

  function handleWorktreeFinalize(
    projectId: string,
    e: CustomEvent<{ items: DndWorktree[] }>,
  ) {
    dndWorktrees[projectId] = e.detail.items;
    dndWorktrees = { ...dndWorktrees };
    worktreeStore.reorder(
      projectId,
      e.detail.items.map((wt) => wt.id),
    );
  }

  function localWorktree(projectId: string): Worktree | null {
    return (
      worktreeStore
        .worktreesForProject(projectId)
        .find((worktree: Worktree) => worktree.is_local) ?? null
    );
  }

  async function createWorktree(projectId: string): Promise<void> {
    const branch = window.prompt('New worktree branch name:');
    if (!branch) return;
    const trimmed = branch.trim();
    if (!trimmed) return;
    try {
      await worktreeStore.create(projectId, trimmed);
    } catch (err) {
      alert(`Failed to create worktree (${(err as Error).message})`);
    }
  }

  async function removeWorktree(
    projectId: string,
    worktree: Worktree,
  ): Promise<void> {
    if (worktree.is_local) return;
    if (!window.confirm(`Delete worktree "${worktree.name}"?`)) return;

    try {
      await worktreeStore.remove(projectId, worktree.id, false);
    } catch (err) {
      const message = (err as Error).message;
      if (message === '409') {
        const force = window.confirm(
          'Worktree has changes or is busy. Force delete this worktree?',
        );
        if (!force) return;
        await worktreeStore.remove(projectId, worktree.id, true);
      } else {
        alert(`Failed to delete worktree (${message})`);
      }
    }
  }

  async function removeProject(projectId: string): Promise<void> {
    try {
      await projectStore.remove(projectId, false);
    } catch (err) {
      if ((err as Error).message === '409') {
        const force = window.confirm(
          'Some linked worktrees are dirty. Force delete all non-local worktrees?',
        );
        if (!force) return;
        await projectStore.remove(projectId, true);
      } else {
        alert(`Failed to remove project (${(err as Error).message})`);
      }
    }
  }
</script>

<Sidebar.Root>
  <Sidebar.Header>
    <div class="flex items-center justify-between px-2">
      <h2 class="text-lg font-semibold">Projects</h2>
      <Button
        variant="ghost"
        size="icon-sm"
        onclick={() => (showSettings = true)}
        title="Settings"
      >
        <Settings class="h-4 w-4" />
      </Button>
    </div>
  </Sidebar.Header>

  <Sidebar.Content>
    <Sidebar.Group>
      <Sidebar.GroupContent>
        <div
          class="flex w-full min-w-0 flex-col gap-1"
          use:dndzone={{
            items: dndProjects,
            flipDurationMs: FLIP_MS,
            type: 'projects',
            dropTargetStyle: {},
          }}
          onconsider={handleProjectConsider}
          onfinalize={handleProjectFinalize}
        >
          {#each dndProjects as project (project.id)}
            <div
              class="group/menu-item relative rounded-md"
              class:shadow-item={project[SHADOW_ITEM_MARKER_PROPERTY_NAME]}
            >
              <Sidebar.MenuButton
                isActive={false}
                onclick={() => projectStore.toggleExpanded(project.id)}
                class={draggingProjects ? 'cursor-grabbing' : 'cursor-default'}
              >
                {#snippet child({ props })}
                  <div
                    {...props}
                    class="flex items-center justify-between gap-2"
                  >
                    <div class="flex items-center gap-2 truncate">
                      {#if projectStore.isExpanded(project.id)}
                        <ChevronDown class="h-3.5 w-3.5 shrink-0" />
                      {:else}
                        <ChevronRight class="h-3.5 w-3.5 shrink-0" />
                      {/if}
                      <span class="truncate">{project.name}</span>
                    </div>
                    {#if worktreeStore.projectError(project.id)}
                      <span
                        class="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive"
                      >
                        git error
                      </span>
                    {/if}
                  </div>
                {/snippet}
              </Sidebar.MenuButton>

              <Sidebar.MenuAction
                showOnHover
                onclick={(e: MouseEvent) => {
                  e.stopPropagation();
                  confirmRemoveProjectId = project.id;
                }}
              >
                <X class="h-3 w-3" />
              </Sidebar.MenuAction>

              {#if projectStore.isExpanded(project.id)}
                <div class="ml-6 mt-1 space-y-1">
                  {#if localWorktree(project.id)}
                    <button
                      class="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-sidebar-accent
                             {worktreeStore.selectedWorktreeId ===
                      localWorktree(project.id)?.id
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground/80'}"
                      onclick={() =>
                        worktreeStore.select(localWorktree(project.id)!.id)}
                    >
                      <span class="truncate">local</span>
                    </button>
                  {/if}

                  <div
                    use:dndzone={{
                      items: dndWorktrees[project.id] ?? [],
                      flipDurationMs: FLIP_MS,
                      type: `worktrees-${project.id}`,
                      dropTargetStyle: {},
                    }}
                    onconsider={(e) => handleWorktreeConsider(project.id, e)}
                    onfinalize={(e) => handleWorktreeFinalize(project.id, e)}
                    class="space-y-1"
                  >
                    {#each dndWorktrees[project.id] ?? [] as worktree (worktree.id)}
                      <div class="group/worktree-item relative">
                        <button
                          class="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-sidebar-accent
                                 {worktreeStore.selectedWorktreeId ===
                          worktree.id
                            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                            : 'text-sidebar-foreground/80'}"
                          onclick={() => worktreeStore.select(worktree.id)}
                        >
                          <span class="truncate">{worktree.name}</span>
                        </button>
                        <button
                          class="absolute top-1 right-1 opacity-0 transition-opacity group-hover/worktree-item:opacity-100"
                          title="Delete worktree"
                          onclick={(e) => {
                            e.stopPropagation();
                            removeWorktree(project.id, worktree);
                          }}
                        >
                          <Trash2 class="h-3 w-3" />
                        </button>
                      </div>
                    {/each}
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    class="w-full justify-start text-xs text-muted-foreground"
                    onclick={() => createWorktree(project.id)}
                  >
                    <Plus class="mr-1 h-3.5 w-3.5" />
                    New Worktree
                  </Button>

                  {#if worktreeStore.projectError(project.id)}
                    <p class="px-2 pb-1 text-xs text-destructive">
                      {worktreeStore.projectError(project.id)}
                    </p>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </Sidebar.GroupContent>
    </Sidebar.Group>
  </Sidebar.Content>

  <Sidebar.Separator />

  <Sidebar.Footer>
    <Button
      variant="ghost"
      class="w-full text-muted-foreground"
      onclick={() => (showDialog = true)}
    >
      <Plus class="mr-2 h-4 w-4" />
      Add Project
    </Button>
  </Sidebar.Footer>
</Sidebar.Root>

{#if showDialog}
  <AddProjectDialog
    onAdd={async (path) => {
      await projectStore.add(path);
      showDialog = false;
    }}
    onClose={() => (showDialog = false)}
  />
{/if}

{#if confirmRemoveProjectId}
  {@const project = projectStore.projects.find(
    (p: Project) => p.id === confirmRemoveProjectId,
  )}
  <ConfirmDialog
    title="Remove Project"
    description="Remove {project?.name ??
      'this project'} and delete all non-local worktrees for it?"
    confirmLabel="Remove"
    onConfirm={() => {
      removeProject(confirmRemoveProjectId!);
      confirmRemoveProjectId = null;
    }}
    onClose={() => (confirmRemoveProjectId = null)}
  />
{/if}

<SettingsDialog bind:open={showSettings} />

<style>
  :global(.shadow-item) {
    opacity: 0.4;
    outline: 1px dashed var(--sidebar-border);
    border-radius: var(--radius);
  }
</style>
