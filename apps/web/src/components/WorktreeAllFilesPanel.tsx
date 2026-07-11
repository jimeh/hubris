import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronRight, Copy, Link2, PencilLine } from "lucide-react";
import { toast } from "sonner";
import type { WorktreeGitStatus } from "@/lib/api";
import {
  TreeView,
  type TreeBranchRenderProps,
  type TreeRowRenderProps,
} from "@/components/tree/TreeView";
import type { TreeExpansionSource } from "@/components/tree/treeExpansionStore";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  resolveMaterialFileIcon,
  resolveMaterialFolderIcon,
} from "@/lib/materialIconTheme";
import {
  gitChangeTypeClass,
  gitChangeTypeLabel,
  mostSignificantGitChangeType,
  type GitChangeType,
} from "@/lib/gitChangePresentation";
import { useTabStore } from "@/lib/stores/tabs";
import {
  selectWorktreeFileRowSnapshot,
  useWorktreeFileManagerStore,
} from "@/lib/stores/worktreeFileManager";
import { useThemeSettings } from "@/lib/stores/theme";
import type { HubrisTheme } from "@/lib/theme/types";
import type { Worktree, WorktreeFileEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  worktree: Worktree;
};

type DirectoryState = {
  status:
    | "idle"
    | "loading-initial"
    | "loading-refresh"
    | "loaded"
    | "error-initial"
    | "error-refresh";
  entries: WorktreeFileEntry[];
  error: string | null;
};

type DecorationState = {
  gitStatus: WorktreeGitStatus | null;
};

const NESTED_LOADING_PLACEHOLDER_DELAY_MS = 175;
const REFRESH_PULSE_DELAY_MS = 200;

function buildDecorations(worktreeState: DecorationState): {
  fileChanges: Map<string, GitChangeType>;
  directoryChanges: Map<string, GitChangeType>;
} {
  const fileChanges = new Map<string, GitChangeType>();
  const directoryChanges = new Map<string, GitChangeType>();

  function record(changeType: GitChangeType, path: string): void {
    fileChanges.set(path, changeType);
    const segments = path.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments.slice(0, -1)) {
      current = current ? `${current}/${segment}` : segment;
      directoryChanges.set(
        current,
        mostSignificantGitChangeType(
          [changeType, directoryChanges.get(current)].filter(
            (value): value is GitChangeType => value != null,
          ),
        ) ?? changeType,
      );
    }
  }

  for (const change of worktreeState.gitStatus?.staged_files ?? []) {
    record(change.change_type as GitChangeType, change.path);
  }
  for (const change of worktreeState.gitStatus?.unstaged_files ?? []) {
    record(change.change_type as GitChangeType, change.path);
  }

  return { fileChanges, directoryChanges };
}

function FolderIcon({
  name,
  open,
  theme,
  isSymlink,
}: {
  name: string;
  open: boolean;
  theme: HubrisTheme | null;
  isSymlink: boolean;
}) {
  const icon = resolveMaterialFolderIcon(name, theme, open);

  return (
    <span className="relative h-5 w-5 shrink-0">
      <img
        src={icon.iconPath}
        alt=""
        className="hubris-explorer-icon h-5 w-5 object-contain"
        data-testid={open ? "folder-icon-open" : "folder-icon-closed"}
        data-icon-id={icon.iconId}
        aria-hidden="true"
        draggable={false}
      />
      {isSymlink ? <SymlinkBadge /> : null}
    </span>
  );
}

function FileIcon({
  path,
  theme,
  isSymlink,
}: {
  path: string;
  theme: HubrisTheme | null;
  isSymlink: boolean;
}) {
  const icon = resolveMaterialFileIcon(path, theme);

  return (
    <span className="relative h-5 w-5 shrink-0">
      <img
        src={icon.iconPath}
        alt=""
        className="hubris-explorer-icon h-5 w-5 object-contain"
        data-testid="file-icon-manifest"
        data-icon-id={icon.iconId}
        aria-hidden="true"
        draggable={false}
      />
      {isSymlink ? <SymlinkBadge /> : null}
    </span>
  );
}

