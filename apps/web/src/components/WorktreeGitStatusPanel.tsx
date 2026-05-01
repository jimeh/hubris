import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { ChevronRight, Minus, Plus, Undo } from "lucide-react";
import { toast } from "sonner";
import {
  discardProjectWorktreePath,
  getProjectWorktreeCommitDetails,
  stageProjectWorktreePath,
  unstageProjectWorktreePath,
  type WorktreeGitCommitDetails,
  type WorktreeGitCommitSummary,
  type WorktreeGitFileChange,
} from "@/lib/api";
import { DiffLineStats } from "@/components/DiffLineStats";
import { computeAggregateStats } from "@/lib/diffLineStats";
import {
  gitChangeTypeClass,
  gitChangeTypeLabel,
  mostSignificantGitChangeType,
  type GitChangeType,
} from "@/lib/gitChangePresentation";
import {
  resolveMaterialFileIcon,
  resolveMaterialFolderIcon,
} from "@/lib/materialIconTheme";
import {
  buildWorktreeGitStatusTree,
  type WorktreeGitStatusTreeNode,
} from "@/lib/worktreeGitStatusTree";
import { useWorktreeFileManagerStore } from "@/lib/stores/worktreeFileManager";
import {
  DEFAULT_WORKTREE_GIT_STATUS_VIEW_MODE,
  useWorktreeGitStatusViewStore,
  type WorktreeGitStatusViewMode,
} from "@/lib/stores/worktreeGitStatusView";
import { useTabStore } from "@/lib/stores/tabs";
import { useThemeSettings } from "@/lib/stores/theme";
import type { HubrisTheme } from "@/lib/theme/types";
import type { Worktree } from "@/lib/types";
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
import { Badge } from "@/components/ui/badge";
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
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { SidebarMenu, SidebarMenuItem } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type Props = {
  worktree: Worktree;
};

type TreeOpenState = Record<string, boolean>;
type ChangeSection = "unstaged" | "staged";
type DiffScope = ChangeSection | "commit";

function gitChangeKey(
  section: ChangeSection,
  change: WorktreeGitFileChange,
  index: number,
): string {
  return [
    section,
    change.path,
    change.original_path ?? "",
    change.change_type,
    index,
  ].join(":");
}

function treeNodeKey(
  scope: DiffScope,
  path: string,
  kind: WorktreeGitStatusTreeNode["kind"],
  index: number,
): string {
  return [scope, kind, path, index].join(":");
}
type SectionKey = ChangeSection | "commits";
type SectionOpenState = Record<SectionKey, boolean>;
type SectionOpenStateByWorktree = Record<string, SectionOpenState>;
type TreeOpenStateByWorktree = Record<string, TreeOpenState>;
type CommitTreeOpenStateByWorktree = Record<
  string,
  Record<string, TreeOpenState>
>;
type CommitDetailsByWorktree = Record<
  string,
  Record<string, CommitDetailsState>
>;
type GitAction = "stage" | "unstage" | "discard";
type CommitDetailsState = {
  status: "idle" | "loading" | "loaded" | "error";
  details: WorktreeGitCommitDetails | null;
  error: string | null;
};

type PendingDiscard = {
  path: string;
  label: string;
  recursive: boolean;
};

const LOADING_SKELETON_DELAY_MS = 150;
const ACTION_ICONS = {
  stage: Plus,
  unstage: Minus,
  discard: Undo,
} satisfies Record<GitAction, typeof Plus>;
const EMPTY_COMMIT_DETAILS_STATE: CommitDetailsState = {
  status: "idle",
  details: null,
  error: null,
};
const DEFAULT_SECTION_OPEN_STATE: SectionOpenState = {
  commits: true,
  staged: true,
  unstaged: true,
};

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

function actionLabel(action: GitAction): string {
  switch (action) {
    case "stage":
      return "Stage";
    case "unstage":
      return "Unstage";
    case "discard":
      return "Discard";
  }
}

function actionToneClass(action: GitAction): string {
  switch (action) {
    case "stage":
      return "text-emerald-500 hover:text-emerald-400";
    case "unstage":
      return "text-amber-500 hover:text-amber-400";
    case "discard":
      return "text-rose-500 hover:text-rose-400";
  }
}

function actionSuccessLabel(action: GitAction): string {
  switch (action) {
    case "stage":
      return "Staged";
    case "unstage":
      return "Unstaged";
    case "discard":
      return "Discarded";
  }
}

