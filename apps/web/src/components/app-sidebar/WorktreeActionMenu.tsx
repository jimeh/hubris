import { Pencil, Trash2 } from "lucide-react";
import {
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";

export default function WorktreeActionMenu({
  onRename,
  onRemove,
}: {
  onRename: () => void;
  onRemove: () => void;
}) {
  return (
    <ContextMenuContent className="min-w-32 rounded-lg border-sidebar-border bg-sidebar p-1 text-sidebar-foreground">
      <ContextMenuItem
        className="rounded-md focus:bg-sidebar-accent focus:text-sidebar-accent-foreground"
        onSelect={onRename}
      >
        <Pencil className="mr-2 h-3.5 w-3.5" />
        Rename
      </ContextMenuItem>
      <ContextMenuItem
        variant="destructive"
        className="rounded-md focus:bg-sidebar-accent focus:text-destructive"
        onSelect={onRemove}
      >
        <Trash2 className="mr-2 h-3.5 w-3.5" />
        Delete
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
