import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronRight,
  File,
  Folder,
  FolderTree,
  List,
  RefreshCw,
} from "lucide-react";
import {
  getProjectWorktreeGitStatus,
  type WorktreeGitCommitSummary,
  type WorktreeGitFileChange,
  type WorktreeGitStatus,
} from "@/lib/api";
import {
  buildWorktreeGitStatusTree,
  type WorktreeGitStatusTreeNode,
} from "@/lib/worktreeGitStatusTree";
import type { Worktree } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

type Props = {
  worktree: Worktree;
  onActionsChange?: (actions: ReactNode | null) => void;
};

type FileViewMode = "list" | "tree";
type TreeOpenState = Record<string, boolean>;

const LOADING_SKELETON_DELAY_MS = 150;

function changeTypeLabel(
  changeType: WorktreeGitFileChange["change_type"],
): string {
  switch (changeType) {
    case "added":
      return "A";
    case "copied":
      return "C";
    case "renamed":
      return "R";
    case "conflict":
      return "!";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "typechange":
      return "T";
    case "untracked":
      return "U";
  }
}

function splitChangePath(path: string): {
  basename: string;
  directoryPath: string | null;
} {
  const segments = path.split("/").filter(Boolean);
  const basename = segments[segments.length - 1] ?? path;
  const directoryPath =
    segments.length > 1 ? segments.slice(0, -1).join("/") : null;

  return { basename, directoryPath };
}

function ChangeBadge({
  changeType,
}: {
  changeType: WorktreeGitFileChange["change_type"];
}) {
  return (
    <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
      <span
        className={cn(
          "flex h-6 min-w-6 items-center justify-center rounded-full",
          "border border-sidebar-border/80 bg-background/70 px-1.5",
          "text-[10px] uppercase tracking-[0.2em] text-sidebar-foreground/80",
        )}
      >
        {changeTypeLabel(changeType)}
      </span>
    </div>
  );
}

function FilePathRow({
  change,
  treeAligned = false,
}: {
  change: WorktreeGitFileChange;
  treeAligned?: boolean;
}) {
  const { basename, directoryPath } = splitChangePath(change.path);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton className="h-8 pr-10 text-sidebar-foreground/90 hover:bg-sidebar-accent/60">
        {treeAligned ? (
          <span aria-hidden="true" className="h-4 w-4 shrink-0" />
        ) : null}
        <File className="text-sidebar-foreground/60" />
        <span className="grid min-w-0 flex-1 grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-2 overflow-hidden">
          <span className="shrink-0 text-[13px] font-medium text-sidebar-foreground">
            {basename}
          </span>
          {directoryPath ? (
            <span
              className="min-w-0 w-full truncate text-[11px] text-sidebar-foreground/55"
              title={directoryPath}
            >
              {directoryPath}
            </span>
          ) : (
            <span aria-hidden="true" className="min-w-0 w-full" />
          )}
        </span>
      </SidebarMenuButton>
      <ChangeBadge changeType={change.change_type} />
    </SidebarMenuItem>
  );
}

function StatusTreeNode({
  node,
  depth = 0,
  openState,
  onOpenChange,
}: {
  node: WorktreeGitStatusTreeNode;
  depth?: number;
  openState: TreeOpenState;
  onOpenChange: (path: string, open: boolean) => void;
}) {
  if (node.kind === "file") {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          className="h-7 pr-10 text-sidebar-foreground/90 hover:bg-sidebar-accent/60"
          data-depth={depth}
        >
          <span aria-hidden="true" className="h-4 w-4 shrink-0" />
          <File className="text-sidebar-foreground/60" />
          <span>{node.name}</span>
        </SidebarMenuButton>
        <ChangeBadge changeType={node.change.change_type} />
      </SidebarMenuItem>
    );
  }

  return (
    <StatusDirectoryNode
      node={node}
      depth={depth}
      openState={openState}
      onOpenChange={onOpenChange}
    />
  );
}

function StatusDirectoryNode({
  node,
  depth,
  openState,
  onOpenChange,
}: {
  node: Extract<WorktreeGitStatusTreeNode, { kind: "directory" }>;
  depth: number;
  openState: TreeOpenState;
  onOpenChange: (path: string, open: boolean) => void;
}) {
  const open = openState[node.path] ?? depth === 0;

  return (
    <SidebarMenuItem>
      <Collapsible
        open={open}
        onOpenChange={(nextOpen) => onOpenChange(node.path, nextOpen)}
        className="group/collapsible"
      >
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            className="h-7 text-sidebar-foreground/90 hover:bg-sidebar-accent/60"
            aria-label={`Toggle ${node.path}`}
          >
            <ChevronRight
              className={cn(
                "transition-transform duration-150",
                open && "rotate-90",
              )}
            />
            <Folder className="text-sidebar-foreground/60" />
            <span>{node.name}</span>
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ml-3 border-l border-sidebar-border/70 pl-3">
            <SidebarMenu className="gap-0.5 py-0.5">
              {node.children.map((child) => (
                <StatusTreeNode
                  key={child.path}
                  node={child}
                  depth={depth + 1}
                  openState={openState}
                  onOpenChange={onOpenChange}
                />
              ))}
            </SidebarMenu>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  );
}

