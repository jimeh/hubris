<script lang="ts">
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import { flip } from "svelte/animate";
  import { dragHandleZone } from "svelte-dnd-action";
  import type { Project, Worktree } from "$lib/types";
  import type {
    DndProject,
    ProjectStore,
    SidebarDialogState,
    WorktreeStore,
  } from "./types.js";
  import ProjectItem from "./ProjectItem.svelte";

  let {
    projectStore,
    worktreeStore,
    dialogState,
  }: {
    projectStore: ProjectStore;
    worktreeStore: WorktreeStore;
    dialogState: SidebarDialogState;
  } = $props();

  const FLIP_MS = 150;

  let draggingProjects = $state(false);
  let draggingWorktrees = $state(false);
  let isDragging = $derived(draggingProjects || draggingWorktrees);

  let dndProjects = $state<DndProject[]>([]);

  $effect(() => {
    if (!draggingProjects) {
      dndProjects = projectStore.projects.map((p: Project) => ({ ...p }));
    }
  });

  function handleConsider(e: CustomEvent<{ items: DndProject[] }>) {
    draggingProjects = true;
    dndProjects = e.detail.items;
  }

  function handleFinalize(e: CustomEvent<{ items: DndProject[] }>) {
    dndProjects = e.detail.items;
    draggingProjects = false;
    projectStore.reorder(dndProjects.map((p) => p.id));
  }

  function localWorktree(projectId: string): Worktree | null {
    return (
      worktreeStore
        .worktreesForProject(projectId)
        .find((wt: Worktree) => wt.is_local) ?? null
    );
  }
</script>

<Sidebar.Group>
  <Sidebar.GroupContent>
    <Sidebar.Menu>
      <div
        class="flex w-full min-w-0 flex-col gap-1"
        data-sidebar-dragging={isDragging || undefined}
        use:dragHandleZone={{
          items: dndProjects,
          flipDurationMs: FLIP_MS,
          type: "projects",
          dropTargetStyle: {},
          centreDraggedOnCursor: false,
          useCursorForDetection: true,
          morphDisabled: true,
        }}
        onconsider={handleConsider}
        onfinalize={handleFinalize}
      >
        {#each dndProjects as project (project.id)}
          <div
            animate:flip={{
              duration: draggingProjects ? FLIP_MS : 0,
            }}
            class="group/menu-item relative rounded-md"
            data-project-drag-item="true"
          >
            <ProjectItem
              {project}
              isExpanded={projectStore.isExpanded(project.id)}
              selectedWorktreeId={worktreeStore.selectedWorktreeId}
              localWorktree={localWorktree(project.id)}
              worktrees={worktreeStore.worktreesForProject(project.id)}
              projectError={worktreeStore.projectError(project.id)}
              onToggleExpand={() => projectStore.toggleExpanded(project.id)}
              onRequestRename={() => {
                dialogState.actionError = null;
                dialogState.renameProject = {
                  projectId: project.id,
                  currentName: project.name,
                };
              }}
              onRequestRemove={() => {
                dialogState.actionError = null;
                dialogState.confirmRemoveProject = project.id;
              }}
              onRequestAddWorktree={() => {
                dialogState.actionError = null;
                dialogState.addWorktree = {
                  projectId: project.id,
                  projectName: project.name,
                };
              }}
              onSelectWorktree={(id) => worktreeStore.select(id)}
              onRequestRemoveWorktree={(projectId, worktree) => {
                dialogState.actionError = null;
                dialogState.confirmRemoveWorktree = {
                  projectId,
                  worktree,
                };
              }}
              onWorktreeDraggingChange={(d) => {
                draggingWorktrees = d;
              }}
              onWorktreeReorder={(projectId, ids) =>
                worktreeStore.reorder(projectId, ids)}
            />
          </div>
        {/each}
      </div>
    </Sidebar.Menu>
  </Sidebar.GroupContent>
</Sidebar.Group>
