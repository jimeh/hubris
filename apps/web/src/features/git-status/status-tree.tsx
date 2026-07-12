import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Minus, Plus, Undo } from "lucide-react";
import { DiffLineStats } from "@/components/DiffLineStats";
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
import { SidebarMenu, SidebarMenuItem } from "@/components/ui/sidebar";
import type { WorktreeGitFileChange } from "@/lib/api";
import { computeAggregateStats } from "@/lib/diffLineStats";
import type { GitStatusAction } from "@/lib/stores/gitStatus";
import type { WorktreeGitStatusViewMode } from "@/lib/stores/worktreeGitStatusView";
import type { HubrisTheme } from "@/lib/theme/types";
import { buildWorktreeGitStatusTree } from "@/lib/worktreeGitStatusTree";
import { cn } from "@/lib/utils";
import {
  ChangeRowFrame,
  ChangeStatusBadge,
  FileIcon,
  SharedGitStatusTree,
  type DirectoryRowParts,
  type FileNode,
} from "@/features/git-status/shared-tree";
import type {
  ChangeSection,
  DispatchGitAction,
  OpenGitDiff,
  TreeOpenState,
} from "@/features/git-status/types";

const ACTION_ICONS = {
  stage: Plus,
  unstage: Minus,
  discard: Undo,
} satisfies Record<GitStatusAction, typeof Plus>;

function gitChangeKey(
  section: ChangeSection,
  change: WorktreeGitFileChange,
  index: number,
): string {
  return [
    section,
    change.path,
    change.originalPath ?? "",
    change.changeType,
    index,
  ].join(":");
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

function actionLabel(action: GitStatusAction): string {
  switch (action) {
    case "stage":
      return "Stage";
    case "unstage":
      return "Unstage";
    case "discard":
      return "Discard";
  }
}

function actionToneClass(action: GitStatusAction): string {
  switch (action) {
    case "stage":
      return "text-emerald-500 hover:text-emerald-400";
    case "unstage":
      return "text-amber-500 hover:text-amber-400";
    case "discard":
      return "text-rose-500 hover:text-rose-400";
  }
}

function actionsForSection(section: ChangeSection): GitStatusAction[] {
  return section === "unstaged" ? ["discard", "stage"] : ["unstage"];
}

function RowActionButton({
  action,
  targetLabel,
  disabled,
  onAction,
}: {
  action: GitStatusAction;
  targetLabel: string;
  disabled?: boolean;
  onAction: (action: GitStatusAction) => void;
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

function ChangeContextMenu({
  children,
  targetLabel,
  actions,
  disabled,
  onAction,
}: {
  children: ReactNode;
  targetLabel: string;
  actions: GitStatusAction[];
  disabled?: boolean;
  onAction: (action: GitStatusAction) => void;
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
  onOpenDiff: OpenGitDiff;
  onAction: DispatchGitAction;
}) {
  const { basename, directoryPath } = splitChangePath(change.path);
  const actions = actionsForSection(section);

  return (
    <SidebarMenuItem>
      <ChangeContextMenu
        targetLabel={basename}
        actions={actions}
        disabled={disabled}
        onAction={(action) =>
          onAction(
            action,
            change.path,
            change.originalPath ?? undefined,
            basename,
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
              change.originalPath ?? undefined,
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
              targetLabel={basename}
              disabled={disabled}
              onAction={(nextAction) =>
                onAction(
                  nextAction,
                  change.path,
                  change.originalPath ?? undefined,
                  basename,
                  false,
                )
              }
            />
          ))}
          badge={<ChangeStatusBadge changeType={change.changeType} />}
          onClick={() =>
            onOpenDiff(
              change.path,
              section,
              change.originalPath ?? undefined,
              undefined,
              true,
            )
          }
          onDoubleClick={() =>
            onOpenDiff(
              change.path,
              section,
              change.originalPath ?? undefined,
              undefined,
              false,
            )
          }
        />
      </ChangeContextMenu>
    </SidebarMenuItem>
  );
}

export function StatusFileSection({
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
  onOpenDiff: OpenGitDiff;
  onAction: DispatchGitAction;
}) {
  const tree = useMemo(() => buildWorktreeGitStatusTree(changes), [changes]);
  const aggregateStats = useMemo(
    () => computeAggregateStats(changes),
    [changes],
  );
  const [treeOpenState, setTreeOpenState] = useState<TreeOpenState>({});
  const handleNodeOpenChange = useCallback(
    (path: string, nextOpen: boolean) => {
      setTreeOpenState((current) => ({ ...current, [path]: nextOpen }));
    },
    [],
  );
  const renderTreeFileRow = useCallback(
    (node: FileNode) => {
      const actions = actionsForSection(section);
      return (
        <ChangeContextMenu
          targetLabel={node.name}
          actions={actions}
          disabled={disabled}
          onAction={(action) =>
            onAction(
              action,
              node.path,
              node.change.originalPath ?? undefined,
              node.name,
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
                node.change.originalPath ?? undefined,
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
                targetLabel={node.name}
                disabled={disabled}
                onAction={(nextAction) =>
                  onAction(
                    nextAction,
                    node.path,
                    node.change.originalPath ?? undefined,
                    node.name,
                    false,
                  )
                }
              />
            ))}
            badge={<ChangeStatusBadge changeType={node.change.changeType} />}
            onClick={() =>
              onOpenDiff(
                node.path,
                section,
                node.change.originalPath ?? undefined,
                undefined,
                true,
              )
            }
            onDoubleClick={() =>
              onOpenDiff(
                node.path,
                section,
                node.change.originalPath ?? undefined,
                undefined,
                false,
              )
            }
          />
        </ChangeContextMenu>
      );
    },
    [disabled, onAction, onOpenDiff, section, theme],
  );
  const renderTreeDirectoryRow = useCallback(
    ({ node, primary, badge }: DirectoryRowParts) => {
      const actions = actionsForSection(section);
      return (
        <ChangeContextMenu
          targetLabel={node.name}
          actions={actions}
          disabled={disabled}
          onAction={(action) =>
            onAction(action, node.path, undefined, node.name, true)
          }
        >
          <ChangeRowFrame
            primary={primary}
            actions={actions.map((action) => (
              <RowActionButton
                key={action}
                action={action}
                targetLabel={node.name}
                disabled={disabled}
                onAction={(nextAction) =>
                  onAction(nextAction, node.path, undefined, node.name, true)
                }
              />
            ))}
            badge={badge}
          />
        </ChangeContextMenu>
      );
    },
    [disabled, onAction, section],
  );

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
          <SharedGitStatusTree
            nodes={tree}
            scope={section}
            theme={theme}
            openState={treeOpenState}
            onOpenChange={handleNodeOpenChange}
            renderFileRow={renderTreeFileRow}
            renderDirectoryRow={renderTreeDirectoryRow}
          />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
