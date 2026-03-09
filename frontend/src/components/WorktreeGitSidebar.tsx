import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  File,
  Folder,
  GitBranch,
  RefreshCw,
} from "lucide-react";
import {
  getProjectWorktreeGitStatus,
  type WorktreeGitCommitSummary,
  type WorktreeGitFileChange,
  type WorktreeGitStatus,
} from "@/lib/api";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  buildWorktreeGitStatusTree,
  type WorktreeGitStatusTreeNode,
} from "@/lib/worktreeGitStatusTree";
import { useWorktreeGitSidebarStore } from "@/lib/stores/worktreeGitSidebar";
import type { Worktree } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import WorktreeGitSidebarResizeHandle from "@/components/WorktreeGitSidebarResizeHandle";

const DESKTOP_RAIL_WIDTH_PX = 44;

type Props = {
  worktree: Worktree;
};

function changeTypeLabel(
  changeType: WorktreeGitFileChange["change_type"],
): string {
  switch (changeType) {
    case "added":
      return "A";
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

function StatusTreeNode({
  node,
  depth = 0,
}: {
  node: WorktreeGitStatusTreeNode;
  depth?: number;
}) {
  if (node.kind === "file") {
    return (
      <div
        className="flex items-center gap-2 rounded-md px-2 py-1.5"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm">{node.name}</span>
        <Badge variant="outline" className="min-w-6 justify-center px-1.5">
          {changeTypeLabel(node.change.change_type)}
        </Badge>
      </div>
    );
  }

  return (
    <Collapsible defaultOpen={depth < 1} className="group/tree">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
        >
          <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-data-[state=open]/tree:rotate-90" />
          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.name}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-0.5">
          {node.children.map((child) => (
            <StatusTreeNode key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function StatusFileSection({
  title,
  changes,
}: {
  title: string;
  changes: WorktreeGitFileChange[];
}) {
  const tree = useMemo(() => buildWorktreeGitStatusTree(changes), [changes]);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <Badge variant="secondary">{changes.length}</Badge>
      </div>
      {tree.length === 0 ? (
        <p className="text-sm text-muted-foreground">No changes.</p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {tree.map((node) => (
            <StatusTreeNode key={node.path} node={node} />
          ))}
        </div>
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
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          Ahead of {sourceRef ?? "source ref"}
        </h3>
        <Badge variant="secondary">{aheadCount}</Badge>
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

function StatusPanelContent({
  worktree,
  loading,
  error,
  status,
  onRefresh,
}: {
  worktree: Worktree;
  loading: boolean;
  error: string;
  status: WorktreeGitStatus | null;
  onRefresh: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">Git status</h2>
          <p className="truncate text-xs text-muted-foreground">
            {worktree.name}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRefresh}
          title="Refresh git status"
          aria-label="Refresh git status"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-4 p-3">
          {loading && !status ? (
            <>
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-20 w-full rounded-md" />
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-20 w-full rounded-md" />
              <Skeleton className="h-5 w-28" />
              <Skeleton className="h-16 w-full rounded-md" />
            </>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : status ? (
            <>
              <StatusFileSection
                title="Unstaged"
                changes={status.unstaged_files}
              />
              <Separator />
              <StatusFileSection title="Staged" changes={status.staged_files} />
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
            <p className="text-sm text-muted-foreground">
              No git status loaded.
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export default function WorktreeGitSidebar({ worktree }: Props) {
  const isMobile = useIsMobile();
  const desktopOpen = useWorktreeGitSidebarStore((state) => state.desktopOpen);
  const mobileOpen = useWorktreeGitSidebarStore((state) => state.mobileOpen);
  const setMobileOpen = useWorktreeGitSidebarStore(
    (state) => state.setMobileOpen,
  );
  const toggleDesktop = useWorktreeGitSidebarStore(
    (state) => state.toggleDesktop,
  );
  const [status, setStatus] = useState<WorktreeGitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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

  useEffect(() => {
    setStatus(null);
    setError("");
    void loadStatus();
  }, [loadStatus]);

  return (
    <>
      <div
        data-worktree-git-sidebar-wrapper
        className="relative hidden shrink-0 border-l bg-background transition-[width] duration-200 ease-linear md:flex md:flex-col"
        style={{
          width: desktopOpen
            ? "var(--worktree-git-sidebar-width, 320px)"
            : `${DESKTOP_RAIL_WIDTH_PX}px`,
        }}
      >
        {desktopOpen ? (
          <>
            {!isMobile ? <WorktreeGitSidebarResizeHandle /> : null}
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-medium">
                  Worktree Git
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleDesktop}
                title="Collapse git sidebar"
                aria-label="Collapse git sidebar"
              >
                <ChevronsRight className="h-4 w-4" />
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <StatusPanelContent
                worktree={worktree}
                loading={loading}
                error={error}
                status={status}
                onRefresh={() => void loadStatus()}
              />
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center gap-2 py-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleDesktop}
              title="Expand git sidebar"
              aria-label="Expand git sidebar"
            >
              <ChevronsLeft className="h-4 w-4" />
            </Button>
            <Separator className="w-6" />
            <GitBranch className="h-4 w-4 text-muted-foreground" />
          </div>
        )}
      </div>

      <Sheet open={isMobile && mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="right"
          className="w-full max-w-none gap-0 p-0 sm:max-w-md"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Worktree git status</SheetTitle>
            <SheetDescription>
              Review staged, unstaged, and ahead changes.
            </SheetDescription>
          </SheetHeader>
          <StatusPanelContent
            worktree={worktree}
            loading={loading}
            error={error}
            status={status}
            onRefresh={() => void loadStatus()}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
