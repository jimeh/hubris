import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { FileBrowser } from "./FileBrowser";

interface AddProjectDialogProps {
  onAdd: (path: string) => Promise<void>;
  onClose: () => void;
}

export function AddProjectDialog({ onAdd, onClose }: AddProjectDialogProps) {
  const [path, setPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (!path.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await onAdd(path.trim());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleSelect(selectedPath: string) {
    setPath(selectedPath);
    // Submit after setting path — use the selected
    // path directly since setState is async.
    (async () => {
      setSubmitting(true);
      setError("");
      try {
        await onAdd(selectedPath.trim());
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSubmitting(false);
      }
    })();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Project</DialogTitle>
          <DialogDescription>
            Browse to a directory or enter a path manually.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-3">
          <FileBrowser
            currentPath={path}
            onPathChange={setPath}
            onSelect={handleSelect}
          />
          <Separator />
          <div className="flex items-center gap-2">
            <Input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/home/user/repos/myproject"
              disabled={submitting}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              className="flex-1"
            />
            <Button onClick={submit} disabled={submitting || !path.trim()}>
              Add
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
