import { AlertTriangle, Folder, FolderX, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type Props = {
  worktreeName: string;
  isImported?: boolean;
  onUntrackOnly: () => void;
  onDeleteFromDisk: () => void;
  onClose: () => void;
};

export default function WorktreeRemoveDialog({
  worktreeName,
  isImported = false,
  onUntrackOnly,
  onDeleteFromDisk,
  onClose,
}: Props) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader className="gap-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-xl border border-destructive/20 bg-destructive/8 p-2 text-destructive">
              {isImported ? (
                <AlertTriangle className="h-4 w-4" />
              ) : (
                <FolderX className="h-4 w-4" />
              )}
            </div>
            <div className="space-y-1">
              <DialogTitle>
                {isImported ? "Remove imported worktree" : "Remove worktree"}
              </DialogTitle>
              <DialogDescription>
                {isImported ? (
                  <>
                    <span className="font-medium text-foreground">
                      {worktreeName}
                    </span>{" "}
                    was not created by Hubris. Choose how to remove it.
                  </>
                ) : (
                  <>
                    Choose how to remove{" "}
                    <span className="font-medium text-foreground">
                      {worktreeName}
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
                <h3 className="text-sm font-semibold">Remove from Hubris</h3>
                <p className="text-sm text-muted-foreground">
                  Stop tracking this worktree in Hubris. The worktree directory
                  stays on disk and remains a valid git worktree.
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              className="mt-4 w-full justify-center"
              onClick={onUntrackOnly}
            >
              Remove from Hubris
            </Button>
          </section>

          <section className="rounded-xl border border-destructive/20 bg-destructive/6 p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-lg border border-destructive/20 bg-background p-2 text-destructive">
                <Trash2 className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <h3 className="text-sm font-semibold text-foreground">
                  Delete from disk
                </h3>
                <p className="text-sm text-muted-foreground">
                  {isImported
                    ? "Remove the worktree directory from disk via git. This worktree was not created by Hubris \u2014 other tools or scripts that manage it may get confused."
                    : "Remove the worktree directory from disk via git."}
                </p>
              </div>
            </div>
            <Button
              variant="destructive"
              className="mt-4 w-full justify-center"
              onClick={onDeleteFromDisk}
            >
              Delete from disk
            </Button>
          </section>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