function SymlinkBadge() {
  return (
    <span
      className="absolute -right-1 -bottom-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-sidebar-border/80 bg-sidebar-background shadow-sm"
      data-testid="symlink-indicator"
      aria-hidden="true"
    >
      <Link2 className="h-2.5 w-2.5 text-sidebar-foreground/75" />
    </span>
  );
}

function ExplorerDecoration({
  changeType,
  directory = false,
}: {
  changeType?: GitChangeType;
  directory?: boolean;
}) {
  if (directory) {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        {changeType ? (
          <span
            className={cn(
              "h-2 w-2 rounded-full bg-current opacity-65",
              gitChangeTypeClass(changeType),
            )}
          />
        ) : (
          <span className="h-5 w-5 shrink-0" aria-hidden="true" />
        )}
      </span>
    );
  }

  if (!changeType) {
    return <span className="h-5 w-5 shrink-0" aria-hidden="true" />;
  }

  return (
    <span
      className={cn(
        "flex h-5 min-w-5 items-center justify-center rounded-full text-[10px] font-semibold tracking-[0.18em]",
        gitChangeTypeClass(changeType),
      )}
    >
      {gitChangeTypeLabel(changeType)}
    </span>
  );
}

function rowLabelClass({ changeType }: { changeType?: GitChangeType }): string {
  return changeType
    ? cn("text-[13px] font-medium", gitChangeTypeClass(changeType))
    : "text-[13px] font-medium";
}

function hasLoadedDirectoryState(directoryState?: DirectoryState): boolean {
  return Boolean(directoryState && directoryState.status !== "idle");
}

function isDirectoryInitialLoading(directoryState?: DirectoryState): boolean {
  return directoryState?.status === "loading-initial";
}

function isDirectoryRefreshLoading(directoryState?: DirectoryState): boolean {
  return directoryState?.status === "loading-refresh";
}

function isDirectoryInitialError(directoryState?: DirectoryState): boolean {
  return directoryState?.status === "error-initial";
}

function isDirectoryRefreshError(directoryState?: DirectoryState): boolean {
  return directoryState?.status === "error-refresh";
}

function RowContextMenu({
  entry,
  worktree,
  children,
  onRename,
}: {
  entry: WorktreeFileEntry;
  worktree: Worktree;
  children: ReactNode;
  onRename: () => void;
}) {
  const absolutePath = `${worktree.path}/${entry.path}`;
  const preventCloseAutoFocusRef = useRef(false);

  async function copyText(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error(`Couldn't copy ${label.toLowerCase()}`);
    }
  }

  function beginRename(): void {
    preventCloseAutoFocusRef.current = true;
    window.setTimeout(() => {
      onRename();
    }, 0);
  }

  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          if (preventCloseAutoFocusRef.current) {
            event.preventDefault();
            preventCloseAutoFocusRef.current = false;
          }
        }}
      >
        <ContextMenuItem onSelect={beginRename}>
          <PencilLine className="h-4 w-4" />
          Rename
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            void copyText(entry.path, "Relative path");
          }}
        >
          <Copy className="h-4 w-4" />
          Copy Relative Path
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            void copyText(absolutePath, "Absolute path");
          }}
        >
          <Copy className="h-4 w-4" />
          Copy Absolute Path
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RenameInput({
  initialName,
  entry,
  onCancel,
  onSubmit,
}: {
  initialName: string;
  entry: WorktreeFileEntry;
  onCancel: () => void;
  onSubmit: (entry: WorktreeFileEntry, nextName: string) => Promise<void>;
}) {
  const [draftName, setDraftName] = useState(initialName);
  const submittedRef = useRef(false);

  const submitOnce = useCallback(() => {
    if (submittedRef.current) {
      return;
    }
    submittedRef.current = true;
    void onSubmit(entry, draftName);
  }, [draftName, entry, onSubmit]);

  return (
    <Input
      autoFocus
      value={draftName}
      className="h-7 max-w-[260px]"
      onChange={(event) => setDraftName(event.currentTarget.value)}
      onBlur={submitOnce}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submitOnce();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

function DelayedNestedLoadingRow() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setVisible(true);
    }, NESTED_LOADING_PLACEHOLDER_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <div
      className="flex items-center gap-2 py-1.5"
      data-testid="nested-directory-loading-placeholder"
    >
      <Skeleton className="h-4 w-4 rounded-md" />
      <Skeleton className="h-4 w-28 rounded-md" />
    </div>
  );
}

