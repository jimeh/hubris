<script lang="ts">
  import AddProjectDialog from "../AddProjectDialog.svelte";
  import AddWorktreeDialog from "../AddWorktreeDialog.svelte";
  import ConfirmDialog from "../ConfirmDialog.svelte";
  import ProjectRemoveDialog from "../ProjectRemoveDialog.svelte";
  import RenameProjectDialog from "../RenameProjectDialog.svelte";
  import SettingsDialog from "../SettingsDialog.svelte";
  import type { DeleteProjectOptions } from "$lib/api";
  import type { Project } from "$lib/types";
  import type {
    ProjectStore,
    SidebarDialogState,
    WorktreeStore,
  } from "./types.js";

  let {
    dialogState,
    projectStore,
    worktreeStore,
  }: {
    dialogState: SidebarDialogState;
    projectStore: ProjectStore;
    worktreeStore: WorktreeStore;
  } = $props();

  async function removeProject(
    projectId: string,
    options: DeleteProjectOptions = {},
  ): Promise<void> {
    try {
      await projectStore.remove(projectId, options);
      dialogState.actionError = null;
    } catch (err) {
      if (
        options.deleteManagedWorktrees &&
        !options.force &&
        (err as Error).message === "409"
      ) {
        dialogState.confirmForceRemoveProject = projectId;
      } else {
        dialogState.actionError = `Failed to remove project (${(err as Error).message})`;
      }
    }
  }

  async function removeWorktree(
    projectId: string,
    worktreeId: string,
    force = false,
  ): Promise<void> {
    try {
      await worktreeStore.remove(projectId, worktreeId, force);
      dialogState.actionError = null;
    } catch (err) {
      const message = (err as Error).message;
      if (!force && message === "409") {
        // Need the worktree object for the force confirm dialog.
        // Look it up from the store since we only have the ID here.
        const wt = worktreeStore
          .worktreesForProject(projectId)
          .find((w) => w.id === worktreeId);
        if (wt) {
          dialogState.confirmForceRemoveWorktree = {
            projectId,
            worktree: wt,
          };
        }
      } else {
        dialogState.actionError = `Failed to delete worktree (${message})`;
      }
    }
  }
</script>

{#if dialogState.addProject}
  <AddProjectDialog
    onAdd={async (path) => {
      await projectStore.add(path);
      dialogState.addProject = false;
    }}
    onClose={() => (dialogState.addProject = false)}
  />
{/if}

{#if dialogState.addWorktree}
  <AddWorktreeDialog
    projectId={dialogState.addWorktree.projectId}
    projectName={dialogState.addWorktree.projectName}
    onAdd={async (branch, startPoint) => {
      await worktreeStore.create(
        dialogState.addWorktree!.projectId,
        branch,
        startPoint,
      );
      dialogState.addWorktree = null;
    }}
    onClose={() => (dialogState.addWorktree = null)}
  />
{/if}

{#if dialogState.renameProject}
  <RenameProjectDialog
    currentName={dialogState.renameProject.currentName}
    onRename={(name) =>
      projectStore.rename(dialogState.renameProject!.projectId, name)}
    onClose={() => (dialogState.renameProject = null)}
  />
{/if}

{#if dialogState.confirmRemoveProject}
  {@const project = projectStore.projects.find(
    (p: Project) => p.id === dialogState.confirmRemoveProject,
  )}
  <ProjectRemoveDialog
    projectName={project?.name ?? "this project"}
    onRemoveOnly={() => {
      const id = dialogState.confirmRemoveProject!;
      dialogState.confirmRemoveProject = null;
      void removeProject(id, { deleteManagedWorktrees: false });
    }}
    onRemoveAndDeleteManaged={() => {
      const id = dialogState.confirmRemoveProject!;
      dialogState.confirmRemoveProject = null;
      void removeProject(id, { deleteManagedWorktrees: true });
    }}
    onClose={() => (dialogState.confirmRemoveProject = null)}
  />
{/if}

{#if dialogState.confirmForceRemoveProject}
  {@const project = projectStore.projects.find(
    (p: Project) => p.id === dialogState.confirmForceRemoveProject,
  )}
  <ProjectRemoveDialog
    projectName={project?.name ?? "this project"}
    forceManagedDelete
    onRemoveOnly={() => {
      const id = dialogState.confirmForceRemoveProject!;
      dialogState.confirmForceRemoveProject = null;
      void removeProject(id, { deleteManagedWorktrees: false });
    }}
    onRemoveAndDeleteManaged={() => {
      const id = dialogState.confirmForceRemoveProject!;
      dialogState.confirmForceRemoveProject = null;
      void removeProject(id, {
        deleteManagedWorktrees: true,
        force: true,
      });
    }}
    onClose={() => (dialogState.confirmForceRemoveProject = null)}
  />
{/if}

{#if dialogState.confirmRemoveWorktree}
  <ConfirmDialog
    title="Delete Worktree"
    description="Delete worktree {dialogState.confirmRemoveWorktree.worktree
      .name}? This removes the worktree directory from disk."
    confirmLabel="Delete"
    onConfirm={() => {
      const target = dialogState.confirmRemoveWorktree!;
      dialogState.confirmRemoveWorktree = null;
      void removeWorktree(target.projectId, target.worktree.id, false);
    }}
    onClose={() => (dialogState.confirmRemoveWorktree = null)}
  />
{/if}

{#if dialogState.confirmForceRemoveWorktree}
  <ConfirmDialog
    title="Force Delete Worktree"
    description="Worktree {dialogState.confirmForceRemoveWorktree.worktree
      .name} has uncommitted changes or is busy. Force delete it anyway?"
    confirmLabel="Force Delete"
    onConfirm={() => {
      const target = dialogState.confirmForceRemoveWorktree!;
      dialogState.confirmForceRemoveWorktree = null;
      void removeWorktree(target.projectId, target.worktree.id, true);
    }}
    onClose={() => (dialogState.confirmForceRemoveWorktree = null)}
  />
{/if}

<SettingsDialog bind:open={dialogState.showSettings} />
