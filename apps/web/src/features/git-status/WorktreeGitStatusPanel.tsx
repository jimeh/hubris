import { useCallback, useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { CommitsSection } from "@/features/git-status/commit-list";
import { StatusFileSection } from "@/features/git-status/status-tree";
import type {
  DiffScope,
  SectionKey,
  SectionOpenState,
  TreeOpenState,
} from "@/features/git-status/types";
import {
  selectPendingGitStatusAction,
  useGitStatusStore,
  type GitStatusAction,
} from "@/lib/stores/gitStatus";
import { useWorktreeFileManagerStore } from "@/lib/stores/worktreeFileManager";
import {
  DEFAULT_WORKTREE_GIT_STATUS_VIEW_MODE,
  useWorktreeGitStatusViewStore,
} from "@/lib/stores/worktreeGitStatusView";
import { useTabStore } from "@/lib/stores/tabs";
import { useThemeSettings } from "@/lib/stores/theme";
import type { Worktree } from "@/lib/types";

type Props = {
  worktree: Worktree;
};

type SectionOpenStateByWorktree = Record<string, SectionOpenState>;
type TreeOpenStateByWorktree = Record<string, TreeOpenState>;
type CommitTreeOpenStateByWorktree = Record<
  string,
  Record<string, TreeOpenState>
>;
type PendingDiscard = {
  path: string;
  label: string;
  recursive: boolean;
};

const LOADING_SKELETON_DELAY_MS = 150;
const DEFAULT_SECTION_OPEN_STATE: SectionOpenState = {
  commits: true,
  staged: true,
  unstaged: true,
};

/** Displays the active worktree's status, changes, and ahead commits. */
export default function WorktreeGitStatusPanel({ worktree }: Props) {
  const [sectionOpenStateByWorktree, setSectionOpenStateByWorktree] =
    useState<SectionOpenStateByWorktree>({});
  const [commitOpenStateByWorktree, setCommitOpenStateByWorktree] =
    useState<TreeOpenStateByWorktree>({});
  const [commitTreeOpenStateByWorktree, setCommitTreeOpenStateByWorktree] =
    useState<CommitTreeOpenStateByWorktree>({});
  const [skeletonRequestKey, setSkeletonRequestKey] = useState<string | null>(
    null,
  );
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(
    null,
  );
  const worktreeState = useWorktreeFileManagerStore(
    (state) => state.worktrees[worktree.id],
  );
  const setSelectedPath = useWorktreeFileManagerStore(
    (state) => state.setSelectedPath,
  );
  const pendingActionKey = useGitStatusStore((state) =>
    selectPendingGitStatusAction(state, worktree.id),
  );
  const runAction = useGitStatusStore((state) => state.runAction);
  const viewMode = useWorktreeGitStatusViewStore(
    (state) =>
      state.viewModeByWorktree[worktree.id] ??
      DEFAULT_WORKTREE_GIT_STATUS_VIEW_MODE,
  );
  const openGitDiff = useTabStore((state) => state.openGitDiff);
  const theme = useThemeSettings((state) => state.activeTheme);
  const status = worktreeState?.gitStatus ?? null;
  const loading = worktreeState?.gitStatusStatus === "loading";
  const loadingRequestKey = `${worktree.id}:${worktreeState?.pendingGitGeneration ?? 0}`;
  const error = worktreeState?.gitError
    ? `Failed to load git status (${worktreeState.gitError})`
    : "";
  const sectionOpenState =
    sectionOpenStateByWorktree[worktree.id] ?? DEFAULT_SECTION_OPEN_STATE;
  const commitOpenState = commitOpenStateByWorktree[worktree.id] ?? {};
  const commitTreeOpenState = commitTreeOpenStateByWorktree[worktree.id] ?? {};

  const dispatchAction = useCallback(
    (
      action: GitStatusAction,
      path: string,
      originalPath: string | undefined,
      label: string,
      recursive: boolean,
    ) => {
      if (action === "discard") {
        setPendingDiscard({ path, label, recursive });
        return;
      }
      void runAction({
        action,
        projectId: worktree.project_id,
        worktreeId: worktree.id,
        path,
        originalPath,
        label,
      });
    },
    [runAction, worktree.id, worktree.project_id],
  );

  const handleOpenDiff = useCallback(
    (
      path: string,
      scope: DiffScope,
      originalPath: string | undefined,
      commitId: string | undefined,
      preview: boolean,
    ) => {
      setSelectedPath(worktree.id, path);
      void openGitDiff({
        worktreeId: worktree.id,
        path,
        scope,
        originalPath,
        commitId,
        preview,
      });
    },
    [openGitDiff, setSelectedPath, worktree.id],
  );

  const confirmDiscard = useCallback(async () => {
    if (!pendingDiscard) {
      return;
    }
    const current = pendingDiscard;
    setPendingDiscard(null);
    await runAction({
      action: "discard",
      projectId: worktree.project_id,
      worktreeId: worktree.id,
      path: current.path,
      label: current.label,
    });
  }, [pendingDiscard, runAction, worktree.id, worktree.project_id]);

  const handleSectionOpenChange = useCallback(
    (section: SectionKey, nextOpen: boolean) => {
      setSectionOpenStateByWorktree((current) => ({
        ...current,
        [worktree.id]: {
          ...(current[worktree.id] ?? DEFAULT_SECTION_OPEN_STATE),
          [section]: nextOpen,
        },
      }));
    },
    [worktree.id],
  );

  const handleCommitOpenChange = useCallback(
    (commitId: string, nextOpen: boolean) => {
      setCommitOpenStateByWorktree((current) => ({
        ...current,
        [worktree.id]: {
          ...(current[worktree.id] ?? {}),
          [commitId]: nextOpen,
        },
      }));
    },
    [worktree.id],
  );

  const handleCommitTreeOpenChange = useCallback(
    (commitId: string, path: string, nextOpen: boolean) => {
      setCommitTreeOpenStateByWorktree((current) => ({
        ...current,
        [worktree.id]: {
          ...(current[worktree.id] ?? {}),
          [commitId]: {
            ...((current[worktree.id] ?? {})[commitId] ?? {}),
            [path]: nextOpen,
          },
        },
      }));
    },
    [worktree.id],
  );

  useEffect(() => {
    if (!loading || status || error) {
      return;
    }

    const timer = window.setTimeout(() => {
      setSkeletonRequestKey(loadingRequestKey);
    }, LOADING_SKELETON_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [error, loading, loadingRequestKey, status]);

  const showLoadingSkeleton =
    loading && !status && !error && skeletonRequestKey === loadingRequestKey;

  return (
    <>
      <ScrollArea data-git-status className="min-h-0 flex-1">
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
                title="Staged"
                section="staged"
                open={sectionOpenState.staged}
                changes={status.staged_files}
                viewMode={viewMode}
                theme={theme}
                disabled={pendingActionKey !== null}
                onOpenChange={handleSectionOpenChange}
                onOpenDiff={handleOpenDiff}
                onAction={dispatchAction}
              />
              <Separator />
              <StatusFileSection
                title="Unstaged"
                section="unstaged"
                open={sectionOpenState.unstaged}
                changes={status.unstaged_files}
                viewMode={viewMode}
                theme={theme}
                disabled={pendingActionKey !== null}
                onOpenChange={handleSectionOpenChange}
                onOpenDiff={handleOpenDiff}
                onAction={dispatchAction}
              />
              <Separator />
              <CommitsSection
                projectId={worktree.project_id}
                worktreeId={worktree.id}
                open={sectionOpenState.commits}
                aheadCount={status.ahead_count}
                aheadCommits={status.ahead_commits}
                comparisonAvailable={status.comparison_available}
                comparisonError={status.comparison_error}
                sourceRef={status.source_ref}
                theme={theme}
                commitOpenState={commitOpenState}
                commitTreeOpenState={commitTreeOpenState}
                onOpenChange={handleSectionOpenChange}
                onCommitOpenChange={handleCommitOpenChange}
                onCommitTreeOpenChange={handleCommitTreeOpenChange}
                onOpenDiff={handleOpenDiff}
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No git status loaded.
            </p>
          )}
        </div>
      </ScrollArea>
      <AlertDialog
        open={pendingDiscard !== null}
        onOpenChange={(nextOpen: boolean) => {
          if (!nextOpen) {
            setPendingDiscard(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Discard changes in {pendingDiscard?.label}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDiscard?.recursive
                ? "This will discard tracked edits and remove untracked files in this subtree."
                : "This will discard tracked edits and remove untracked content for this file."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                void confirmDiscard();
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
