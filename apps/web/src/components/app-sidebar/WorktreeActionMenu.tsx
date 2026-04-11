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
    <ContextMenuContent className="min-w-32 border-sidebar-border text-sidebar-foreground">
      <ContextMenuItem
        className="rounded-md text-sidebar-foreground focus:bg-sidebar-accent focus:text-sidebar-accent-foreground [&_svg:not([class*='text-'])]:text-sidebar-foreground/70"
        onSelect={onRename}
      >
        <Pencil className="mr-2 h-3.5 w-3.5" />
        Rename
      </ContextMenuItem>
      <ContextMenuItem
        variant="destructive"
        className="rounded-md text-sidebar-foreground focus:bg-sidebar-accent focus:text-sidebar-accent-foreground data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg:not([class*='text-'])]:text-sidebar-foreground/70"
        onSelect={onRemove}
      >
        <Trash2 className="mr-2 h-3.5 w-3.5" />
        Delete
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
