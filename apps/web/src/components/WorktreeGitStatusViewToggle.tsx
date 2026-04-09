import { FolderTree, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { WorktreeGitStatusViewMode } from "@/lib/stores/worktreeGitStatusView";
import { cn } from "@/lib/utils";

type Props = {
  viewMode: WorktreeGitStatusViewMode;
  onViewModeChange: (viewMode: WorktreeGitStatusViewMode) => void;
};

export default function WorktreeGitStatusViewToggle({
  viewMode,
  onViewModeChange,
}: Props) {
  return (
    <div className="inline-flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn(
          "rounded-md text-muted-foreground",
          viewMode === "list" &&
            "bg-sidebar-accent/70 text-sidebar-accent-foreground hover:bg-sidebar-accent/70",
        )}
        aria-label="Show list view"
        title="Show list view"
        aria-pressed={viewMode === "list"}
        onClick={() => onViewModeChange("list")}
      >
        <List className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn(
          "rounded-md text-muted-foreground",
          viewMode === "tree" &&
            "bg-sidebar-accent/70 text-sidebar-accent-foreground hover:bg-sidebar-accent/70",
        )}
        aria-label="Show tree view"
        title="Show tree view"
        aria-pressed={viewMode === "tree"}
        onClick={() => onViewModeChange("tree")}
      >
        <FolderTree className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
