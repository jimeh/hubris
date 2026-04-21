import { useState } from "react";
import AddProjectDialog from "@/components/AddProjectDialog";
import AddWorktreeDialog from "@/components/AddWorktreeDialog";
import ConfirmDialog from "@/components/ConfirmDialog";
import ProjectRemoveDialog from "@/components/ProjectRemoveDialog";
import RenameProjectDialog from "@/components/RenameProjectDialog";
import SettingsDialog from "@/components/SettingsDialog";
import WorktreeRemoveDialog from "@/components/WorktreeRemoveDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { executeCommand } from "@/lib/commands";
import { useCommandUiStore } from "@/lib/stores/commandUi";
import { useProjectStore } from "@/lib/stores/projects";
import { useTabStore } from "@/lib/stores/tabs";
import { useWorktreeStore } from "@/lib/stores/worktrees";

function CloseDirtyTabDialog({
  label,
  onClose,
  tabId,
}: {
  label: string;
  onClose: () => void;
  tabId: string;
}) {
  const [submitting, setSubmitting] = useState(false);

  async function handleDiscard(): Promise<void> {
    setSubmitting(true);

    const result = await executeCommand({
      args: { saveBehavior: "discard", tabId },
      id: "tab.close",
      source: "dialog",
    });

    if (result.status === "success") {
      onClose();
      return;
    }

    setSubmitting(false);
  }

  async function handleSave(): Promise<void> {
    setSubmitting(true);

    const result = await executeCommand({
      args: { saveBehavior: "save", tabId },
      id: "tab.close",
      source: "dialog",
    });

    if (result.status === "success") {
      onClose();
      return;
    }

    setSubmitting(false);
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) {
          onClose();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Save changes to {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            Your edits will be lost if you close this tab without saving.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-muted text-foreground hover:bg-muted/80"
            disabled={submitting}
            onClick={(event) => {
              event.preventDefault();
              void handleDiscard();
            }}
          >
            Don&apos;t Save
          </AlertDialogAction>
          <AlertDialogAction
            disabled={submitting}
            onClick={(event) => {
              event.preventDefault();
              void handleSave();
            }}
          >
            Save
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function CommandDialogs() {
  const dialog = useCommandUiStore((state) => state.dialog);
  const closeDialog = useCommandUiStore((state) => state.closeDialog);
  const projects = useProjectStore((state) => state.projects);
  const worktreesByProject = useWorktreeStore(
    (state) => state.worktreesByProject,
  );
  const tabs = useTabStore((state) => state.tabs);

  const activeProject =
    dialog && "projectId" in dialog
      ? (projects.find((project) => project.id === dialog.projectId) ?? null)
      : null;
  const activeWorktree =
    dialog && "worktreeId" in dialog
      ? (Object.values(worktreesByProject)
          .flat()
          .find((worktree) => worktree.id === dialog.worktreeId) ?? null)
      : null;
  const activeTab =
    dialog && "tabId" in dialog
      ? (tabs.find((tab) => tab.id === dialog.tabId) ?? null)
      : null;

  return (
    <>
      {dialog?.type === "add-project" ? (
        <AddProjectDialog
          onAdd={async (path) => {
            const result = await executeCommand({
              args: { path },
              id: "project.add",
              source: "dialog",
            });
            if (result.status === "success") {
              closeDialog();
            }
          }}
          onClose={closeDialog}
        />
      ) : null}

      {dialog?.type === "add-worktree" && activeProject ? (
        <AddWorktreeDialog
          projectId={activeProject.id}
          projectName={activeProject.name}
          onAdd={async (branch, startPoint, sourceRef) => {
            const result = await executeCommand({
              args: {
                branch,
                projectId: activeProject.id,
                sourceRef,
                startPoint,
              },
              id: "worktree.create",
              source: "dialog",
            });
            if (result.status === "success") {
              closeDialog();
            }
          }}
          onImport={async (path) => {
            const result = await executeCommand({
              args: { path, projectId: activeProject.id },
              id: "worktree.import",
              source: "dialog",
            });
            if (result.status === "success") {
              closeDialog();
            }
          }}
          onClose={closeDialog}
        />
      ) : null}

      {dialog?.type === "rename-project" && activeProject ? (
        <RenameProjectDialog
          currentName={activeProject.name}
          onClose={closeDialog}
          onRename={async (name) => {
            const result = await executeCommand({
              args: { name, projectId: activeProject.id },
              id: "project.rename",
              source: "dialog",
            });
            if (result.status === "success") {
              closeDialog();
            }
          }}
        />
      ) : null}

      {dialog?.type === "rename-worktree" && activeProject && activeWorktree ? (
        <RenameProjectDialog
          currentName={activeWorktree.name}
          description="Update the worktree display name."
          onClose={closeDialog}
          onRename={async (name) => {
            const result = await executeCommand({
              args: {
                name,
                projectId: activeProject.id,
                worktreeId: activeWorktree.id,
              },
              id: "worktree.rename",
              source: "dialog",
            });
            if (result.status === "success") {
              closeDialog();
            }
          }}
          placeholder="Worktree name"
          title="Rename Worktree"
        />
      ) : null}

      {dialog?.type === "remove-project" && activeProject ? (
        <ProjectRemoveDialog
          forceManagedDelete={dialog.forceManagedDelete}
          onClose={closeDialog}
          onRemoveAndDeleteManaged={() => {
            void executeCommand({
              args: {
                deleteManagedWorktrees: true,
                force: dialog.forceManagedDelete,
                projectId: activeProject.id,
              },
              id: "project.remove",
              source: "dialog",
            }).then((result) => {
              if (result.status === "success") {
                closeDialog();
              }
            });
          }}
          onRemoveOnly={() => {
            void executeCommand({
              args: {
                deleteManagedWorktrees: false,
                projectId: activeProject.id,
              },
              id: "project.remove",
              source: "dialog",
            }).then((result) => {
              if (result.status === "success") {
                closeDialog();
              }
            });
          }}
          projectName={activeProject.name}
        />
      ) : null}

      {dialog?.type === "remove-worktree" && activeProject && activeWorktree ? (
        <>
          {dialog.forceDelete ? (
            <ConfirmDialog
              confirmLabel="Force Delete"
              description={`Worktree ${activeWorktree.name} has uncommitted changes or is busy. Force delete it anyway?`}
              onClose={closeDialog}
              onConfirm={() => {
                void executeCommand({
                  args: {
                    force: true,
                    projectId: activeProject.id,
                    worktreeId: activeWorktree.id,
                  },
                  id: "worktree.remove",
                  source: "dialog",
                }).then((result) => {
                  if (result.status === "success") {
                    closeDialog();
                  }
                });
              }}
              title="Force Delete Worktree"
            />
          ) : (
            <WorktreeRemoveDialog
              isImported={activeWorktree.is_imported}
              onClose={closeDialog}
              onDeleteFromDisk={() => {
                void executeCommand({
                  args: {
                    force: false,
                    projectId: activeProject.id,
                    worktreeId: activeWorktree.id,
                  },
                  id: "worktree.remove",
                  source: "dialog",
                }).then((result) => {
                  if (result.status === "success") {
                    closeDialog();
                  }
                });
              }}
              onUntrackOnly={() => {
                void executeCommand({
                  args: {
                    projectId: activeProject.id,
                    untrackOnly: true,
                    worktreeId: activeWorktree.id,
                  },
                  id: "worktree.remove",
                  source: "dialog",
                }).then((result) => {
                  if (result.status === "success") {
                    closeDialog();
                  }
                });
              }}
              worktreeName={activeWorktree.name}
            />
          )}
        </>
      ) : null}

      {dialog?.type === "rename-terminal-tab" &&
      activeTab?.type === "terminal" ? (
        <RenameProjectDialog
          currentName={activeTab.customLabel ?? activeTab.label}
          description="Custom names override smart names and terminal-provided titles until reset."
          onClose={closeDialog}
          onRename={async (name) => {
            const result = await executeCommand({
              args: { name, tabId: activeTab.id },
              id: "tab.renameTerminal",
              source: "dialog",
            });
            if (result.status === "success") {
              closeDialog();
            }
          }}
          placeholder={activeTab.label}
          title="Rename Terminal Tab"
        />
      ) : null}

      {dialog?.type === "close-dirty-tab" && activeTab ? (
        <CloseDirtyTabDialog
          key={activeTab.id}
          label={activeTab.label}
          onClose={closeDialog}
          tabId={activeTab.id}
        />
      ) : null}

      <SettingsDialog
        initialSection={
          dialog?.type === "settings" ? dialog.section : undefined
        }
        open={dialog?.type === "settings"}
        onOpenChange={(open) => {
          if (!open) {
            closeDialog();
          }
        }}
      />
    </>
  );
}
