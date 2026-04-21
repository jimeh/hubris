import { useState } from "react";
import { Folder, FolderX, GitBranchPlus, ShieldAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type ProjectRemoveDialogProps = {
  projectName: string;
  forceManagedDelete?: boolean;
  onRemoveOnly: () => Promise<void> | void;
  onRemoveAndDeleteManaged: () => Promise<void> | void;
  onClose: () => void;
};

export default function ProjectRemoveDialog({
  projectName,
  forceManagedDelete = false,
  onRemoveOnly,
  onRemoveAndDeleteManaged,
  onClose,
}: ProjectRemoveDialogProps) {
  const [submitting, setSubmitting] = useState(false);

  async function handleAction(
    action: () => Promise<void> | void,
  ): Promise<void> {
    setSubmitting(true);

    try {
      await action();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader className="gap-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-xl border border-destructive/20 bg-destructive/8 p-2 text-destructive">
              {forceManagedDelete ? (
                <ShieldAlert className="h-4 w-4" />
              ) : (
                <FolderX className="h-4 w-4" />
              )}
            </div>
            <div className="space-y-1">
              <DialogTitle>
                {forceManagedDelete ? "Force remove project" : "Remove project"}
              </DialogTitle>
              <DialogDescription>
                {forceManagedDelete ? (
                  <>
                    <span className="font-medium text-foreground">
                      {projectName}
                    </span>{" "}
                    has Hubris-managed worktrees with uncommitted changes or a
                    busy state.
                  </>
                ) : (
                  <>
                    Choose how Hubris should remove{" "}
                    <span className="font-medium text-foreground">
                      {projectName}
                    </span>
                    .
                  </>
                )}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="grid gap-3">
          <section className="rounded-xl border bg-muted/25 p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-lg border bg-background p-2 text-muted-foreground">
                <Folder className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <h3 className="text-sm font-semibold">Remove only</h3>
                <p className="text-sm text-muted-foreground">
                  Remove the project from Hubris and leave all worktrees and
                  directories on disk.
                </p>
              </div>
            </div>
            <Button
              disabled={submitting}
              variant="outline"
              className="mt-4 w-full justify-center"
              onClick={() => void handleAction(onRemoveOnly)}
            >
              Remove only
            </Button>
          </section>

          <section className="rounded-xl border border-destructive/20 bg-destructive/6 p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-lg border border-destructive/20 bg-background p-2 text-destructive">
                <GitBranchPlus className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <h3 className="text-sm font-semibold text-foreground">
                  {forceManagedDelete
                    ? "Force remove and delete managed worktrees"
                    : "Remove and delete managed worktrees"}
                </h3>
                <p className="text-sm text-muted-foreground">
                  Delete only Hubris-managed worktrees for this project.
                  Git-linked worktrees outside Hubris are left alone.
                </p>
              </div>
            </div>
            <Button
              disabled={submitting}
              variant="destructive"
              className="mt-4 w-full justify-center"
              onClick={() => void handleAction(onRemoveAndDeleteManaged)}
            >
              {forceManagedDelete
                ? "Force remove + delete managed worktrees"
                : "Remove + delete managed worktrees"}
            </Button>
          </section>
        </div>

        <DialogFooter>
          <Button disabled={submitting} variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
