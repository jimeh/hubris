import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronRight, Copy, PencilLine, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { WorktreeGitStatus } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  resolveMaterialFileIcon,
  resolveMaterialFolderIcon,
} from "@/lib/materialIconTheme";
import {
  gitChangeTypeClass,
  gitChangeTypeLabel,
  type GitChangeType,
} from "@/lib/gitChangePresentation";
import { useWorktreeFileManagerStore } from "@/lib/stores/worktreeFileManager";
import { useThemeSettings } from "@/lib/stores/theme";
import type { HubrisTheme } from "@/lib/theme/types";
import type { Worktree, WorktreeFileEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  worktree: Worktree;
  open?: boolean;
  onActionsChange?: (actions: ReactNode | null) => void;
};

type DirectoryState = {
  status: "idle" | "loading" | "loaded" | "error";
  entries: WorktreeFileEntry[];
  error: string | null;
};

type DecorationState = {
  gitStatus: WorktreeGitStatus | null;
};

const NESTED_LOADING_PLACEHOLDER_DELAY_MS = 175;

const EMPTY_STATE = {
  directories: {} as Record<string, DirectoryState>,
  expandedPaths: [] as string[],
  selectedPath: null,
  renamePath: null,
  gitStatus: null as WorktreeGitStatus | null,
  gitStatusStatus: "idle",
  gitError: null,
  pendingGeneration: 0,
  pendingGitGeneration: 0,
};

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
      if (!directoryChanges.has(current)) {
        directoryChanges.set(current, changeType);
      }
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
}: {
  name: string;
  open: boolean;
  theme: HubrisTheme | null;
}) {
  const icon = resolveMaterialFolderIcon(name, theme, open);

  return (
    <img
      src={icon.iconPath}
      alt=""
      className="hubris-explorer-icon h-5 w-5 shrink-0 object-contain"
      data-testid={open ? "folder-icon-open" : "folder-icon-closed"}
      data-icon-id={icon.iconId}
      aria-hidden="true"
      draggable={false}
    />
  );
}

function FileIcon({
  path,
  theme,
}: {
  path: string;
  theme: HubrisTheme | null;
}) {
  const icon = resolveMaterialFileIcon(path, theme);

  return (
    <img
      src={icon.iconPath}
      alt=""
      className="hubris-explorer-icon h-5 w-5 shrink-0 object-contain"
      data-testid="file-icon-manifest"
      data-icon-id={icon.iconId}
      aria-hidden="true"
      draggable={false}
    />
  );
}

