import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";

export default function ProjectToggleIcon({
  isExpanded,
  forceChevron = false,
}: {
  isExpanded: boolean;
  forceChevron?: boolean;
}) {
  const FolderIcon = isExpanded ? FolderOpen : Folder;
  const ChevronIcon = isExpanded ? ChevronDown : ChevronRight;

  return (
    <span className="relative size-3.5 shrink-0">
      <FolderIcon
        className={cn(
          "absolute inset-0 h-3.5 w-3.5 transition-all duration-150",
          forceChevron
            ? "scale-85 opacity-0"
            : "group-hover/project-row:scale-85 group-hover/project-row:opacity-0",
        )}
      />
      <ChevronIcon
        className={cn(
          "absolute inset-0 h-3.5 w-3.5 transition-all duration-150",
          forceChevron
            ? "opacity-100"
            : "opacity-0 group-hover/project-row:opacity-100",
        )}
      />
    </span>
  );
}
