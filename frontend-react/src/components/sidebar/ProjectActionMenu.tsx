import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Ellipsis, Pencil, Trash2 } from "lucide-react";

interface ProjectActionMenuProps {
  onRename: () => void;
  onRemove: () => void;
}

export function ProjectActionMenu({
  onRename,
  onRemove,
}: ProjectActionMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={
          "rounded p-1 text-sidebar-foreground/70" +
          " transition-colors" +
          " hover:bg-sidebar-foreground/12" +
          " hover:text-sidebar-accent-foreground" +
          " focus-visible:bg-sidebar-foreground/12"
        }
        onClick={(e) => e.stopPropagation()}
        title="Project actions"
      >
        <Ellipsis className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        <DropdownMenuItem onClick={onRename}>
          <Pencil className="mr-2 h-3.5 w-3.5" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className={"text-destructive" + " focus:text-destructive"}
          onClick={onRemove}
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
