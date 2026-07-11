import {
  memo,
  useCallback,
  useSyncExternalStore,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { SidebarMenu, SidebarMenuItem } from "@/components/ui/sidebar";
import type { TreeExpansionSource } from "@/components/tree/treeExpansionStore";
import { cn } from "@/lib/utils";

const CONTAINED_TREE_ROW_STYLE: CSSProperties = {
  contain: "layout style paint",
  containIntrinsicSize: "0 2rem",
  contentVisibility: "auto",
};

export type TreeRowInteractionProps = Pick<
  HTMLAttributes<HTMLElement>,
  "aria-selected" | "onFocus" | "onKeyDown" | "role"
> & {
  "data-tree-row-focus": true;
};

export type TreeRowRenderProps<Node> = {
  node: Node;
  path: string;
  depth: number;
  branch: boolean;
  expanded: boolean;
  selected: boolean;
  setExpanded: (expanded: boolean) => void;
  rowProps: TreeRowInteractionProps;
};

export type TreeBranchRenderProps<Node> = {
  node: Node;
  path: string;
  depth: number;
  children: ReactNode;
};

export type TreeViewProps<Node> = {
  nodes: readonly Node[];
  getPath: (node: Node) => string;
  getKey?: (node: Node, index: number) => string;
  isBranch?: (node: Node) => boolean;
  getChildren?: (node: Node) => readonly Node[];
  expansion?: TreeExpansionSource;
  defaultExpanded?: (node: Node, depth: number) => boolean;
  renderRow: (props: TreeRowRenderProps<Node>) => ReactNode;
  renderBranch?: (props: TreeBranchRenderProps<Node>) => ReactNode;
  className?: string;
  branchClassName?: string;
  role?: "tree" | "listbox";
  rowRole?: "treeitem" | "option";
  tabIndex?: number;
  focusedPath?: string | null;
  onFocusedPathChange?: (path: string) => void;
  onActivate?: (node: Node) => void;
  onNavigateParent?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
};

function focusRelativeRow(target: HTMLElement, offset: -1 | 1): void {
  const root = target.closest<HTMLElement>("[data-tree-root]");
  if (!root) {
    return;
  }
  const rows = Array.from(
    root.querySelectorAll<HTMLElement>("[data-tree-row-focus]"),
  ).filter(
    (row) => row.offsetParent !== null || row === document.activeElement,
  );
  const index = rows.indexOf(target);
  rows[index + offset]?.focus();
}

type TreeRowProps<Node> = Omit<TreeViewProps<Node>, "nodes" | "className"> & {
  onRowFocus?: (path: string) => void;
  node: Node;
  depth: number;
  selected?: boolean;
};

function TreeRowInner<Node>({
  node,
  depth,
  getPath,
  getKey,
  isBranch,
  getChildren,
  expansion,
  defaultExpanded,
  renderRow,
  renderBranch,
  branchClassName,
  rowRole,
  selected,
  onRowFocus,
}: TreeRowProps<Node>) {
  const path = getPath(node);
  const branch = isBranch?.(node) ?? false;
  const subscribe = useCallback(
    (listener: () => void) =>
      expansion?.subscribe(path, listener) ?? (() => {}),
    [expansion, path],
  );
  const getSnapshot = useCallback(
    () => expansion?.getSnapshot(path),
    [expansion, path],
  );
  const explicitExpanded = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  const expanded =
    branch && (explicitExpanded ?? defaultExpanded?.(node, depth) ?? false);
  const setExpanded = useCallback(
    (nextExpanded: boolean) => {
      if (branch) {
        expansion?.setExpanded(path, nextExpanded);
      }
    },
    [branch, expansion, path],
  );
  const handleRowFocus = useCallback(() => {
    onRowFocus?.(path);
  }, [onRowFocus, path]);
  const handleRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const target = event.currentTarget;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusRelativeRow(target, 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        focusRelativeRow(target, -1);
      } else if (event.key === "ArrowRight" && branch) {
        event.preventDefault();
        if (!expanded) {
          setExpanded(true);
        } else {
          focusRelativeRow(target, 1);
        }
      } else if (event.key === "ArrowLeft" && branch && expanded) {
        event.preventDefault();
        setExpanded(false);
      }
    },
    [branch, expanded, setExpanded],
  );

  const children = branch && expanded ? (getChildren?.(node) ?? []) : [];
  const childTree = children.length ? (
    <TreeRows
      nodes={children}
      depth={depth + 1}
      getPath={getPath}
      getKey={getKey}
      isBranch={isBranch}
      getChildren={getChildren}
      expansion={expansion}
      defaultExpanded={defaultExpanded}
      renderRow={renderRow}
      renderBranch={renderBranch}
      branchClassName={branchClassName}
      rowRole={rowRole}
      onRowFocus={onRowFocus}
    />
  ) : null;
  const branchContent =
    branch && expanded
      ? (renderBranch?.({
          node,
          path,
          depth,
          children: childTree,
        }) ?? childTree)
      : null;

  return (
    <SidebarMenuItem
      role={rowRole === "option" ? "presentation" : rowRole}
      style={CONTAINED_TREE_ROW_STYLE}
      data-tree-row={path}
      aria-expanded={branch ? expanded : undefined}
    >
      {renderRow({
        node,
        path,
        depth,
        branch,
        expanded,
        selected: selected ?? false,
        setExpanded,
        rowProps: {
          "data-tree-row-focus": true,
          role: rowRole === "option" ? "option" : undefined,
          "aria-selected": rowRole === "option" ? selected : undefined,
          onKeyDown: handleRowKeyDown,
          // Keep controlled focusedPath in sync with DOM focus so
          // root-level Enter/Arrow handling never acts on a stale row.
          onFocus: handleRowFocus,
        },
      })}
      {branchContent ? (
        <div
          className={cn(
            "ml-[15px] border-l border-sidebar-border/70 pl-[9px]",
            branchClassName,
          )}
        >
          {branchContent}
        </div>
      ) : null}
    </SidebarMenuItem>
  );
}

