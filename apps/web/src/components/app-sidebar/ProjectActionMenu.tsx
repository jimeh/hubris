import { Ellipsis, Pencil, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export default function ProjectActionMenu({
  onRename,
  onRemove,
  triggerClassName,
}: {
  onRename: () => void;
  onRemove: () => void;
  triggerClassName?: string;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex size-6 items-center justify-center text-sidebar-foreground/55 transition-[color,opacity] outline-none",
            "hover:opacity-100 hover:text-sidebar-foreground focus-visible:text-sidebar-foreground",
            triggerClassName,
          )}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          title="Project actions"
          aria-label="Project actions"
        >
          <Ellipsis className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="min-w-32 rounded-lg border-sidebar-border bg-sidebar p-1 text-sidebar-foreground"
      >
        <DropdownMenuItem
          className="rounded-md focus:bg-sidebar-accent focus:text-sidebar-accent-foreground"
          onClick={onRename}
        >
          <Pencil className="mr-2 h-3.5 w-3.5" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          className="rounded-md text-destructive focus:bg-sidebar-accent focus:text-destructive"
          onClick={onRemove}
        >
          <X className="mr-2 h-3.5 w-3.5" />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