function DelayedRefreshPulse({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      return;
    }

    const timer = window.setTimeout(() => {
      setVisible(true);
    }, REFRESH_PULSE_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [active]);

  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-2",
        visible && "animate-pulse opacity-70",
      )}
      data-testid={visible ? "directory-refresh-pulse" : undefined}
    >
      {children}
    </span>
  );
}

function RefreshErrorBanner({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      <span className="min-w-0 flex-1 truncate">{error}</span>
      <button
        type="button"
        className="shrink-0 font-medium text-foreground underline"
        onClick={onRetry}
      >
        Retry
      </button>
    </div>
  );
}

type ExplorerTreeProps = {
  nodes: readonly WorktreeFileEntry[];
  worktree: Worktree;
  fileChanges: Map<string, GitChangeType>;
  directoryChanges: Map<string, GitChangeType>;
  theme: HubrisTheme | null;
  expansion: TreeExpansionSource;
  onPreviewFile: (path: string) => void;
  onOpenFile: (path: string) => void;
  onRenamePathChange: (path: string | null) => void;
  onRenameSubmit: (entry: WorktreeFileEntry, nextName: string) => Promise<void>;
  onRetryDirectory: (path: string) => void;
};

function getExplorerEntryPath(entry: WorktreeFileEntry): string {
  return entry.path;
}

function isExplorerDirectory(entry: WorktreeFileEntry): boolean {
  return entry.kind === "directory";
}

