import {
  Fragment,
  forwardRef,
  useMemo,
  type ComponentProps,
  type ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { SidebarMenu, SidebarMenuItem } from "@/components/ui/sidebar";
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

type FileNode = Extract<WorktreeGitStatusTreeNode, { kind: "file" }>;
type DirectoryNode = Extract<WorktreeGitStatusTreeNode, { kind: "directory" }>;

type DirectoryRowParts = {
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

function treeNodeKey(
  scope: DiffScope,
  node: WorktreeGitStatusTreeNode,
  index: number,
): string {
  return [scope, node.kind, node.path, index].join(":");
}

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

function SharedTreeNode({
  node,
  index,
  depth,
  ...props
}: Omit<SharedTreeProps, "nodes"> & {
  node: WorktreeGitStatusTreeNode;
  index: number;
  depth: number;
}) {
  const open = props.openState[node.path] ?? depth === 0;
  const changeType = useMemo(
    () =>
      node.kind === "directory" ? aggregateDirectoryChangeType(node) : null,
    [node],
  );

  if (node.kind === "file") {
    return (
      <SidebarMenuItem key={treeNodeKey(props.scope, node, index)}>
        {props.renderFileRow(node)}
      </SidebarMenuItem>
    );
  }

  const primary = (
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
        <FolderIcon name={node.name} open={open} theme={props.theme} />
        <CompactedDirectoryLabel name={node.name} />
      </button>
    </CollapsibleTrigger>
  );
  const badge = changeType ? (
    <DirectoryStatusDot changeType={changeType} />
  ) : null;

  return (
    <SidebarMenuItem key={treeNodeKey(props.scope, node, index)}>
      <Collapsible
        open={open}
        onOpenChange={(nextOpen) => props.onOpenChange(node.path, nextOpen)}
        className="group/collapsible"
      >
        {props.renderDirectoryRow({ node, open, primary, badge })}
        <CollapsibleContent>
          <div className="ml-[15px] border-l border-sidebar-border/70 pl-[9px]">
            <SidebarMenu className="gap-0.5 py-0.5">
              {node.children.map((child, childIndex) => (
                <SharedTreeNode
                  key={treeNodeKey(props.scope, child, childIndex)}
                  {...props}
                  node={child}
                  index={childIndex}
                  depth={depth + 1}
                />
              ))}
            </SidebarMenu>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  );
}

/** Renders a git-status tree while callers supply feature-specific row UI. */
export function SharedGitStatusTree(props: SharedTreeProps) {
  return (
    <SidebarMenu className={props.className}>
      {props.nodes.map((node, index) => (
        <SharedTreeNode
          key={treeNodeKey(props.scope, node, index)}
          {...props}
          node={node}
          index={index}
          depth={0}
        />
      ))}
    </SidebarMenu>
  );
}
