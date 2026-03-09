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
import FileBrowser from "@/components/FileBrowser";

type Props = {
  onAdd: (path: string) => Promise<void>;
  onClose: () => void;
};

export default function AddProjectDialog({ onAdd, onClose }: Props) {
  const [path, setPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit(nextPath = path): Promise<void> {
    if (!nextPath.trim()) {
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      await onAdd(nextPath.trim());
    } catch (submitError) {
      setError((submitError as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
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
            onCurrentPathChange={setPath}
            onSelect={(selectedPath) => {
              setPath(selectedPath);
              void submit(selectedPath);
            }}
          />
          <Separator />
          <div className="flex items-center gap-2">
            <Input
              type="text"
              value={path}
              placeholder="/home/user/repos/myproject"
              disabled={submitting}
              onChange={(event) => setPath(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void submit();
                }
              }}
              className="flex-1"
            />
            <Button
              onClick={() => void submit()}
              disabled={submitting || !path.trim()}
            >
              Add
            </Button>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
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