function ExplorerTreeRow({
  node: entry,
  expanded,
  setExpanded,
  rowProps,
  worktree,
  fileChanges,
  directoryChanges,
  theme,
  onPreviewFile,
  onOpenFile,
  onRenamePathChange,
  onRenameSubmit,
}: TreeRowRenderProps<WorktreeFileEntry> &
  Omit<ExplorerTreeProps, "nodes" | "expansion" | "onRetryDirectory">) {
  const rowState = useWorktreeFileManagerStore((state) =>
    selectWorktreeFileRowSnapshot(state, worktree.id, entry.path),
  );
  const directoryState = rowState.directory as DirectoryState | undefined;
  const isRenaming = rowState.renaming;
  const isSelected = rowState.selected;
  const refreshing = isDirectoryRefreshLoading(directoryState);
  const changeType =
    entry.kind === "directory"
      ? directoryChanges.get(entry.path)
      : fileChanges.get(entry.path);

  const renameInput = isRenaming ? (
    <RenameInput
      key={entry.path}
      initialName={entry.name}
      entry={entry}
      onCancel={() => onRenamePathChange(null)}
      onSubmit={onRenameSubmit}
    />
  ) : null;

  if (entry.kind === "file") {
    return (
      <RowContextMenu
        entry={entry}
        worktree={worktree}
        onRename={() => onRenamePathChange(entry.path)}
      >
        <SidebarMenuButton
          {...rowProps}
          className={cn(
            "h-8 pr-0 text-sidebar-foreground/90 hover:bg-sidebar-accent/60",
            isSelected &&
              "bg-sidebar-accent/80 text-sidebar-accent-foreground hover:bg-sidebar-accent/80",
          )}
          isActive={isSelected}
          data-testid="file-tree-row"
          data-path={entry.path}
          onClick={() => onPreviewFile(entry.path)}
          onDoubleClick={() => onOpenFile(entry.path)}
        >
          <span className="h-4 w-4 shrink-0" aria-hidden="true" />
          <FileIcon
            path={entry.path}
            theme={theme}
            isSymlink={entry.is_symlink}
          />
          {renameInput ?? (
            <span
              className={cn(
                "truncate",
                rowLabelClass({
                  changeType,
                }),
              )}
            >
              {entry.name}
            </span>
          )}
          <span className="ml-auto">
            <ExplorerDecoration changeType={changeType} />
          </span>
        </SidebarMenuButton>
      </RowContextMenu>
    );
  }

  return (
    <RowContextMenu
      entry={entry}
      worktree={worktree}
      onRename={() => onRenamePathChange(entry.path)}
    >
      <SidebarMenuButton
        {...rowProps}
        className={cn(
          "h-8 pr-0 text-sidebar-foreground/90 hover:bg-sidebar-accent/60",
          isSelected &&
            "bg-sidebar-accent/80 text-sidebar-accent-foreground hover:bg-sidebar-accent/80",
        )}
        isActive={isSelected}
        data-testid="file-tree-row"
        data-path={entry.path}
        aria-label={`Toggle ${entry.path}`}
        onClick={() => {
          if (!isRenaming) {
            setExpanded(!expanded);
          }
        }}
      >
        <DelayedRefreshPulse
          key={refreshing ? "refreshing" : "idle"}
          active={refreshing}
        >
          <ChevronRight
            className={cn(
              "h-4 w-4 shrink-0 transition-transform duration-150",
              expanded && "rotate-90",
            )}
          />
          <FolderIcon
            name={entry.name}
            open={expanded}
            theme={theme}
            isSymlink={entry.is_symlink}
          />
          {renameInput ?? (
            <span
              className={cn(
                "truncate",
                rowLabelClass({
                  changeType,
                }),
              )}
            >
              {entry.name}
            </span>
          )}
        </DelayedRefreshPulse>
        <span className="ml-auto">
          <ExplorerDecoration changeType={changeType} directory />
        </span>
      </SidebarMenuButton>
    </RowContextMenu>
  );
}

function ExplorerTreeBranch({
  node: entry,
  worktree,
  ...treeProps
}: TreeBranchRenderProps<WorktreeFileEntry> &
  Omit<ExplorerTreeProps, "nodes">) {
  const rowState = useWorktreeFileManagerStore((state) =>
    selectWorktreeFileRowSnapshot(state, worktree.id, entry.path),
  );
  const directoryState = rowState.directory as DirectoryState | undefined;

  return (
    <div
      data-testid={`explorer-tree-branch-${entry.path.replaceAll("/", "-")}`}
    >
      {isDirectoryInitialLoading(directoryState) ? (
        <DelayedNestedLoadingRow />
      ) : isDirectoryInitialError(directoryState) ? (
        <div className="flex items-center gap-2 py-1 text-xs text-destructive">
          <span className="truncate">{directoryState?.error}</span>
          <button
            type="button"
            className="text-xs font-medium text-foreground underline"
            onClick={() => treeProps.onRetryDirectory(entry.path)}
          >
            Retry
          </button>
        </div>
      ) : directoryState && hasLoadedDirectoryState(directoryState) ? (
        <>
          {isDirectoryRefreshError(directoryState) ? (
            <div className="flex items-center gap-2 py-1 text-xs text-destructive">
              <span className="truncate">{directoryState.error}</span>
              <button
                type="button"
                className="text-xs font-medium text-foreground underline"
                onClick={() => treeProps.onRetryDirectory(entry.path)}
              >
                Retry
              </button>
            </div>
          ) : null}
          {directoryState.entries.length ? (
            <ExplorerTree
              {...treeProps}
              worktree={worktree}
              nodes={directoryState.entries}
            />
          ) : (
            <SidebarMenuButton
              className="h-8 pr-0 text-muted-foreground/80 hover:bg-transparent hover:text-muted-foreground/80"
              disabled
            >
              <span className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="text-[13px] font-medium">Empty folder</span>
            </SidebarMenuButton>
          )}
        </>
      ) : null}
    </div>
  );
}

