import { useProjectStore } from "@/lib/stores/projects";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import type { SidebarDialogState } from "./types";
import { AddProjectDialog } from "@/components/AddProjectDialog";
import { AddWorktreeDialog } from "@/components/AddWorktreeDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RenameProjectDialog } from "@/components/RenameProjectDialog";
import { SettingsDialog } from "@/components/SettingsDialog";

interface SidebarDialogsProps {
  dialogState: SidebarDialogState;
  setDialogState: React.Dispatch<React.SetStateAction<SidebarDialogState>>;
}

export function SidebarDialogs({
  dialogState,
  setDialogState,
}: SidebarDialogsProps) {
  const projects = useProjectStore((s) => s.projects);
  const addProject = useProjectStore((s) => s.add);
  const removeProject = useProjectStore((s) => s.remove);
  const renameProject = useProjectStore((s) => s.rename);
  const createWorktree = useWorktreeStore((s) => s.create);
  const removeWorktree = useWorktreeStore((s) => s.remove);
  const worktreesForProject = useWorktreeStore((s) => s.worktreesForProject);

  async function handleRemoveProject(projectId: string, force = false) {
    try {
      await removeProject(projectId, force);
      setDialogState((s) => ({
        ...s,
        actionError: null,
      }));
    } catch (err) {
      if (!force && (err as Error).message === "409") {
        setDialogState((s) => ({
          ...s,
          confirmForceRemoveProject: projectId,
        }));
      } else {
        setDialogState((s) => ({
          ...s,
          actionError: `Failed to remove project (${(err as Error).message})`,
        }));
      }
    }
  }

  async function handleRemoveWorktree(
    projectId: string,
    worktreeId: string,
    force = false,
  ) {
    try {
      await removeWorktree(projectId, worktreeId, force);
      setDialogState((s) => ({
        ...s,
        actionError: null,
      }));
    } catch (err) {
      const message = (err as Error).message;
      if (!force && message === "409") {
        const wt = worktreesForProject(projectId).find(
          (w) => w.id === worktreeId,
        );
        if (wt) {
          setDialogState((s) => ({
            ...s,
            confirmForceRemoveWorktree: {
              projectId,
              worktree: wt,
            },
          }));
        }
      } else {
        setDialogState((s) => ({
          ...s,
          actionError: `Failed to delete worktree (${message})`,
        }));
      }
    }
  }

  return (
    <>
      {dialogState.addProject && (
        <AddProjectDialog
          onAdd={async (path) => {
            await addProject(path);
            setDialogState((s) => ({
              ...s,
              addProject: false,
            }));
          }}
          onClose={() =>
            setDialogState((s) => ({
              ...s,
              addProject: false,
            }))
          }
        />
      )}

      {dialogState.addWorktree && (
        <AddWorktreeDialog
          projectId={dialogState.addWorktree.projectId}
          projectName={dialogState.addWorktree.projectName}
          onAdd={async (branch, startPoint) => {
            await createWorktree(
              dialogState.addWorktree!.projectId,
              branch,
              startPoint,
            );
            setDialogState((s) => ({
              ...s,
              addWorktree: null,
            }));
          }}
          onClose={() =>
            setDialogState((s) => ({
              ...s,
              addWorktree: null,
            }))
          }
        />
      )}

      {dialogState.renameProject && (
        <RenameProjectDialog
          currentName={dialogState.renameProject.currentName}
          onRename={(name) =>
            renameProject(dialogState.renameProject!.projectId, name)
          }
          onClose={() =>
            setDialogState((s) => ({
              ...s,
              renameProject: null,
            }))
          }
        />
      )}

      {dialogState.confirmRemoveProject &&
        (() => {
          const project = projects.find(
            (p) => p.id === dialogState.confirmRemoveProject,
          );
          return (
            <ConfirmDialog
              title="Remove Project"
              description={`Remove ${project?.name ?? "this project"} and delete all non-local worktrees for it?`}
              confirmLabel="Remove"
              onConfirm={() => {
                const id = dialogState.confirmRemoveProject!;
                setDialogState((s) => ({
                  ...s,
                  confirmRemoveProject: null,
                }));
                handleRemoveProject(id);
              }}
              onClose={() =>
                setDialogState((s) => ({
                  ...s,
                  confirmRemoveProject: null,
                }))
              }
            />
          );
        })()}

      {dialogState.confirmForceRemoveProject &&
        (() => {
          const project = projects.find(
            (p) => p.id === dialogState.confirmForceRemoveProject,
          );
          return (
            <ConfirmDialog
              title="Force Remove Project"
              description={`Project ${project?.name ?? "this project"} has linked worktrees with uncommitted changes or busy state. Force remove it anyway?`}
              confirmLabel="Force Remove"
              onConfirm={() => {
                const id = dialogState.confirmForceRemoveProject!;
                setDialogState((s) => ({
                  ...s,
                  confirmForceRemoveProject: null,
                }));
                handleRemoveProject(id, true);
              }}
              onClose={() =>
                setDialogState((s) => ({
                  ...s,
                  confirmForceRemoveProject: null,
                }))
              }
            />
          );
        })()}

      {dialogState.confirmRemoveWorktree && (
        <ConfirmDialog
          title="Delete Worktree"
          description={`Delete worktree ${dialogState.confirmRemoveWorktree.worktree.name}? This removes the worktree directory from disk.`}
          confirmLabel="Delete"
          onConfirm={() => {
            const target = dialogState.confirmRemoveWorktree!;
            setDialogState((s) => ({
              ...s,
              confirmRemoveWorktree: null,
            }));
            handleRemoveWorktree(target.projectId, target.worktree.id, false);
          }}
          onClose={() =>
            setDialogState((s) => ({
              ...s,
              confirmRemoveWorktree: null,
            }))
          }
        />
      )}

      {dialogState.confirmForceRemoveWorktree && (
        <ConfirmDialog
          title="Force Delete Worktree"
          description={`Worktree ${dialogState.confirmForceRemoveWorktree.worktree.name} has uncommitted changes or is busy. Force delete it anyway?`}
          confirmLabel="Force Delete"
          onConfirm={() => {
            const target = dialogState.confirmForceRemoveWorktree!;
            setDialogState((s) => ({
              ...s,
              confirmForceRemoveWorktree: null,
            }));
            handleRemoveWorktree(target.projectId, target.worktree.id, true);
          }}
          onClose={() =>
            setDialogState((s) => ({
              ...s,
              confirmForceRemoveWorktree: null,
            }))
          }
        />
      )}

      <SettingsDialog
        open={dialogState.showSettings}
        onOpenChange={(open) =>
          setDialogState((s) => ({
            ...s,
            showSettings: open,
          }))
        }
      />
    </>
  );
}
