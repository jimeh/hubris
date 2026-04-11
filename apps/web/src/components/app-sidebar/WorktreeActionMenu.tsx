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
    <ContextMenuContent className="min-w-32">
      <ContextMenuItem onSelect={onRename}>
        <Pencil className="mr-2 h-3.5 w-3.5" />
        Rename
      </ContextMenuItem>
      <ContextMenuItem variant="destructive" onSelect={onRemove}>
        <Trash2 className="mr-2 h-3.5 w-3.5" />
        Delete
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