const TreeRow = memo(TreeRowInner) as typeof TreeRowInner;

type TreeRowsProps<Node> = Omit<
  TreeViewProps<Node>,
  | "className"
  | "role"
  | "tabIndex"
  | "focusedPath"
  | "onFocusedPathChange"
  | "onActivate"
  | "onNavigateParent"
  | "onKeyDown"
> & {
  depth: number;
  onRowFocus?: (path: string) => void;
};

function TreeRows<Node>({ nodes, depth, ...props }: TreeRowsProps<Node>) {
  return (
    <SidebarMenu className="gap-0.5 py-0.5">
      {nodes.map((node, index) => (
        <TreeRow
          key={props.getKey?.(node, index) ?? props.getPath(node)}
          {...props}
          node={node}
          depth={depth}
        />
      ))}
    </SidebarMenu>
  );
}

/** Renders memoized, path-scoped rows with shared tree keyboard behavior. */
export function TreeView<Node>({
  nodes,
  className,
  role = "tree",
  rowRole = role === "listbox" ? "option" : "treeitem",
  tabIndex,
  focusedPath,
  onFocusedPathChange,
  onActivate,
  onNavigateParent,
  onKeyDown,
  ...rowProps
}: TreeViewProps<Node>) {
  const handleRowFocus = useCallback(
    (path: string) => {
      onFocusedPathChange?.(path);
    },
    [onFocusedPathChange],
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || nodes.length === 0) {
        return;
      }
      const currentIndex = nodes.findIndex(
        (node) => rowProps.getPath(node) === focusedPath,
      );
      if (event.key === "ArrowDown") {
        event.preventDefault();
        const next = nodes[Math.min(currentIndex + 1, nodes.length - 1)];
        onFocusedPathChange?.(rowProps.getPath(next));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        const next = nodes[Math.max(currentIndex - 1, 0)];
        onFocusedPathChange?.(rowProps.getPath(next));
      } else if (event.key === "Enter" && currentIndex >= 0) {
        event.preventDefault();
        onActivate?.(nodes[currentIndex]);
      } else if (event.key === "Backspace") {
        event.preventDefault();
        onNavigateParent?.();
      }
    },
    [
      focusedPath,
      nodes,
      onActivate,
      onFocusedPathChange,
      onKeyDown,
      onNavigateParent,
      rowProps,
    ],
  );

  return (
    <SidebarMenu
      className={className}
      role={role}
      tabIndex={tabIndex}
      data-tree-root
      onKeyDown={handleKeyDown}
    >
      {nodes.map((node, index) => (
        <TreeRow
          key={rowProps.getKey?.(node, index) ?? rowProps.getPath(node)}
          {...rowProps}
          node={node}
          depth={0}
          rowRole={rowRole}
          selected={rowProps.getPath(node) === focusedPath}
          onRowFocus={handleRowFocus}
        />
      ))}
    </SidebarMenu>
  );
}
