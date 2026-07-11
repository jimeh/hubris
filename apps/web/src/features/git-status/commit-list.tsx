import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { SidebarMenu, SidebarMenuItem } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import type { WorktreeGitCommitSummary } from "@/lib/api";
import {
  selectCommitDetails,
  useGitStatusStore,
  type CommitDetailsState,
} from "@/lib/stores/gitStatus";
import type { HubrisTheme } from "@/lib/theme/types";
import { buildWorktreeGitStatusTree } from "@/lib/worktreeGitStatusTree";
import { cn } from "@/lib/utils";
import {
  ChangeRowFrame,
  ChangeStatusBadge,
  FileIcon,
  SharedGitStatusTree,
} from "@/features/git-status/shared-tree";
import type {
  OpenGitDiff,
  SectionKey,
  TreeOpenState,
} from "@/features/git-status/types";

function formatCommitTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function CommitDetailsHoverCard({ state }: { state: CommitDetailsState }) {
  if (state.status === "loaded" && state.details) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {state.details.summary}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {state.details.id}
            </p>
          </div>
          <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
            {state.details.short_id}
          </Badge>
        </div>
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Author</dt>
          <dd className="truncate text-foreground">
            {state.details.author.name} &lt;{state.details.author.email}&gt;
          </dd>
          <dt className="text-muted-foreground">Authored</dt>
          <dd className="text-foreground">
            {formatCommitTimestamp(state.details.author.date)}
          </dd>
          <dt className="text-muted-foreground">Committer</dt>
          <dd className="truncate text-foreground">
            {state.details.committer.name} &lt;{state.details.committer.email}
            &gt;
          </dd>
          <dt className="text-muted-foreground">Committed</dt>
          <dd className="text-foreground">
            {formatCommitTimestamp(state.details.committer.date)}
          </dd>
        </dl>
        <div className="rounded-md border bg-background/70 p-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Message
          </p>
          <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-xs text-foreground">
            {state.details.message}
          </pre>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <p className="text-sm text-destructive">
        {state.error ?? "Failed to load commit details."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-3 w-52" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

function CommitRow({
  projectId,
  worktreeId,
  commit,
  index,
  lastIndex,
  expanded,
  theme,
  treeOpenState,
  onExpandedChange,
  onTreeOpenChange,
  onOpenDiff,
}: {
  projectId: string;
  worktreeId: string;
  commit: WorktreeGitCommitSummary;
  index: number;
  lastIndex: number;
  expanded: boolean;
  theme: HubrisTheme | null;
  treeOpenState: TreeOpenState;
  onExpandedChange: (open: boolean) => void;
  onTreeOpenChange: (path: string, open: boolean) => void;
  onOpenDiff: OpenGitDiff;
}) {
  const detailsState = useGitStatusStore((state) =>
    selectCommitDetails(state, commit.id),
  );
  const ensureCommitDetails = useGitStatusStore(
    (state) => state.ensureCommitDetails,
  );
  const tree = useMemo(
    () =>
      detailsState.details
        ? buildWorktreeGitStatusTree(detailsState.details.files)
        : [],
    [detailsState.details],
  );
  const requestDetails = () => {
    void ensureCommitDetails(projectId, worktreeId, commit.id);
  };

  return (
    <SidebarMenuItem className="relative min-w-0">
      <Collapsible
        open={expanded}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            requestDetails();
          }
          onExpandedChange(nextOpen);
        }}
        className="group/collapsible"
      >
        <HoverCard openDelay={180} closeDelay={120}>
          <HoverCardTrigger asChild>
            <div className="relative w-full min-w-0 overflow-hidden">
              {index > 0 ? (
                <span
                  className="pointer-events-none absolute -top-px left-[17px] bottom-[calc(50%+4px)] w-0.5 bg-sky-400/55"
                  data-testid="commit-marker-connector-before"
                  aria-hidden="true"
                />
              ) : null}
              {index < lastIndex ? (
                <span
                  className="pointer-events-none absolute top-[calc(50%+4px)] left-[17px] -bottom-px w-0.5 bg-sky-400/55"
                  data-testid="commit-marker-connector-after"
                  aria-hidden="true"
                />
              ) : null}
              <span
                className="pointer-events-none absolute inset-y-0 left-2 z-0 flex w-5 items-center justify-center"
                aria-hidden="true"
              >
                {index === 0 ? (
                  <span
                    className={cn(
                      "relative flex size-3 items-center justify-center rounded-full border-2 ring-2 ring-background",
                      expanded ? "border-sky-400" : "border-sky-400/80",
                    )}
                    data-testid="commit-marker-head"
                  >
                    <span className="size-2 rounded-full bg-background" />
                  </span>
                ) : (
                  <span
                    className={cn(
                      "size-2 rounded-full ring-2 ring-background",
                      expanded ? "bg-sky-400" : "bg-sky-400/80",
                    )}
                    data-testid="commit-marker-dot"
                  />
                )}
              </span>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="block w-full min-w-0 text-left"
                  data-testid="commit-row-trigger"
                  aria-label={`Toggle commit ${commit.summary}`}
                  onPointerEnter={requestDetails}
                  onFocus={requestDetails}
                >
                  <ChangeRowFrame
                    className={cn(
                      "w-full pl-8 pr-1.5",
                      expanded &&
                        "bg-sidebar-accent/55 text-sidebar-accent-foreground",
                    )}
                    primary={
                      <span className="block truncate font-medium text-sidebar-foreground">
                        {commit.summary}
                      </span>
                    }
                    badge={
                      <span className="shrink-0 font-mono text-[11px] tracking-[0.16em] text-sidebar-foreground/60">
                        {commit.short_id}
                      </span>
                    }
                  />
                </button>
              </CollapsibleTrigger>
            </div>
          </HoverCardTrigger>
          <HoverCardContent
            side="left"
            align="start"
            sideOffset={14}
            className="w-[24rem] rounded-xl border-sidebar-border/80 bg-popover/97 p-4 shadow-xl backdrop-blur"
          >
            <CommitDetailsHoverCard state={detailsState} />
          </HoverCardContent>
        </HoverCard>
        <CollapsibleContent>
          <div className="relative ml-[15px] pl-[9px] pt-1">
            {index < lastIndex ? (
              <span
                className="pointer-events-none absolute top-0 bottom-0 left-[2px] w-0.5 bg-sky-400/55"
                data-testid="commit-marker-connector-content"
                aria-hidden="true"
              />
            ) : null}
            {detailsState.status === "loading" ? (
              <div className="flex flex-col gap-2 py-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-48" />
              </div>
            ) : detailsState.status === "error" ? (
              <p className="py-2 text-sm text-destructive">
                {detailsState.error ?? "Failed to load commit diff."}
              </p>
            ) : detailsState.details ? (
              tree.length > 0 ? (
                <SharedGitStatusTree
                  nodes={tree}
                  className="gap-0.5 py-0.5"
                  scope="commit"
                  theme={theme}
                  openState={treeOpenState}
                  onOpenChange={onTreeOpenChange}
                  renderFileRow={(node) => (
                    <ChangeRowFrame
                      className="cursor-pointer"
                      interactive
                      onActivate={() =>
                        onOpenDiff(
                          node.path,
                          "commit",
                          node.change.original_path ?? undefined,
                          commit.id,
                          true,
                        )
                      }
                      primary={
                        <>
                          <span
                            aria-hidden="true"
                            className="h-4 w-4 shrink-0"
                          />
                          <FileIcon path={node.path} theme={theme} />
                          <span className="truncate text-[13px] font-medium">
                            {node.name}
                          </span>
                        </>
                      }
                      badge={
                        <ChangeStatusBadge
                          changeType={node.change.change_type}
                        />
                      }
                      onClick={() =>
                        onOpenDiff(
                          node.path,
                          "commit",
                          node.change.original_path ?? undefined,
                          commit.id,
                          true,
                        )
                      }
                      onDoubleClick={() =>
                        onOpenDiff(
                          node.path,
                          "commit",
                          node.change.original_path ?? undefined,
                          commit.id,
                          false,
                        )
                      }
                    />
                  )}
                  renderDirectoryRow={({ primary, badge }) => (
                    <ChangeRowFrame primary={primary} badge={badge} />
                  )}
                />
              ) : (
                <p className="py-2 text-sm text-muted-foreground">
                  No file changes in this commit.
                </p>
              )
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  );
}

export function CommitsSection({
  projectId,
  worktreeId,
  open,
  aheadCount,
  aheadCommits,
  comparisonAvailable,
  comparisonError,
  sourceRef,
  theme,
  commitOpenState,
  commitTreeOpenState,
  onOpenChange,
  onCommitOpenChange,
  onCommitTreeOpenChange,
  onOpenDiff,
}: {
  projectId: string;
  worktreeId: string;
  open: boolean;
  aheadCount: number;
  aheadCommits: WorktreeGitCommitSummary[];
  comparisonAvailable: boolean;
  comparisonError?: string | null;
  sourceRef?: string | null;
  theme: HubrisTheme | null;
  commitOpenState: TreeOpenState;
  commitTreeOpenState: Record<string, TreeOpenState>;
  onOpenChange: (section: SectionKey, open: boolean) => void;
  onCommitOpenChange: (commitId: string, open: boolean) => void;
  onCommitTreeOpenChange: (
    commitId: string,
    path: string,
    open: boolean,
  ) => void;
  onOpenDiff: OpenGitDiff;
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={(nextOpen) => onOpenChange("commits", nextOpen)}
      className="flex flex-col"
    >
      <div
        data-git-status-section-header="Commits"
        className={cn(
          "-mx-1 relative sticky top-3 z-10 border-b border-transparent bg-background px-1",
          "before:absolute before:inset-x-0 before:bottom-full before:h-3",
          "before:bg-background",
          "after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-4",
          "after:bg-gradient-to-b after:from-background after:via-background/85 after:to-transparent",
        )}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex w-full items-center justify-between gap-3 rounded-md px-1 py-1 text-left",
              "text-sidebar-foreground/90 hover:bg-sidebar-accent/60",
              "hover:text-sidebar-accent-foreground",
            )}
            aria-label="Commits"
          >
            <div className="flex min-w-0 items-center gap-2">
              <ChevronRight
                className={cn(
                  "shrink-0 transition-transform duration-150",
                  open && "rotate-90",
                )}
              />
              <h3 className="text-sm font-medium tracking-tight">Commits</h3>
              <Badge
                variant="secondary"
                className="rounded-full px-2.5 text-[11px] tabular-nums"
              >
                {aheadCount}
              </Badge>
            </div>
          </button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="pt-3">
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
          <div className="flex flex-col gap-2">
            <SidebarMenu className="gap-0">
              {aheadCommits.map((commit, index) => (
                <CommitRow
                  key={commit.id}
                  projectId={projectId}
                  worktreeId={worktreeId}
                  commit={commit}
                  index={index}
                  lastIndex={aheadCommits.length - 1}
                  expanded={commitOpenState[commit.id] ?? false}
                  theme={theme}
                  treeOpenState={commitTreeOpenState[commit.id] ?? {}}
                  onExpandedChange={(nextOpen) =>
                    onCommitOpenChange(commit.id, nextOpen)
                  }
                  onTreeOpenChange={(path, nextOpen) =>
                    onCommitTreeOpenChange(commit.id, path, nextOpen)
                  }
                  onOpenDiff={onOpenDiff}
                />
              ))}
            </SidebarMenu>
            {aheadCount > aheadCommits.length ? (
              <p className="text-xs text-muted-foreground">
                Showing newest {aheadCommits.length} of {aheadCount} commits.
              </p>
            ) : null}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