function FileViewToggle({
  viewMode,
  onViewModeChange,
}: {
  viewMode: FileViewMode;
  onViewModeChange: (viewMode: FileViewMode) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-lg border border-border/70 bg-muted/40 p-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn(
          "rounded-md text-muted-foreground",
          viewMode === "list" &&
            "bg-background text-foreground shadow-xs hover:bg-background",
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
            "bg-background text-foreground shadow-xs hover:bg-background",
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

function StatusFileSection({
  title,
  changes,
  viewMode,
}: {
  title: string;
  changes: WorktreeGitFileChange[];
  viewMode: FileViewMode;
}) {
  const tree = useMemo(() => buildWorktreeGitStatusTree(changes), [changes]);
  const [treeOpenState, setTreeOpenState] = useState<TreeOpenState>({});

  const handleNodeOpenChange = useCallback((path: string, open: boolean) => {
    setTreeOpenState((current) => ({
      ...current,
      [path]: open,
    }));
  }, []);

  return (
    <section className="flex flex-col gap-3">
      <div
        data-git-status-section-header={title}
        className={cn(
          "-mx-1 relative sticky top-3 z-10 border-b border-transparent bg-background px-1",
          "before:absolute before:inset-x-0 before:bottom-full before:h-3",
          "before:bg-background",
          "after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-4",
          "after:bg-gradient-to-b after:from-background after:via-background/85 after:to-transparent",
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="text-sm font-medium tracking-tight">{title}</h3>
            <Badge
              variant="secondary"
              className="rounded-full px-2.5 text-[11px] tabular-nums"
            >
              {changes.length}
            </Badge>
          </div>
        </div>
      </div>
      {tree.length === 0 ? (
        <p className="text-sm text-muted-foreground">No changes.</p>
      ) : viewMode === "list" ? (
        <SidebarMenu>
          {changes.map((change) => (
            <FilePathRow key={change.path} change={change} />
          ))}
        </SidebarMenu>
      ) : (
        <SidebarMenu>
          {tree.map((node) => (
            <StatusTreeNode
              key={node.path}
              node={node}
              openState={treeOpenState}
              onOpenChange={handleNodeOpenChange}
            />
          ))}
        </SidebarMenu>
      )}
    </section>
  );
}

function AheadCommitList({
  aheadCount,
  aheadCommits,
  comparisonAvailable,
  comparisonError,
  sourceRef,
}: {
  aheadCount: number;
  aheadCommits: WorktreeGitCommitSummary[];
  comparisonAvailable: boolean;
  comparisonError?: string | null;
  sourceRef?: string | null;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div
        data-git-status-section-header={`Ahead of ${sourceRef ?? "source ref"}`}
        className={cn(
          "-mx-1 relative sticky top-3 z-10 border-b border-transparent bg-background px-1",
          "before:absolute before:inset-x-0 before:bottom-full before:h-3",
          "before:bg-background",
          "after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-4",
          "after:bg-gradient-to-b after:from-background after:via-background/85 after:to-transparent",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">
            Ahead of {sourceRef ?? "source ref"}
          </h3>
          <Badge variant="secondary">{aheadCount}</Badge>
        </div>
      </div>
      {!comparisonAvailable ? (
        <p className="text-sm text-muted-foreground">
          No stored source branch for this worktree yet.
        </p>
      ) : comparisonError ? (
        <p className="text-sm text-destructive">{comparisonError}</p>
      ) : aheadCommits.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No commits ahead of {sourceRef}.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {aheadCommits.map((commit) => (
            <div
              key={commit.id}
              className="rounded-md border px-2 py-1.5 text-sm"
            >
              <div className="flex items-center gap-2">
                <Badge variant="outline">{commit.short_id}</Badge>
                <span className="truncate">{commit.summary}</span>
              </div>
            </div>
          ))}
          {aheadCount > aheadCommits.length ? (
            <p className="text-xs text-muted-foreground">
              Showing newest {aheadCommits.length} of {aheadCount} commits.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

export default function WorktreeGitStatusPanel({
  worktree,
  onActionsChange,
}: Props) {
  const [status, setStatus] = useState<WorktreeGitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useState<FileViewMode>("list");
  const [showLoadingSkeleton, setShowLoadingSkeleton] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const nextStatus = await getProjectWorktreeGitStatus(
        worktree.project_id,
        worktree.id,
      );
      setStatus(nextStatus);
    } catch (loadError) {
      setError(`Failed to load git status (${(loadError as Error).message})`);
    } finally {
      setLoading(false);
    }
  }, [worktree.id, worktree.project_id]);

  const headerActions = useMemo(
    () => (
      <>
        <FileViewToggle viewMode={viewMode} onViewModeChange={setViewMode} />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void loadStatus()}
          title="Refresh git status"
          aria-label="Refresh git status"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </>
    ),
    [loadStatus, loading, viewMode],
  );

  useEffect(() => {
    setStatus(null);
    setError("");
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!loading || status || error) {
      setShowLoadingSkeleton(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setShowLoadingSkeleton(true);
    }, LOADING_SKELETON_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [error, loading, status]);

  useEffect(() => {
    onActionsChange?.(headerActions);
    return () => onActionsChange?.(null);
  }, [headerActions, onActionsChange]);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex min-h-full flex-col gap-4 p-3">
        {loading && !status && showLoadingSkeleton ? (
          <>
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-20 w-full rounded-md" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-20 w-full rounded-md" />
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-16 w-full rounded-md" />
          </>
        ) : loading && !status ? null : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : status ? (
          <>
            <StatusFileSection
              title="Unstaged"
              changes={status.unstaged_files}
              viewMode={viewMode}
            />
            <Separator />
            <StatusFileSection
              title="Staged"
              changes={status.staged_files}
              viewMode={viewMode}
            />
            <Separator />
            <AheadCommitList
              aheadCount={status.ahead_count}
              aheadCommits={status.ahead_commits}
              comparisonAvailable={status.comparison_available}
              comparisonError={status.comparison_error}
              sourceRef={status.source_ref}
            />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No git status loaded.</p>
        )}
      </div>
    </ScrollArea>
  );
}
