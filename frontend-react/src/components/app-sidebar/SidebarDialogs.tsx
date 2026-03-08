import AddProjectDialog from "@/components/AddProjectDialog";
import AddWorktreeDialog from "@/components/AddWorktreeDialog";
import ConfirmDialog from "@/components/ConfirmDialog";
import RenameProjectDialog from "@/components/RenameProjectDialog";
import SettingsDialog from "@/components/SettingsDialog";
import type { Project } from "$lib/types";
import type { DialogState } from "./types";

type SidebarDialogsProps = {
  dialogState: DialogState;
  projects: Project[];
  setDialogState: React.Dispatch<React.SetStateAction<DialogState>>;
  onAddProject: (path: string) => Promise<unknown>;
  onAddWorktree: (
    projectId: string,
    branch: string,
    startPoint?: string,
  ) => Promise<unknown>;
  onRenameProject: (projectId: string, name: string) => Promise<unknown>;
  onRemoveProject: (projectId: string, force?: boolean) => Promise<void>;
  onRemoveWorktree: (
    projectId: string,
    worktreeId: string,
    force?: boolean,
  ) => Promise<void>;
};

export default function SidebarDialogs({
  dialogState,
  projects,
  setDialogState,
  onAddProject,
  onAddWorktree,
  onRenameProject,
  onRemoveProject,
  onRemoveWorktree,
}: SidebarDialogsProps) {
  return (
    <>
      {dialogState.addProject ? (
        <AddProjectDialog
          onAdd={async (path) => {
            await onAddProject(path);
            setDialogState((state) => ({ ...state, addProject: false }));
          }}
          onClose={() =>
            setDialogState((state) => ({ ...state, addProject: false }))
          }
        />
      ) : null}

      {dialogState.addWorktree ? (
        <AddWorktreeDialog
          projectId={dialogState.addWorktree.projectId}
          projectName={dialogState.addWorktree.projectName}
          onAdd={async (branch, startPoint) => {
            await onAddWorktree(
              dialogState.addWorktree!.projectId,
              branch,
              startPoint,
            );
            setDialogState((state) => ({ ...state, addWorktree: null }));
          }}
          onClose={() =>
            setDialogState((state) => ({ ...state, addWorktree: null }))
          }
        />
      ) : null}

      {dialogState.renameProject ? (
        <RenameProjectDialog
          currentName={dialogState.renameProject.currentName}
          onRename={async (name): Promise<void> => {
            await onRenameProject(dialogState.renameProject!.projectId, name);
          }}
          onClose={() =>
            setDialogState((state) => ({ ...state, renameProject: null }))
          }
        />
      ) : null}

      {dialogState.confirmRemoveProject ? (
        <ConfirmDialog
          title="Remove Project"
          description={`Remove ${
            projects.find(
              (project) => project.id === dialogState.confirmRemoveProject,
            )?.name ?? "this project"
          } and delete all non-local worktrees for it?`}
          confirmLabel="Remove"
          onConfirm={() => {
            const projectId = dialogState.confirmRemoveProject!;
            setDialogState((state) => ({
              ...state,
              confirmRemoveProject: null,
            }));
            void onRemoveProject(projectId);
          }}
          onClose={() =>
            setDialogState((state) => ({
              ...state,
              confirmRemoveProject: null,
            }))
          }
        />
      ) : null}

      {dialogState.confirmForceRemoveProject ? (
        <ConfirmDialog
          title="Force Remove Project"
          description={`Project ${
            projects.find(
              (project) => project.id === dialogState.confirmForceRemoveProject,
            )?.name ?? "this project"
          } has linked worktrees with uncommitted changes or busy state. Force remove it anyway?`}
          confirmLabel="Force Remove"
          onConfirm={() => {
            const projectId = dialogState.confirmForceRemoveProject!;
            setDialogState((state) => ({
              ...state,
              confirmForceRemoveProject: null,
            }));
            void onRemoveProject(projectId, true);
          }}
          onClose={() =>
            setDialogState((state) => ({
              ...state,
              confirmForceRemoveProject: null,
            }))
          }
        />
      ) : null}

      {dialogState.confirmRemoveWorktree ? (
        <ConfirmDialog
          title="Delete Worktree"
          description={`Delete worktree ${dialogState.confirmRemoveWorktree.worktree.name}? This removes the worktree directory from disk.`}
          confirmLabel="Delete"
          onConfirm={() => {
            const target = dialogState.confirmRemoveWorktree!;
            setDialogState((state) => ({
              ...state,
              confirmRemoveWorktree: null,
            }));
            void onRemoveWorktree(target.projectId, target.worktree.id);
          }}
          onClose={() =>
            setDialogState((state) => ({
              ...state,
              confirmRemoveWorktree: null,
            }))
          }
        />
      ) : null}

      {dialogState.confirmForceRemoveWorktree ? (
        <ConfirmDialog
          title="Force Delete Worktree"
          description={`Worktree ${dialogState.confirmForceRemoveWorktree.worktree.name} has uncommitted changes or is busy. Force delete it anyway?`}
          confirmLabel="Force Delete"
          onConfirm={() => {
            const target = dialogState.confirmForceRemoveWorktree!;
            setDialogState((state) => ({
              ...state,
              confirmForceRemoveWorktree: null,
            }));
            void onRemoveWorktree(target.projectId, target.worktree.id, true);
          }}
          onClose={() =>
            setDialogState((state) => ({
              ...state,
              confirmForceRemoveWorktree: null,
            }))
          }
        />
      ) : null}

      <SettingsDialog
        open={dialogState.showSettings}
        onOpenChange={(open) =>
          setDialogState((state) => ({
            ...state,
            showSettings: open,
          }))
        }
      />
    </>
  );
}
