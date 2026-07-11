import {
  Fragment,
  forwardRef,
  useCallback,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";
import { TreeView, type TreeRowRenderProps } from "@/components/tree/TreeView";
import { createTreeExpansionStore } from "@/components/tree/treeExpansionStore";
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
import type { HubrisTheme } from "@/lib/theme/types";
import type { WorktreeGitStatusTreeNode } from "@/lib/worktreeGitStatusTree";
import { cn } from "@/lib/utils";
import type { DiffScope, TreeOpenState } from "@/features/git-status/types";

export type FileNode = Extract<WorktreeGitStatusTreeNode, { kind: "file" }>;
export type DirectoryNode = Extract<
  WorktreeGitStatusTreeNode,
  { kind: "directory" }
>;

export type DirectoryRowParts = {
  node: DirectoryNode;
  open: boolean;
  primary: ReactNode;
  badge: ReactNode;
};

type SharedTreeProps = {
  nodes: WorktreeGitStatusTreeNode[];
  className?: string;
  scope: DiffScope;
  theme: HubrisTheme | null;
  openState: TreeOpenState;
  onOpenChange: (path: string, open: boolean) => void;
  renderFileRow: (node: FileNode) => ReactNode;
  renderDirectoryRow: (parts: DirectoryRowParts) => ReactNode;
};

function* walkDirectoryChangeTypes(
  node: DirectoryNode,
): Generator<GitChangeType> {
  for (const child of node.children) {
    if (child.kind === "file") {
      yield child.change.change_type;
    } else {
      yield* walkDirectoryChangeTypes(child);
    }
  }
}

function aggregateDirectoryChangeType(
  node: DirectoryNode,
): GitChangeType | null {
  return mostSignificantGitChangeType(walkDirectoryChangeTypes(node));
}

export function FolderIcon({
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

export function FileIcon({
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

export function ChangeStatusBadge({
  changeType,
}: {
  changeType: GitChangeType;
}) {
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

export const ChangeRowFrame = forwardRef<
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

function getTreeNodePath(node: WorktreeGitStatusTreeNode): string {
  return node.path;
}

function getTreeNodeKey(
  node: WorktreeGitStatusTreeNode,
  index: number,
): string {
  return `${node.kind}:${node.path}:${index}`;
}

function isDirectoryNode(node: WorktreeGitStatusTreeNode): boolean {
  return node.kind === "directory";
}

function getTreeNodeChildren(
  node: WorktreeGitStatusTreeNode,
): readonly WorktreeGitStatusTreeNode[] {
  return node.kind === "directory" ? node.children : [];
}

function isRootNodeExpanded(
  _node: WorktreeGitStatusTreeNode,
  depth: number,
): boolean {
  return depth === 0;
}

function GitStatusTreeRow({
  node,
  expanded,
  setExpanded,
  rowProps,
  theme,
  renderFileRow,
  renderDirectoryRow,
}: TreeRowRenderProps<WorktreeGitStatusTreeNode> &
  Pick<SharedTreeProps, "theme" | "renderFileRow" | "renderDirectoryRow">) {
  const changeType = useMemo(
    () =>
      node.kind === "directory" ? aggregateDirectoryChangeType(node) : null,
    [node],
  );

  if (node.kind === "file") {
    return renderFileRow(node);
  }

  const primary = (
    <button
      {...rowProps}
      type="button"
      className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px] font-medium outline-hidden"
      aria-label={`Toggle ${node.path}`}
      onClick={() => setExpanded(!expanded)}
    >
      <ChevronRight
        className={cn(
          "size-4 shrink-0 transition-transform duration-150",
          expanded && "rotate-90",
        )}
      />
      <FolderIcon name={node.name} open={expanded} theme={theme} />
      <CompactedDirectoryLabel name={node.name} />
    </button>
  );
  const badge = changeType ? (
    <DirectoryStatusDot changeType={changeType} />
  ) : null;

  return renderDirectoryRow({
    node,
    open: expanded,
    primary,
    badge,
  });
}

/** Renders a git-status tree while callers supply feature-specific row UI. */
export function SharedGitStatusTree(props: SharedTreeProps) {
  const [expansion] = useState(() =>
    createTreeExpansionStore(props.openState, props.onOpenChange),
  );
  expansion.setOnChange(props.onOpenChange);
  const renderRow = useCallback(
    (rowProps: TreeRowRenderProps<WorktreeGitStatusTreeNode>) => (
      <GitStatusTreeRow
        {...rowProps}
        theme={props.theme}
        renderFileRow={props.renderFileRow}
        renderDirectoryRow={props.renderDirectoryRow}
      />
    ),
    [props.renderDirectoryRow, props.renderFileRow, props.theme],
  );

  return (
    <TreeView
      nodes={props.nodes}
      className={props.className}
      getPath={getTreeNodePath}
      getKey={getTreeNodeKey}
      isBranch={isDirectoryNode}
      getChildren={getTreeNodeChildren}
      expansion={expansion}
      defaultExpanded={isRootNodeExpanded}
      renderRow={renderRow}
    />
  );
}
