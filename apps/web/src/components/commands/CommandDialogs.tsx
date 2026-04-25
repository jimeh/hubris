import { useEffect, useMemo, useState } from "react";
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
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { executeCommand } from "@/lib/commands";
import { useCommandUiStore } from "@/lib/stores/commandUi";
import { useProjectStore } from "@/lib/stores/projects";
import { useTabStore } from "@/lib/stores/tabs";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import type { Project, Worktree } from "@/lib/types";

type DirtyTabCloseBehavior = "discard" | "save";

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

  async function runClose(saveBehavior: DirtyTabCloseBehavior): Promise<void> {
    setSubmitting(true);

    try {
      const result = await executeCommand({
        args: { saveBehavior, tabId },
        id: "tab.close",
        source: "dialog",
      });

      if (result.status === "success") {
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDiscard(): Promise<void> {
    await runClose("discard");
  }

  async function handleSave(): Promise<void> {
    await runClose("save");
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

function byPosition<T extends { id: string; position?: number }>(
  left: T,
  right: T,
): number {
  return (
    (left.position ?? 0) - (right.position ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

function worktreeSubtitle(project: Project, worktree: Worktree): string {
  return [project.name, worktree.branch].filter(Boolean).join(" • ");
}

function WorktreeSelectDialog({
  onClose,
  projects,
  selectedWorktreeId,
  worktreesByProject,
}: {
  onClose: () => void;
  projects: Project[];
  selectedWorktreeId: string | null;
  worktreesByProject: Record<string, Worktree[]>;
}) {
  const [query, setQuery] = useState("");
  const items = useMemo(() => {
    return [...projects].sort(byPosition).flatMap((project) =>
      [...(worktreesByProject[project.id] ?? [])]
        .sort(byPosition)
        .map((worktree) => ({
          project,
          searchText: [
            worktree.name,
            worktree.branch,
            project.name,
            project.path,
            worktree.path,
          ].join(" "),
          worktree,
        })),
    );
  }, [projects, worktreesByProject]);

  async function selectWorktree(worktreeId: string): Promise<void> {
    const result = await executeCommand({
      args: { worktreeId },
      id: "worktree.select",
      source: "dialog",
    });
    if (result.status === "success" || worktreeId === selectedWorktreeId) {
      onClose();
    }
  }

  return (
    <CommandDialog
      description="Search for a worktree to switch to."
      open
      title="Switch Worktree"
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <CommandInput
        placeholder="Switch worktree..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No worktrees found.</CommandEmpty>
        <CommandGroup heading="Worktrees">
          {items.map(({ project, searchText, worktree }) => (
            <CommandItem
              key={worktree.id}
              keywords={[
                project.name,
                project.path,
                worktree.branch,
                worktree.name,
                worktree.path,
              ]}
              onSelect={() => void selectWorktree(worktree.id)}
              value={searchText}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{worktree.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {worktreeSubtitle(project, worktree)}
                </span>
              </div>
              {worktree.id === selectedWorktreeId ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  Current
                </span>
              ) : null}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

export default function CommandDialogs() {
  const dialog = useCommandUiStore((state) => state.dialog);
  const closeDialog = useCommandUiStore((state) => state.closeDialog);
  const projects = useProjectStore((state) => state.projects);
  const worktreesByProject = useWorktreeStore(
    (state) => state.worktreesByProject,
  );
  const selectedWorktreeId = useWorktreeStore(
    (state) => state.selectedWorktreeId,
  );
  const tabs = useTabStore((state) => state.tabs);

  const activeProject =
    dialog && "projectId" in dialog
      ? (projects.find((project) => project.id === dialog.projectId) ?? null)
      : null;
  const scopedWorktrees =
    dialog && "projectId" in dialog
      ? (worktreesByProject[dialog.projectId] ?? [])
      : Object.values(worktreesByProject).flat();
  const activeWorktree =
    dialog && "worktreeId" in dialog
      ? (scopedWorktrees.find(
          (worktree) => worktree.id === dialog.worktreeId,
        ) ?? null)
      : null;
  const activeTab =
    dialog && "tabId" in dialog
      ? (tabs.find((tab) => tab.id === dialog.tabId) ?? null)
      : null;

  const hasStaleDialogReference =
    ((dialog?.type === "add-worktree" ||
      dialog?.type === "rename-project" ||
      dialog?.type === "remove-project") &&
      !activeProject) ||
    ((dialog?.type === "rename-worktree" ||
      dialog?.type === "remove-worktree") &&
      (!activeProject || !activeWorktree)) ||
    ((dialog?.type === "rename-terminal-tab" ||
      dialog?.type === "close-dirty-tab") &&
      !activeTab);

  useEffect(() => {
    if (hasStaleDialogReference) {
      closeDialog();
    }
  }, [closeDialog, hasStaleDialogReference]);

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
          onRemoveAndDeleteManaged={async () => {
            const result = await executeCommand({
              args: {
                deleteManagedWorktrees: true,
                force: dialog.forceManagedDelete,
                projectId: activeProject.id,
              },
              id: "project.remove",
              source: "dialog",
            });
            if (result.status === "success") {
              closeDialog();
            }
          }}
          onRemoveOnly={async () => {
            const result = await executeCommand({
              args: {
                deleteManagedWorktrees: false,
                projectId: activeProject.id,
              },
              id: "project.remove",
              source: "dialog",
            });
            if (result.status === "success") {
              closeDialog();
            }
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
              onConfirm={async () => {
                const result = await executeCommand({
                  args: {
                    force: true,
                    projectId: activeProject.id,
                    worktreeId: activeWorktree.id,
                  },
                  id: "worktree.remove",
                  source: "dialog",
                });
                if (result.status === "success") {
                  closeDialog();
                }
              }}
              title="Force Delete Worktree"
            />
          ) : (
            <WorktreeRemoveDialog
              isImported={activeWorktree.is_imported}
              onClose={closeDialog}
              onDeleteFromDisk={async () => {
                const result = await executeCommand({
                  args: {
                    force: false,
                    projectId: activeProject.id,
                    worktreeId: activeWorktree.id,
                  },
                  id: "worktree.remove",
                  source: "dialog",
                });
                if (result.status === "success") {
                  closeDialog();
                }
              }}
              onUntrackOnly={async () => {
                const result = await executeCommand({
                  args: {
                    projectId: activeProject.id,
                    untrackOnly: true,
                    worktreeId: activeWorktree.id,
                  },
                  id: "worktree.remove",
                  source: "dialog",
                });
                if (result.status === "success") {
                  closeDialog();
                }
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

      {dialog?.type === "select-worktree" ? (
        <WorktreeSelectDialog
          projects={projects}
          selectedWorktreeId={selectedWorktreeId}
          worktreesByProject={worktreesByProject}
          onClose={closeDialog}
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