function actionsForSection(section: ChangeSection): GitAction[] {
  return section === "unstaged" ? ["discard", "stage"] : ["unstage"];
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
  const basename = name.split("/").filter(Boolean).at(-1) ?? name;
  const icon = resolveMaterialFolderIcon(basename, theme, open);

  return (
    <img
      src={icon.iconPath}
      alt=""
      className="hubris-explorer-icon h-5 w-5 shrink-0 object-contain"
      data-testid={
        open ? "changes-folder-icon-open" : "changes-folder-icon-closed"
      }
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
      data-testid="changes-file-icon"
      data-icon-id={icon.iconId}
      aria-hidden="true"
      draggable={false}
    />
  );
}

function ChangeStatusBadge({ changeType }: { changeType: GitChangeType }) {
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

function DirectoryStatusDot({ changeType }: { changeType: GitChangeType }) {
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
      <span
        className={cn(
          "h-2 w-2 rounded-full bg-current opacity-65",
          gitChangeTypeClass(changeType),
        )}
        data-testid="changes-directory-status-dot"
      />
    </span>
  );
}

function CompactedDirectoryLabel({ name }: { name: string }) {
  const segments = name.split("/").filter(Boolean);

  return (
    <span className="truncate">
      {segments.map((segment, index) => (
        <Fragment key={`${name}:${index}:${segment}`}>
          {index > 0 ? (
            <span
              className="text-sidebar-foreground/35"
              data-testid="changes-directory-separator"
            >
              {" / "}
            </span>
          ) : null}
          <span>{segment}</span>
        </Fragment>
      ))}
    </span>
  );
}

function aggregateDirectoryChangeType(
  node: Extract<WorktreeGitStatusTreeNode, { kind: "directory" }>,
): GitChangeType | null {
  return mostSignificantGitChangeType(walkDirectoryChangeTypes(node));
}

function* walkDirectoryChangeTypes(
  node: Extract<WorktreeGitStatusTreeNode, { kind: "directory" }>,
): Generator<GitChangeType> {
  for (const child of node.children) {
    if (child.kind === "file") {
      yield child.change.change_type;
      continue;
    }

    yield* walkDirectoryChangeTypes(child);
  }
}

function RowActionButton({
  action,
  targetLabel,
  disabled,
  onAction,
}: {
  action: GitAction;
  targetLabel: string;
  disabled?: boolean;
  onAction: (action: GitAction) => void;
}) {
  const Icon = ACTION_ICONS[action];

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={cn("rounded-md", actionToneClass(action))}
      aria-label={`${actionLabel(action)} ${targetLabel}`}
      title={`${actionLabel(action)} ${targetLabel}`}
      disabled={disabled}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onAction(action);
      }}
    >
      <Icon />
    </Button>
  );
}

const ChangeRowFrame = forwardRef<
  HTMLDivElement,
  ComponentProps<"div"> & {
    primary: ReactNode;
    actions?: ReactNode;
    badge?: ReactNode;
    interactive?: boolean;
    onActivate?: () => void;
  }
>(function ChangeRowFrame(
  {
    primary,
    actions,
    badge,
    className,
    interactive = false,
    onActivate,
    onKeyDown,
    role,
    tabIndex,
    ...props
  },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "group/change-row flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-[13px] text-sidebar-foreground/90",
        "hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
        "focus-within:bg-sidebar-accent/60 focus-within:text-sidebar-accent-foreground",
        className,
      )}
      role={interactive ? "button" : role}
      tabIndex={interactive ? 0 : tabIndex}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || !interactive || !onActivate) {
          return;
        }
        if (event.key === "Enter") {
          onActivate();
        } else if (event.key === " ") {
          event.preventDefault();
          onActivate();
        }
      }}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">{primary}</div>
      {actions ? (
        <div
          className={cn(
            "ml-auto flex max-w-0 items-center gap-1 overflow-hidden transition-opacity duration-150",
            "pointer-events-none opacity-0",
            "group-hover/change-row:max-w-16 group-hover/change-row:opacity-100",
            "group-hover/change-row:pointer-events-auto",
            "group-focus-within/change-row:max-w-16 group-focus-within/change-row:opacity-100",
            "group-focus-within/change-row:pointer-events-auto",
          )}
        >
          {actions}
        </div>
      ) : null}
      {badge ? <div className="flex items-center">{badge}</div> : null}
    </div>
  );
});