function ExplorerDecoration({
  changeType,
  directory = false,
}: {
  changeType?: GitChangeType;
  directory?: boolean;
}) {
  if (!changeType) {
    return <span className="h-5 w-5 shrink-0" aria-hidden="true" />;
  }

  if (directory) {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        <span
          className={cn("h-2 w-2 rounded-full", gitChangeTypeClass(changeType))}
        />
      </span>
    );
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

  return (
    <Input
      autoFocus
      value={draftName}
      className="h-7 max-w-[260px]"
      onChange={(event) => setDraftName(event.currentTarget.value)}
      onBlur={() => {
        void onSubmit(entry, draftName);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void onSubmit(entry, draftName);
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

function FileTreeRow({
  worktree,
  entry,
  depth,
  expandedPaths,
  directories,
  selectedPath,
  renamePath,
  fileChanges,
  directoryChanges,
  theme,
  onToggleDirectory,
  onSelect,
  onRenamePathChange,
  onRenameSubmit,
  onRetryDirectory,
}: {
  worktree: Worktree;
  entry: WorktreeFileEntry;
  depth: number;
  expandedPaths: string[];
  directories: Record<string, DirectoryState>;
  selectedPath: string | null;
  renamePath: string | null;
  fileChanges: Map<string, GitChangeType>;
  directoryChanges: Map<string, GitChangeType>;
  theme: HubrisTheme | null;
  onToggleDirectory: (entry: WorktreeFileEntry) => void;
  onSelect: (path: string) => void;
  onRenamePathChange: (path: string | null) => void;
  onRenameSubmit: (entry: WorktreeFileEntry, nextName: string) => Promise<void>;
  onRetryDirectory: (path: string) => void;
}) {
  const expanded = expandedPaths.includes(entry.path);
  const directoryState = directories[entry.path];
  const isRenaming = renamePath === entry.path;
  const isSelected = selectedPath === entry.path;
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
      <SidebarMenuItem>
        <RowContextMenu
          entry={entry}
          worktree={worktree}
          onRename={() => onRenamePathChange(entry.path)}
        >
          <SidebarMenuButton
            className={cn(
              "h-8 pr-0 text-sidebar-foreground/90 hover:bg-sidebar-accent/60",
              isSelected &&
                "bg-sidebar-accent/80 text-sidebar-accent-foreground hover:bg-sidebar-accent/80",
            )}
            isActive={isSelected}
            data-testid="file-tree-row"
            data-path={entry.path}
            onClick={() => onSelect(entry.path)}
          >
            <span className="h-4 w-4 shrink-0" aria-hidden="true" />
            <FileIcon path={entry.path} theme={theme} />
            {renameInput ?? (
              <span className="truncate text-[13px] font-medium">
                {entry.name}
              </span>
            )}
            <span className="ml-auto">
              <ExplorerDecoration changeType={changeType} />
            </span>
          </SidebarMenuButton>
        </RowContextMenu>
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem>
      <RowContextMenu
        entry={entry}
        worktree={worktree}
        onRename={() => onRenamePathChange(entry.path)}
      >
        <Collapsible
          open={expanded}
          onOpenChange={() => {
            if (isRenaming) {
              return;
            }
            onToggleDirectory(entry);
          }}
          className="group/collapsible"
        >
          <CollapsibleTrigger asChild>
            <SidebarMenuButton
              className={cn(
                "h-8 pr-0 text-sidebar-foreground/90 hover:bg-sidebar-accent/60",
                isSelected &&
                  "bg-sidebar-accent/80 text-sidebar-accent-foreground hover:bg-sidebar-accent/80",
              )}
              isActive={isSelected}
              data-testid="file-tree-row"
              data-path={entry.path}
              aria-label={`Toggle ${entry.path}`}
            >
              <ChevronRight
                className={cn(
                  "transition-transform duration-150",
                  expanded && "rotate-90",
                )}
              />
              <FolderIcon name={entry.name} open={expanded} theme={theme} />
              {renameInput ?? (
                <span className="truncate text-[13px] font-medium">
                  {entry.name}
                </span>
              )}
              <span className="ml-auto">
                <ExplorerDecoration changeType={changeType} directory />
              </span>
            </SidebarMenuButton>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div
              className="ml-[15px] border-l border-sidebar-border/70 pl-[9px]"
              data-testid={`explorer-tree-branch-${entry.path.replaceAll("/", "-")}`}
            >
              {directoryState?.status === "loading" ? (
                <DelayedNestedLoadingRow />
              ) : directoryState?.status === "error" ? (
                <div className="flex items-center gap-2 py-1 text-xs text-destructive">
                  <span className="truncate">{directoryState.error}</span>
                  <button
                    type="button"
                    className="text-xs font-medium text-foreground underline"
                    onClick={() => onRetryDirectory(entry.path)}
                  >
                    Retry
                  </button>
                </div>
              ) : directoryState?.entries.length ? (
                <SidebarMenu className="gap-0.5 py-0.5">
                  {directoryState.entries.map((child) => (
                    <FileTreeRow
                      key={child.path}
                      worktree={worktree}
                      entry={child}
                      depth={depth + 1}
                      expandedPaths={expandedPaths}
                      directories={directories}
                      selectedPath={selectedPath}
                      renamePath={renamePath}
                      fileChanges={fileChanges}
                      directoryChanges={directoryChanges}
                      theme={theme}
                      onToggleDirectory={onToggleDirectory}
                      onSelect={onSelect}
                      onRenamePathChange={onRenamePathChange}
                      onRenameSubmit={onRenameSubmit}
                      onRetryDirectory={onRetryDirectory}
                    />
                  ))}
                </SidebarMenu>
              ) : (
                <SidebarMenu className="gap-0.5 py-0.5">
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      className="h-8 pr-0 text-muted-foreground/80 hover:bg-transparent hover:text-muted-foreground/80"
                      disabled
                    >
                      <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="text-[13px] font-medium">
                        Empty folder
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </RowContextMenu>
    </SidebarMenuItem>
  );
}

export default function WorktreeAllFilesPanel({
  worktree,
  open = true,
  onActionsChange,
}: Props) {
  const worktreeState =
    useWorktreeFileManagerStore((state) => state.worktrees[worktree.id]) ??
    EMPTY_STATE;
  const loadDirectory = useWorktreeFileManagerStore(
    (state) => state.loadDirectory,
  );
  const loadGitStatus = useWorktreeFileManagerStore(
    (state) => state.loadGitStatus,
  );
  const refreshVisiblePaths = useWorktreeFileManagerStore(
    (state) => state.refreshVisiblePaths,
  );
  const refreshPendingPaths = useWorktreeFileManagerStore(
    (state) => state.refreshPendingPaths,
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
  const activeTheme = useThemeSettings((state) => state.activeTheme);

  const rootDirectory = worktreeState.directories[""];
  const { fileChanges, directoryChanges } = useMemo(
    () => buildDecorations(worktreeState),
    [worktreeState],
  );

  const refreshPanel = useCallback(
    async (force = false) => {
      await refreshVisiblePaths(worktree.project_id, worktree.id, { force });
    },
    [refreshVisiblePaths, worktree.id, worktree.project_id],
  );

  const headerActions = useMemo(
    () => (
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() =>
          void refreshVisiblePaths(worktree.project_id, worktree.id, {
            force: true,
          })
        }
        title="Refresh files"
        aria-label="Refresh files"
      >
        <RefreshCw
          className={cn(
            "h-4 w-4",
            (rootDirectory?.status === "loading" ||
              worktreeState.gitStatusStatus === "loading") &&
              "animate-spin",
          )}
        />
      </Button>
    ),
    [
      refreshVisiblePaths,
      rootDirectory?.status,
      worktree.id,
      worktree.project_id,
      worktreeState.gitStatusStatus,
    ],
  );

  useEffect(() => {
    if (!open) {
      onActionsChange?.(null);
      return;
    }

    onActionsChange?.(headerActions);
    return () => onActionsChange?.(null);
  }, [headerActions, onActionsChange, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void refreshPanel(false);
  }, [open, refreshPanel]);

  useEffect(() => {
    if (!open || worktreeState.pendingGeneration === 0) {
      return;
    }

    startTransition(() => {
      void refreshPendingPaths(worktree.project_id, worktree.id);
    });
  }, [
    open,
    refreshPendingPaths,
    worktree.id,
    worktree.project_id,
    worktreeState.pendingGeneration,
  ]);

  useEffect(() => {
    if (
      !open ||
      worktreeState.pendingGeneration !== 0 ||
      worktreeState.pendingGitGeneration === 0
    ) {
      return;
    }

    startTransition(() => {
      void loadGitStatus(worktree.project_id, worktree.id, { force: true });
    });
  }, [
    loadGitStatus,
    open,
    worktree.id,
    worktree.project_id,
    worktreeState.pendingGeneration,
    worktreeState.pendingGitGeneration,
  ]);

  const handleToggleDirectory = useCallback(
    (entry: WorktreeFileEntry) => {
      const expanded = worktreeState.expandedPaths.includes(entry.path);
      const nextExpanded = !expanded;
      setExpanded(worktree.id, entry.path, nextExpanded);
      setSelectedPath(worktree.id, entry.path);
      if (nextExpanded) {
        void (async () => {
          await loadDirectory(worktree.project_id, worktree.id, entry.path);
          await preloadVisibleDirectories(worktree.project_id, worktree.id);
        })();
      }
    },
    [
      loadDirectory,
      preloadVisibleDirectories,
      setExpanded,
      setSelectedPath,
      worktree.id,
      worktree.project_id,
      worktreeState.expandedPaths,
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

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex min-h-full flex-col gap-3 p-3">
        <div className="rounded-2xl border border-border/70 bg-gradient-to-br from-background via-background to-muted/40 p-3 shadow-[0_10px_30px_rgba(0,0,0,0.06)]">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                Explorer
              </p>
              <p className="truncate text-sm font-medium">{worktree.path}</p>
            </div>
            {worktreeState.gitStatus ? (
              <div className="rounded-full border border-border/70 bg-background/80 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                {worktreeState.gitStatus.unstaged_files.length +
                  worktreeState.gitStatus.staged_files.length}{" "}
                changed
              </div>
            ) : null}
          </div>
        </div>

        {rootDirectory?.status === "loading" &&
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
        ) : rootDirectory?.status === "error" ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <p>{rootDirectory.error}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => {
                void refreshPanel(true);
              }}
            >
              Retry
            </Button>
          </div>
        ) : rootDirectory?.entries.length ? (
          <SidebarMenu className="gap-0.5">
            {rootDirectory.entries.map((entry) => (
              <FileTreeRow
                key={entry.path}
                worktree={worktree}
                entry={entry}
                depth={0}
                expandedPaths={worktreeState.expandedPaths}
                directories={
                  worktreeState.directories as Record<string, DirectoryState>
                }
                selectedPath={worktreeState.selectedPath}
                renamePath={worktreeState.renamePath}
                fileChanges={fileChanges}
                directoryChanges={directoryChanges}
                theme={activeTheme}
                onToggleDirectory={handleToggleDirectory}
                onSelect={(path) => setSelectedPath(worktree.id, path)}
                onRenamePathChange={(path) => setRenamePath(worktree.id, path)}
                onRenameSubmit={handleRenameSubmit}
                onRetryDirectory={(path) => {
                  void loadDirectory(worktree.project_id, worktree.id, path, {
                    force: true,
                  });
                }}
              />
            ))}
          </SidebarMenu>
        ) : (
          <div className="rounded-xl border border-dashed border-border/70 bg-muted/25 px-3 py-5 text-sm text-muted-foreground">
            No files found.
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