function ExplorerTree({ nodes, ...props }: ExplorerTreeProps) {
  // The rest-object is fresh every render; depending on it would rebuild
  // renderRow/renderBranch each time and defeat TreeRow's memoization.
  // Depend on the individual values instead.
  const {
    worktree,
    fileChanges,
    directoryChanges,
    theme,
    expansion,
    onPreviewFile,
    onOpenFile,
    onRenamePathChange,
    onRenameSubmit,
    onRetryDirectory,
  } = props;
  const renderRow = useCallback(
    (rowProps: TreeRowRenderProps<WorktreeFileEntry>) => (
      <ExplorerTreeRow {...rowProps} {...props} />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fields of
    // `props`, enumerated so the identity is value-driven
    [
      worktree,
      fileChanges,
      directoryChanges,
      theme,
      expansion,
      onPreviewFile,
      onOpenFile,
      onRenamePathChange,
      onRenameSubmit,
      onRetryDirectory,
    ],
  );
  const renderBranch = useCallback(
    (branchProps: TreeBranchRenderProps<WorktreeFileEntry>) => (
      <ExplorerTreeBranch {...branchProps} {...props} />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- same as above
    [
      worktree,
      fileChanges,
      directoryChanges,
      theme,
      expansion,
      onPreviewFile,
      onOpenFile,
      onRenamePathChange,
      onRenameSubmit,
      onRetryDirectory,
    ],
  );

  return (
    <TreeView
      nodes={nodes}
      className="gap-0.5 py-0.5"
      getPath={getExplorerEntryPath}
      isBranch={isExplorerDirectory}
      expansion={props.expansion}
      renderRow={renderRow}
      renderBranch={renderBranch}
    />
  );
}

export default function WorktreeAllFilesPanel({ worktree }: Props) {
  const rootDirectory = useWorktreeFileManagerStore(
    (state) => state.worktrees[worktree.id]?.directories[""],
  ) as DirectoryState | undefined;
  const gitStatus = useWorktreeFileManagerStore(
    (state) => state.worktrees[worktree.id]?.gitStatus ?? null,
  );
  const loadDirectory = useWorktreeFileManagerStore(
    (state) => state.loadDirectory,
  );
  const preloadVisibleDirectories = useWorktreeFileManagerStore(
    (state) => state.preloadVisibleDirectories,
  );
  const renameEntry = useWorktreeFileManagerStore((state) => state.renameEntry);
  const setExpanded = useWorktreeFileManagerStore((state) => state.setExpanded);
  const setSelectedPath = useWorktreeFileManagerStore(
    (state) => state.setSelectedPath,
  );
  const setRenamePath = useWorktreeFileManagerStore(
    (state) => state.setRenamePath,
  );
  const openFile = useTabStore((state) => state.openFile);
  const activeTheme = useThemeSettings((state) => state.activeTheme);

  const { fileChanges, directoryChanges } = useMemo(
    () => buildDecorations({ gitStatus }),
    [gitStatus],
  );

  const expansion = useMemo<TreeExpansionSource>(
    () => ({
      getSnapshot(path) {
        return selectWorktreeFileRowSnapshot(
          useWorktreeFileManagerStore.getState(),
          worktree.id,
          path,
        ).expanded;
      },
      subscribe(path, listener) {
        let previous = selectWorktreeFileRowSnapshot(
          useWorktreeFileManagerStore.getState(),
          worktree.id,
          path,
        ).expanded;
        return useWorktreeFileManagerStore.subscribe((state) => {
          const next = selectWorktreeFileRowSnapshot(
            state,
            worktree.id,
            path,
          ).expanded;
          if (next !== previous) {
            previous = next;
            listener();
          }
        });
      },
      setExpanded(path, nextExpanded) {
        setExpanded(worktree.id, path, nextExpanded);
        setSelectedPath(worktree.id, path);
        if (nextExpanded) {
          void (async () => {
            await loadDirectory(worktree.project_id, worktree.id, path);
            await preloadVisibleDirectories(worktree.project_id, worktree.id);
          })();
        }
      },
    }),
    [
      loadDirectory,
      preloadVisibleDirectories,
      setExpanded,
      setSelectedPath,
      worktree.id,
      worktree.project_id,
    ],
  );

  const handleRenameSubmit = useCallback(
    async (entry: WorktreeFileEntry, nextName: string) => {
      const trimmed = nextName.trim();
      if (!trimmed || trimmed === entry.name) {
        setRenamePath(worktree.id, null);
        return;
      }

      try {
        await renameEntry(
          worktree.project_id,
          worktree.id,
          entry.path,
          trimmed,
        );
        toast.success("Renamed");
      } catch (error) {
        toast.error((error as Error).message);
      }
    },
    [renameEntry, setRenamePath, worktree.id, worktree.project_id],
  );

  const handleOpenFile = useCallback(
    (path: string, preview: boolean) => {
      setSelectedPath(worktree.id, path);
      void openFile({
        worktreeId: worktree.id,
        path,
        preview,
      });
    },
    [openFile, setSelectedPath, worktree.id],
  );
  const handlePreviewFile = useCallback(
    (path: string) => handleOpenFile(path, true),
    [handleOpenFile],
  );
  const handleOpenFilePermanent = useCallback(
    (path: string) => handleOpenFile(path, false),
    [handleOpenFile],
  );
  const handleRenamePathChange = useCallback(
    (path: string | null) => setRenamePath(worktree.id, path),
    [setRenamePath, worktree.id],
  );
  const handleRetryDirectory = useCallback(
    (path: string) => {
      void loadDirectory(worktree.project_id, worktree.id, path, {
        force: true,
      });
    },
    [loadDirectory, worktree.id, worktree.project_id],
  );

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex min-h-full flex-col gap-3 p-3">
        {rootDirectory?.status === "loading-initial" &&
        rootDirectory.entries.length === 0 ? (
          <div
            className="flex flex-col gap-2"
            data-testid="root-directory-loading-list"
          >
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="flex items-center gap-2 px-2 py-1.5">
                <Skeleton className="h-4 w-4 rounded-md" />
                <Skeleton className="h-4 w-40 rounded-md" />
              </div>
            ))}
          </div>
        ) : rootDirectory?.status === "error-initial" ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <p>{rootDirectory.error}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => {
                void loadDirectory(worktree.project_id, worktree.id, "", {
                  force: true,
                });
              }}
            >
              Retry
            </Button>
          </div>
        ) : rootDirectory?.entries.length ? (
          <>
            {isDirectoryRefreshError(rootDirectory) ? (
              <RefreshErrorBanner
                error={rootDirectory.error}
                onRetry={() => {
                  void loadDirectory(worktree.project_id, worktree.id, "", {
                    force: true,
                  });
                }}
              />
            ) : null}
            <ExplorerTree
              nodes={rootDirectory.entries}
              worktree={worktree}
              fileChanges={fileChanges}
              directoryChanges={directoryChanges}
              theme={activeTheme}
              expansion={expansion}
              onPreviewFile={handlePreviewFile}
              onOpenFile={handleOpenFilePermanent}
              onRenamePathChange={handleRenamePathChange}
              onRenameSubmit={handleRenameSubmit}
              onRetryDirectory={handleRetryDirectory}
            />
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-border/70 bg-muted/25 px-3 py-5 text-sm text-muted-foreground">
            No files found.
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