function ChangeContextMenu({
  children,
  targetLabel,
  actions,
  disabled,
  onAction,
}: {
  children: ReactNode;
  targetLabel: string;
  actions: GitAction[];
  disabled?: boolean;
  onAction: (action: GitAction) => void;
}) {
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {actions.map((action) => {
          const Icon = ACTION_ICONS[action];
          return (
            <ContextMenuItem
              key={action}
              disabled={disabled}
              onSelect={() => onAction(action)}
            >
              <Icon className={cn("h-4 w-4", actionToneClass(action))} />
              {actionLabel(action)} {targetLabel}
            </ContextMenuItem>
          );
        })}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function FilePathRow({
  change,
  section,
  theme,
  disabled,
  onOpenDiff,
  onAction,
}: {
  change: WorktreeGitFileChange;
  section: ChangeSection;
  theme: HubrisTheme | null;
  disabled?: boolean;
  onOpenDiff: (
    path: string,
    scope: DiffScope,
    originalPath: string | undefined,
    commitId: string | undefined,
    preview: boolean,
  ) => void;
  onAction: (
    action: GitAction,
    path: string,
    originalPath: string | undefined,
    label: string,
    recursive: boolean,
  ) => void;
}) {
  const { basename, directoryPath } = splitChangePath(change.path);
  const actions = actionsForSection(section);
  const targetLabel = basename;

  return (
    <SidebarMenuItem>
      <ChangeContextMenu
        targetLabel={targetLabel}
        actions={actions}
        disabled={disabled}
        onAction={(action) =>
          onAction(
            action,
            change.path,
            change.original_path ?? undefined,
            targetLabel,
            false,
          )
        }
      >
        <ChangeRowFrame
          className="cursor-pointer"
          interactive
          onActivate={() =>
            onOpenDiff(
              change.path,
              section,
              change.original_path ?? undefined,
              undefined,
              true,
            )
          }
          primary={
            <>
              <FileIcon path={change.path} theme={theme} />
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
              <DiffLineStats
                insertions={change.insertions}
                deletions={change.deletions}
              />
            </>
          }
          actions={actions.map((action) => (
            <RowActionButton
              key={action}
              action={action}
              targetLabel={targetLabel}
              disabled={disabled}
              onAction={(nextAction) =>
                onAction(
                  nextAction,
                  change.path,
                  change.original_path ?? undefined,
                  targetLabel,
                  false,
                )
              }
            />
          ))}
          badge={<ChangeStatusBadge changeType={change.change_type} />}
          onClick={() =>
            onOpenDiff(
              change.path,
              section,
              change.original_path ?? undefined,
              undefined,
              true,
            )
          }
          onDoubleClick={() =>
            onOpenDiff(
              change.path,
              section,
              change.original_path ?? undefined,
              undefined,
              false,
            )
          }
        />
      </ChangeContextMenu>
    </SidebarMenuItem>
  );
}

function TreeFileNode({
  node,
  section,
  theme,
  disabled,
  onOpenDiff,
  onAction,
}: {
  node: Extract<WorktreeGitStatusTreeNode, { kind: "file" }>;
  section: ChangeSection;
  theme: HubrisTheme | null;
  disabled?: boolean;
  onOpenDiff: (
    path: string,
    scope: DiffScope,
    originalPath: string | undefined,
    commitId: string | undefined,
    preview: boolean,
  ) => void;
  onAction: (
    action: GitAction,
    path: string,
    originalPath: string | undefined,
    label: string,
    recursive: boolean,
  ) => void;
}) {
  const actions = actionsForSection(section);
  const targetLabel = node.name;

  return (
    <SidebarMenuItem>
      <ChangeContextMenu
        targetLabel={targetLabel}
        actions={actions}
        disabled={disabled}
        onAction={(action) =>
          onAction(
            action,
            node.path,
            node.change.original_path ?? undefined,
            targetLabel,
            false,
          )
        }
      >
        <ChangeRowFrame
          className="cursor-pointer"
          interactive
          onActivate={() =>
            onOpenDiff(
              node.path,
              section,
              node.change.original_path ?? undefined,
              undefined,
              true,
            )
          }
          primary={
            <>
              <span aria-hidden="true" className="h-4 w-4 shrink-0" />
              <FileIcon path={node.path} theme={theme} />
              <span className="truncate text-[13px] font-medium">
                {node.name}
              </span>
              <DiffLineStats
                insertions={node.change.insertions}
                deletions={node.change.deletions}
              />
            </>
          }
          actions={actions.map((action) => (
            <RowActionButton
              key={action}
              action={action}
              targetLabel={targetLabel}
              disabled={disabled}
              onAction={(nextAction) =>
                onAction(
                  nextAction,
                  node.path,
                  node.change.original_path ?? undefined,
                  targetLabel,
                  false,
                )
              }
            />
          ))}
          badge={<ChangeStatusBadge changeType={node.change.change_type} />}
          onClick={() =>
            onOpenDiff(
              node.path,
              section,
              node.change.original_path ?? undefined,
              undefined,
              true,
            )
          }
          onDoubleClick={() =>
            onOpenDiff(
              node.path,
              section,
              node.change.original_path ?? undefined,
              undefined,
              false,
            )
          }
        />
      </ChangeContextMenu>
    </SidebarMenuItem>
  );
}

function TreeDirectoryNode({
  node,
  depth,
  section,
  theme,
  openState,
  disabled,
  onOpenChange,
  onOpenDiff,
  onAction,
}: {
  node: Extract<WorktreeGitStatusTreeNode, { kind: "directory" }>;
  depth: number;
  section: ChangeSection;
  theme: HubrisTheme | null;
  openState: TreeOpenState;
  disabled?: boolean;
  onOpenChange: (path: string, open: boolean) => void;
  onOpenDiff: (
    path: string,
    scope: DiffScope,
    originalPath: string | undefined,
    commitId: string | undefined,
    preview: boolean,
  ) => void;
  onAction: (
    action: GitAction,
    path: string,
    originalPath: string | undefined,
    label: string,
    recursive: boolean,
  ) => void;
}) {
  const open = openState[node.path] ?? depth === 0;
  const actions = actionsForSection(section);
  const targetLabel = node.name;
  const changeType = useMemo(() => aggregateDirectoryChangeType(node), [node]);

  return (
    <SidebarMenuItem>
      <Collapsible
        open={open}
        onOpenChange={(nextOpen) => onOpenChange(node.path, nextOpen)}
        className="group/collapsible"
      >
        <ChangeContextMenu
          targetLabel={targetLabel}
          actions={actions}
          disabled={disabled}
          onAction={(action) =>
            onAction(action, node.path, undefined, targetLabel, true)
          }
        >
          <ChangeRowFrame
            primary={
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px] font-medium outline-hidden"
                  aria-label={`Toggle ${node.path}`}
                >
                  <ChevronRight
                    className={cn(
                      "size-4 shrink-0 transition-transform duration-150",
                      open && "rotate-90",
                    )}
                  />
                  <FolderIcon name={node.name} open={open} theme={theme} />
                  <CompactedDirectoryLabel name={node.name} />
                </button>
              </CollapsibleTrigger>
            }
            actions={actions.map((action) => (
              <RowActionButton
                key={action}
                action={action}
                targetLabel={targetLabel}
                disabled={disabled}
                onAction={(nextAction) =>
                  onAction(nextAction, node.path, undefined, targetLabel, true)
                }
              />
            ))}
            badge={
              changeType ? <DirectoryStatusDot changeType={changeType} /> : null
            }
          />
        </ChangeContextMenu>
        <CollapsibleContent>
          <div className="ml-[15px] border-l border-sidebar-border/70 pl-[9px]">
            <SidebarMenu className="gap-0.5 py-0.5">
              {node.children.map((child, index) =>
                child.kind === "directory" ? (
                  <TreeDirectoryNode
                    key={treeNodeKey(section, child.path, child.kind, index)}
                    node={child}
                    depth={depth + 1}
                    section={section}
                    theme={theme}
                    openState={openState}
                    disabled={disabled}
                    onOpenChange={onOpenChange}
                    onOpenDiff={onOpenDiff}
                    onAction={onAction}
                  />
                ) : (
                  <TreeFileNode
                    key={treeNodeKey(section, child.path, child.kind, index)}
                    node={child}
                    section={section}
                    theme={theme}
                    disabled={disabled}
                    onOpenDiff={onOpenDiff}
                    onAction={onAction}
                  />
                ),
              )}
            </SidebarMenu>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  );
}

function StatusFileSection({
  title,
  section,
  open,
  changes,
  viewMode,
  theme,
  disabled,
  onOpenChange,
  onOpenDiff,
  onAction,
}: {
  title: string;
  section: ChangeSection;
  open: boolean;
  changes: WorktreeGitFileChange[];
  viewMode: WorktreeGitStatusViewMode;
  theme: HubrisTheme | null;
  disabled?: boolean;
  onOpenChange: (section: ChangeSection, open: boolean) => void;
  onOpenDiff: (
    path: string,
    scope: DiffScope,
    originalPath: string | undefined,
    commitId: string | undefined,
    preview: boolean,
  ) => void;
  onAction: (
    action: GitAction,
    path: string,
    originalPath: string | undefined,
    label: string,
    recursive: boolean,
  ) => void;
}) {
  const tree = useMemo(() => buildWorktreeGitStatusTree(changes), [changes]);
  const aggregateStats = useMemo(
    () => computeAggregateStats(changes),
    [changes],
  );
  const [treeOpenState, setTreeOpenState] = useState<TreeOpenState>({});

  const handleNodeOpenChange = useCallback((path: string, open: boolean) => {
    setTreeOpenState((current) => ({
      ...current,
      [path]: open,
    }));
  }, []);

  return (
    <Collapsible
      open={open}
      onOpenChange={(nextOpen) => onOpenChange(section, nextOpen)}
      className="flex flex-col"
    >
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
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex w-full items-center justify-between gap-3 rounded-md px-1 py-1 text-left",
              "text-sidebar-foreground/90 hover:bg-sidebar-accent/60",
              "hover:text-sidebar-accent-foreground",
            )}
            aria-label={title}
          >
            <div className="flex min-w-0 items-center gap-2">
              <ChevronRight
                className={cn(
                  "shrink-0 transition-transform duration-150",
                  open && "rotate-90",
                )}
              />
              <h3 className="text-sm font-medium tracking-tight">{title}</h3>
              <Badge
                variant="secondary"
                className="rounded-full px-2.5 text-[11px] tabular-nums"
              >
                {changes.length}
              </Badge>
              <DiffLineStats
                insertions={aggregateStats.insertions}
                deletions={aggregateStats.deletions}
              />
            </div>
          </button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="pt-3">
        {tree.length === 0 ? (
          <p className="text-sm text-muted-foreground">No changes.</p>
        ) : viewMode === "list" ? (
          <SidebarMenu>
            {changes.map((change, index) => (
              <FilePathRow
                key={gitChangeKey(section, change, index)}
                change={change}
                section={section}
                theme={theme}
                disabled={disabled}
                onOpenDiff={onOpenDiff}
                onAction={onAction}
              />
            ))}
          </SidebarMenu>
        ) : (
          <SidebarMenu>
            {tree.map((node, index) =>
              node.kind === "directory" ? (
                <TreeDirectoryNode
                  key={treeNodeKey(section, node.path, node.kind, index)}
                  node={node}
                  depth={0}
                  section={section}
                  theme={theme}
                  openState={treeOpenState}
                  disabled={disabled}
                  onOpenChange={handleNodeOpenChange}
                  onOpenDiff={onOpenDiff}
                  onAction={onAction}
                />
              ) : (
                <TreeFileNode
                  key={treeNodeKey(section, node.path, node.kind, index)}
                  node={node}
                  section={section}
                  theme={theme}
                  disabled={disabled}
                  onOpenDiff={onOpenDiff}
                  onAction={onAction}
                />
              ),
            )}
          </SidebarMenu>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

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

function CommitTreeFileNode({
  node,
  theme,
  commitId,
  onOpenDiff,
}: {
  node: Extract<WorktreeGitStatusTreeNode, { kind: "file" }>;
  theme: HubrisTheme | null;
  commitId: string;
  onOpenDiff: (
    path: string,
    scope: DiffScope,
    originalPath: string | undefined,
    commitId: string | undefined,
    preview: boolean,
  ) => void;
}) {
  return (
    <SidebarMenuItem>
      <ChangeRowFrame
        className="cursor-pointer"
        interactive
        onActivate={() =>
          onOpenDiff(
            node.path,
            "commit",
            node.change.original_path ?? undefined,
            commitId,
            true,
          )
        }
        primary={
          <>
            <span aria-hidden="true" className="h-4 w-4 shrink-0" />
            <FileIcon path={node.path} theme={theme} />
            <span className="truncate text-[13px] font-medium">
              {node.name}
            </span>
          </>
        }
        badge={<ChangeStatusBadge changeType={node.change.change_type} />}
        onClick={() =>
          onOpenDiff(
            node.path,
            "commit",
            node.change.original_path ?? undefined,
            commitId,
            true,
          )
        }
        onDoubleClick={() =>
          onOpenDiff(
            node.path,
            "commit",
            node.change.original_path ?? undefined,
            commitId,
            false,
          )
        }
      />
    </SidebarMenuItem>
  );
}

function CommitTreeDirectoryNode({
  node,
  depth,
  theme,
  openState,
  onOpenChange,
  commitId,
  onOpenDiff,
}: {
  node: Extract<WorktreeGitStatusTreeNode, { kind: "directory" }>;
  depth: number;
  theme: HubrisTheme | null;
  openState: TreeOpenState;
  onOpenChange: (path: string, open: boolean) => void;
  commitId: string;
  onOpenDiff: (
    path: string,
    scope: DiffScope,
    originalPath: string | undefined,
    commitId: string | undefined,
    preview: boolean,
  ) => void;
}) {
  const open = openState[node.path] ?? depth === 0;
  const changeType = useMemo(() => aggregateDirectoryChangeType(node), [node]);

  return (
    <SidebarMenuItem>
      <Collapsible
        open={open}
        onOpenChange={(nextOpen) => onOpenChange(node.path, nextOpen)}
        className="group/collapsible"
      >
        <ChangeRowFrame
          primary={
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px] font-medium outline-hidden"
                aria-label={`Toggle ${node.path}`}
              >
                <ChevronRight
                  className={cn(
                    "size-4 shrink-0 transition-transform duration-150",
                    open && "rotate-90",
                  )}
                />
                <FolderIcon name={node.name} open={open} theme={theme} />
                <CompactedDirectoryLabel name={node.name} />
              </button>
            </CollapsibleTrigger>
          }
          badge={
            changeType ? <DirectoryStatusDot changeType={changeType} /> : null
          }
        />
        <CollapsibleContent>
          <div className="ml-[15px] border-l border-sidebar-border/70 pl-[9px]">
            <SidebarMenu className="gap-0.5 py-0.5">
              {node.children.map((child, index) =>
                child.kind === "directory" ? (
                  <CommitTreeDirectoryNode
                    key={treeNodeKey("commit", child.path, child.kind, index)}
                    node={child}
                    depth={depth + 1}
                    theme={theme}
                    openState={openState}
                    onOpenChange={onOpenChange}
                    commitId={commitId}
                    onOpenDiff={onOpenDiff}
                  />
                ) : (
                  <CommitTreeFileNode
                    key={treeNodeKey("commit", child.path, child.kind, index)}
                    node={child}
                    theme={theme}
                    commitId={commitId}
                    onOpenDiff={onOpenDiff}
                  />
                ),
              )}
            </SidebarMenu>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  );
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
  commit,
  index,
  lastIndex,
  expanded,
  detailsState,
  theme,
  treeOpenState,
  onExpandedChange,
  onDetailsRequest,
  onTreeOpenChange,
  onOpenDiff,
}: {
  commit: WorktreeGitCommitSummary;
  index: number;
  lastIndex: number;
  expanded: boolean;
  detailsState: CommitDetailsState;
  theme: HubrisTheme | null;
  treeOpenState: TreeOpenState;
  onExpandedChange: (open: boolean) => void;
  onDetailsRequest: () => void;
  onTreeOpenChange: (path: string, open: boolean) => void;
  onOpenDiff: (
    path: string,
    scope: DiffScope,
    originalPath: string | undefined,
    commitId: string | undefined,
    preview: boolean,
  ) => void;
}) {
  const tree = useMemo(
    () =>
      detailsState.details
        ? buildWorktreeGitStatusTree(detailsState.details.files)
        : [],
    [detailsState.details],
  );

  return (
    <SidebarMenuItem className="relative min-w-0">
      <Collapsible
        open={expanded}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            onDetailsRequest();
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
                  onPointerEnter={() => onDetailsRequest()}
                  onFocus={() => onDetailsRequest()}
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
                <SidebarMenu className="gap-0.5 py-0.5">
                  {tree.map((node) =>
                    node.kind === "directory" ? (
                      <CommitTreeDirectoryNode
                        key={`${commit.id}:${node.path}`}
                        node={node}
                        depth={0}
                        theme={theme}
                        openState={treeOpenState}
                        onOpenChange={onTreeOpenChange}
                        commitId={commit.id}
                        onOpenDiff={onOpenDiff}
                      />
                    ) : (
                      <CommitTreeFileNode
                        key={`${commit.id}:${node.path}`}
                        node={node}
                        theme={theme}
                        commitId={commit.id}
                        onOpenDiff={onOpenDiff}
                      />
                    ),
                  )}
                </SidebarMenu>
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

function CommitsSection({
  open,
  aheadCount,
  aheadCommits,
  comparisonAvailable,
  comparisonError,
  sourceRef,
  theme,
  commitOpenState,
  commitTreeOpenState,
  commitDetailsById,
  onOpenChange,
  onCommitOpenChange,
  onCommitTreeOpenChange,
  onDetailsRequest,
  onOpenDiff,
}: {
  open: boolean;
  aheadCount: number;
  aheadCommits: WorktreeGitCommitSummary[];
  comparisonAvailable: boolean;
  comparisonError?: string | null;
  sourceRef?: string | null;
  theme: HubrisTheme | null;
  commitOpenState: TreeOpenState;
  commitTreeOpenState: Record<string, TreeOpenState>;
  commitDetailsById: Record<string, CommitDetailsState>;
  onOpenChange: (section: SectionKey, open: boolean) => void;
  onCommitOpenChange: (commitId: string, open: boolean) => void;
  onCommitTreeOpenChange: (
    commitId: string,
    path: string,
    open: boolean,
  ) => void;
  onDetailsRequest: (commitId: string) => void;
  onOpenDiff: (
    path: string,
    scope: DiffScope,
    originalPath: string | undefined,
    commitId: string | undefined,
    preview: boolean,
  ) => void;
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
                  commit={commit}
                  index={index}
                  lastIndex={aheadCommits.length - 1}
                  expanded={commitOpenState[commit.id] ?? false}
                  detailsState={
                    commitDetailsById[commit.id] ?? EMPTY_COMMIT_DETAILS_STATE
                  }
                  theme={theme}
                  treeOpenState={commitTreeOpenState[commit.id] ?? {}}
                  onExpandedChange={(nextOpen) =>
                    onCommitOpenChange(commit.id, nextOpen)
                  }
                  onDetailsRequest={() => onDetailsRequest(commit.id)}
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

export default function WorktreeGitStatusPanel({ worktree }: Props) {
  const [sectionOpenStateByWorktree, setSectionOpenStateByWorktree] =
    useState<SectionOpenStateByWorktree>({});
  const [commitOpenStateByWorktree, setCommitOpenStateByWorktree] =
    useState<TreeOpenStateByWorktree>({});
  const [commitTreeOpenStateByWorktree, setCommitTreeOpenStateByWorktree] =
    useState<CommitTreeOpenStateByWorktree>({});
  const [commitDetailsByWorktree, setCommitDetailsByWorktree] =
    useState<CommitDetailsByWorktree>({});
  const [showLoadingSkeleton, setShowLoadingSkeleton] = useState(false);
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(
    null,
  );
  const worktreeState = useWorktreeFileManagerStore(
    (state) => state.worktrees[worktree.id],
  );
  const refreshPaths = useWorktreeFileManagerStore(
    (state) => state.refreshPaths,
  );
  const setSelectedPath = useWorktreeFileManagerStore(
    (state) => state.setSelectedPath,
  );
  const viewMode = useWorktreeGitStatusViewStore(
    (state) =>
      state.viewModeByWorktree[worktree.id] ??
      DEFAULT_WORKTREE_GIT_STATUS_VIEW_MODE,
  );
  const openGitDiff = useTabStore((state) => state.openGitDiff);
  const theme = useThemeSettings((state) => state.activeTheme);
  const status = worktreeState?.gitStatus ?? null;
  const loading = worktreeState?.gitStatusStatus === "loading";
  const error = worktreeState?.gitError
    ? `Failed to load git status (${worktreeState.gitError})`
    : "";
  const sectionOpenState =
    sectionOpenStateByWorktree[worktree.id] ?? DEFAULT_SECTION_OPEN_STATE;
  const commitOpenState = commitOpenStateByWorktree[worktree.id] ?? {};
  const commitTreeOpenState = commitTreeOpenStateByWorktree[worktree.id] ?? {};
  const commitDetailsById = commitDetailsByWorktree[worktree.id] ?? {};

  const runAction = useCallback(
    async (
      action: GitAction,
      path: string,
      originalPath: string | undefined,
      label: string,
    ) => {
      const actionKey = `${action}:${path}`;
      setPendingActionKey(actionKey);
      try {
        if (action === "stage") {
          await stageProjectWorktreePath(
            worktree.project_id,
            worktree.id,
            path,
            originalPath,
          );
        } else if (action === "unstage") {
          await unstageProjectWorktreePath(
            worktree.project_id,
            worktree.id,
            path,
            originalPath,
          );
        } else {
          await discardProjectWorktreePath(
            worktree.project_id,
            worktree.id,
            path,
          );
        }

        await refreshPaths(
          worktree.project_id,
          worktree.id,
          originalPath ? [path, originalPath] : [path],
        );
        toast.success(`${actionSuccessLabel(action)} ${label}`);
      } catch {
        toast.error(
          `Couldn't ${actionLabel(action).toLowerCase()} ${label.toLowerCase()}`,
        );
      } finally {
        setPendingActionKey((current) =>
          current === actionKey ? null : current,
        );
      }
    },
    [refreshPaths, worktree.id, worktree.project_id],
  );

  const handleAction = useCallback(
    (
      action: GitAction,
      path: string,
      originalPath: string | undefined,
      label: string,
      recursive: boolean,
    ) => {
      if (action === "discard") {
        setPendingDiscard({
          path,
          label,
          recursive,
        });
        return;
      }

      void runAction(action, path, originalPath, label);
    },
    [runAction],
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
    await runAction("discard", current.path, undefined, current.label);
  }, [pendingDiscard, runAction]);

  const ensureCommitDetails = useCallback(
    async (commitId: string) => {
      let shouldFetch = false;
      setCommitDetailsByWorktree((existing) => {
        const current = existing[worktree.id]?.[commitId];
        if (current?.status === "loading" || current?.status === "loaded") {
          return existing;
        }

        shouldFetch = true;
        return {
          ...existing,
          [worktree.id]: {
            ...(existing[worktree.id] ?? {}),
            [commitId]: {
              status: "loading",
              details: current?.details ?? null,
              error: null,
            },
          },
        };
      });

      if (!shouldFetch) {
        return;
      }

      try {
        const details = await getProjectWorktreeCommitDetails(
          worktree.project_id,
          worktree.id,
          commitId,
        );
        setCommitDetailsByWorktree((existing) => ({
          ...existing,
          [worktree.id]: {
            ...(existing[worktree.id] ?? {}),
            [commitId]: {
              status: "loaded",
              details,
              error: null,
            },
          },
        }));
      } catch (error) {
        setCommitDetailsByWorktree((existing) => ({
          ...existing,
          [worktree.id]: {
            ...(existing[worktree.id] ?? {}),
            [commitId]: {
              status: "error",
              details: null,
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to load commit details.",
            },
          },
        }));
      }
    },
    [worktree.id, worktree.project_id],
  );

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
      const timer = window.setTimeout(() => {
        setShowLoadingSkeleton(false);
      }, 0);

      return () => window.clearTimeout(timer);
    }

    const timer = window.setTimeout(() => {
      setShowLoadingSkeleton(true);
    }, LOADING_SKELETON_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [error, loading, status]);

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
                onAction={handleAction}
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
                onAction={handleAction}
              />
              <Separator />
              <CommitsSection
                open={sectionOpenState.commits}
                aheadCount={status.ahead_count}
                aheadCommits={status.ahead_commits}
                comparisonAvailable={status.comparison_available}
                comparisonError={status.comparison_error}
                sourceRef={status.source_ref}
                theme={theme}
                commitOpenState={commitOpenState}
                commitTreeOpenState={commitTreeOpenState}
                commitDetailsById={commitDetailsById}
                onOpenChange={handleSectionOpenChange}
                onCommitOpenChange={handleCommitOpenChange}
                onCommitTreeOpenChange={handleCommitTreeOpenChange}
                onDetailsRequest={ensureCommitDetails}
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
