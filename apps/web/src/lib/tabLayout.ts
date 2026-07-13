import type {
  Tab,
  TabPaneSplitAxis,
  WorktreePaneNode,
  WorktreePaneTabs,
  WorktreeTabLayout,
} from "@/lib/types";

export type PaneDropPlacement = "center" | "left" | "right" | "top" | "bottom";

export type PaneTree =
  | {
      type: "leaf";
      id: string;
      paneId: string;
    }
  | {
      type: "split";
      id: string;
      axis: TabPaneSplitAxis;
      ratio: number;
      first: PaneTree;
      second: PaneTree;
    };

function makeId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `pane-${Math.random().toString(36).slice(2, 10)}`;
}

export function makePaneId(): string {
  return makeId();
}

function makeNodeId(): string {
  return makeId();
}

function byStableTabOrder(left: Tab, right: Tab): number {
  if (left.position !== right.position) {
    return left.position - right.position;
  }
  const createdAtDiff = Number(left.createdAt) - Number(right.createdAt);
  if (Number.isFinite(createdAtDiff) && createdAtDiff !== 0) {
    return createdAtDiff;
  }
  return left.id.localeCompare(right.id);
}

function dedupeTabsById(list: Tab[]): Tab[] {
  const latestById = new Map<string, Tab>();
  for (const tab of list) {
    latestById.set(tab.id, tab);
  }
  return [...latestById.values()];
}

export function sortTabs(list: Tab[]): Tab[] {
  return dedupeTabsById(list).sort((left, right) => {
    const worktreeDiff = left.worktreeId.localeCompare(right.worktreeId);
    if (worktreeDiff !== 0) {
      return worktreeDiff;
    }
    const paneDiff = left.paneId.localeCompare(right.paneId);
    if (paneDiff !== 0) {
      return paneDiff;
    }
    return byStableTabOrder(left, right);
  });
}

export function tabsForPane(tabs: Tab[], paneId: string): Tab[] {
  return tabs.filter((tab) => tab.paneId === paneId).sort(byStableTabOrder);
}

function layoutNodeId(node: WorktreePaneNode): string {
  return node.id;
}

function layoutNodesById(
  layout: WorktreeTabLayout,
): Map<string, WorktreePaneNode> | null {
  const nodes = new Map<string, WorktreePaneNode>();
  for (const node of layout.nodes) {
    const id = layoutNodeId(node);
    if (!id || nodes.has(id)) {
      return null;
    }
    nodes.set(id, node);
  }
  return nodes;
}

export function firstPaneId(
  layout: WorktreeTabLayout | null | undefined,
): string | null {
  if (!layout) {
    return null;
  }

  const nodes = layoutNodesById(layout);
  if (!nodes) {
    return null;
  }

  let nextId = layout.rootId;
  while (true) {
    const node = nodes.get(nextId);
    if (!node) {
      return null;
    }
    if (node.type === "leaf") {
      return node.paneId;
    }
    nextId = node.firstId;
  }
}

export function collectPaneIds(
  layout: WorktreeTabLayout | null | undefined,
): string[] {
  if (!layout) {
    return [];
  }

  const nodes = layoutNodesById(layout);
  if (!nodes || !layout.rootId) {
    return [];
  }

  const nodeMap = nodes;
  const visited = new Set<string>();
  const panes: string[] = [];

  function visit(nodeId: string): void {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);
    const node = nodeMap.get(nodeId);
    if (!node) {
      return;
    }
    if (node.type === "leaf") {
      panes.push(node.paneId);
      return;
    }
    visit(node.firstId);
    visit(node.secondId);
  }

  visit(layout.rootId);
  return panes;
}

export function buildPaneTree(
  layout: WorktreeTabLayout | null | undefined,
): PaneTree | null {
  if (!layout) {
    return null;
  }

  const nodes = layoutNodesById(layout);
  if (!nodes) {
    return null;
  }

  const nodeMap = nodes;

  function build(nodeId: string): PaneTree | null {
    const node = nodeMap.get(nodeId);
    if (!node) {
      return null;
    }
    if (node.type === "leaf") {
      return {
        type: "leaf",
        id: node.id,
        paneId: node.paneId,
      };
    }

    const first = build(node.firstId);
    const second = build(node.secondId);
    if (!first || !second) {
      return null;
    }

    return {
      type: "split",
      id: node.id,
      axis: node.axis,
      ratio: node.ratio,
      first,
      second,
    };
  }

  return build(layout.rootId);
}

export function createSinglePaneLayout(
  paneId = makePaneId(),
): WorktreeTabLayout {
  const rootId = makeNodeId();
  return {
    rootId,
    nodes: [{ type: "leaf", id: rootId, paneId: paneId }],
  };
}

function clampSplitRatio(ratio: number): number {
  return Math.max(0.1, Math.min(0.9, ratio));
}

type RebuiltNode = {
  rootId: string;
  nodes: WorktreePaneNode[];
};

function collapseTree(
  tree: PaneTree,
  paneTabIds: Map<string, string[]>,
  isRoot: boolean,
  fallbackPaneId: string,
): PaneTree | null {
  if (tree.type === "leaf") {
    const hasTabs = (paneTabIds.get(tree.paneId) ?? []).length > 0;
    if (!isRoot && !hasTabs) {
      return null;
    }
    return tree;
  }

  const first = collapseTree(tree.first, paneTabIds, false, fallbackPaneId);
  const second = collapseTree(tree.second, paneTabIds, false, fallbackPaneId);

  if (first && second) {
    return { ...tree, first, second };
  }
  if (first) {
    return first;
  }
  if (second) {
    return second;
  }
  if (!isRoot) {
    return null;
  }
  return {
    type: "leaf",
    id: makeNodeId(),
    paneId: fallbackPaneId,
  };
}

function flattenTree(tree: PaneTree): RebuiltNode {
  if (tree.type === "leaf") {
    return {
      rootId: tree.id,
      nodes: [{ type: "leaf", id: tree.id, paneId: tree.paneId }],
    };
  }

  const first = flattenTree(tree.first);
  const second = flattenTree(tree.second);

  return {
    rootId: tree.id,
    nodes: [
      ...first.nodes,
      ...second.nodes,
      {
        type: "split",
        id: tree.id,
        axis: tree.axis,
        ratio: tree.ratio,
        firstId: first.rootId,
        secondId: second.rootId,
      },
    ],
  };
}

export function collapseLayoutToTabs(
  layout: WorktreeTabLayout,
  tabs: Tab[],
): WorktreeTabLayout {
  const tree = buildPaneTree(layout);
  if (!tree) {
    return layout;
  }

  const paneTabIds = new Map<string, string[]>();
  for (const paneId of collectPaneIds(layout)) {
    paneTabIds.set(
      paneId,
      tabsForPane(tabs, paneId).map((tab) => tab.id),
    );
  }

  const fallbackPaneId = firstPaneId(layout) ?? tabs[0]?.paneId ?? makePaneId();
  const collapsed = collapseTree(tree, paneTabIds, true, fallbackPaneId);
  if (!collapsed) {
    return createSinglePaneLayout(fallbackPaneId);
  }

  return flattenTree(collapsed);
}

function clonePaneTabsMap(
  layout: WorktreeTabLayout,
  tabs: Tab[],
): Map<string, string[]> {
  return new Map(
    collectPaneIds(layout).map((paneId) => [
      paneId,
      tabsForPane(tabs, paneId).map((tab) => tab.id),
    ]),
  );
}

function reassignTabs(tabs: Tab[], paneTabs: Map<string, string[]>): Tab[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const nextTabs: Tab[] = [];
  const touchedIds = new Set<string>();

  for (const [paneId, tabIds] of paneTabs) {
    tabIds.forEach((tabId, index) => {
      const tab = byId.get(tabId);
      if (!tab || touchedIds.has(tabId)) {
        return;
      }
      touchedIds.add(tabId);
      nextTabs.push({
        ...tab,
        paneId: paneId,
        position: index + 1,
      });
    });
  }

  for (const tab of tabs) {
    if (!touchedIds.has(tab.id)) {
      nextTabs.push(tab);
    }
  }

  return sortTabs(nextTabs);
}

function splitAxisForPlacement(
  placement: Exclude<PaneDropPlacement, "center">,
): TabPaneSplitAxis {
  return placement === "left" || placement === "right"
    ? "vertical"
    : "horizontal";
}

function replaceLeafWithSplit(
  tree: PaneTree,
  targetPaneId: string,
  placement: Exclude<PaneDropPlacement, "center">,
  newPaneId: string,
): PaneTree {
  if (tree.type === "leaf") {
    if (tree.paneId !== targetPaneId) {
      return tree;
    }

    const existingLeaf: PaneTree = {
      type: "leaf",
      id: makeNodeId(),
      paneId: tree.paneId,
    };
    const newLeaf: PaneTree = {
      type: "leaf",
      id: makeNodeId(),
      paneId: newPaneId,
    };
    const insertFirst = placement === "left" || placement === "top";

    return {
      type: "split",
      id: makeNodeId(),
      axis: splitAxisForPlacement(placement),
      ratio: 0.5,
      first: insertFirst ? newLeaf : existingLeaf,
      second: insertFirst ? existingLeaf : newLeaf,
    };
  }

  return {
    ...tree,
    first: replaceLeafWithSplit(tree.first, targetPaneId, placement, newPaneId),
    second: replaceLeafWithSplit(
      tree.second,
      targetPaneId,
      placement,
      newPaneId,
    ),
  };
}

export function serializePaneTabs(
  layout: WorktreeTabLayout,
  tabs: Tab[],
): WorktreePaneTabs[] {
  return collectPaneIds(layout).map((paneId) => ({
    paneId,
    tabIds: tabsForPane(tabs, paneId).map((tab) => tab.id),
  }));
}

export function moveTabBetweenPanes(
  layout: WorktreeTabLayout,
  tabs: Tab[],
  tabId: string,
  targetPaneId: string,
  placement: PaneDropPlacement,
  targetIndex?: number,
): {
  layout: WorktreeTabLayout;
  tabs: Tab[];
  destinationPaneId: string;
} | null {
  const draggedTab = tabs.find((tab) => tab.id === tabId);
  if (!draggedTab) {
    return null;
  }

  const paneTabs = clonePaneTabsMap(layout, tabs);
  const sourcePaneIds = paneTabs.get(draggedTab.paneId);
  if (!sourcePaneIds) {
    return null;
  }

  paneTabs.set(
    draggedTab.paneId,
    sourcePaneIds.filter((candidateId) => candidateId !== tabId),
  );

  let nextLayout = layout;
  let destinationPaneId = targetPaneId;

  if (placement === "center") {
    const targetPaneTabs = [...(paneTabs.get(targetPaneId) ?? [])];
    const insertAt =
      typeof targetIndex === "number"
        ? Math.max(0, Math.min(targetPaneTabs.length, targetIndex))
        : targetPaneTabs.length;
    targetPaneTabs.splice(insertAt, 0, tabId);
    paneTabs.set(targetPaneId, targetPaneTabs);
  } else {
    const tree = buildPaneTree(layout);
    if (!tree) {
      return null;
    }
    destinationPaneId = makePaneId();
    const splitTree = replaceLeafWithSplit(
      tree,
      targetPaneId,
      placement,
      destinationPaneId,
    );
    nextLayout = flattenTree(splitTree);
    paneTabs.set(destinationPaneId, [tabId]);
  }

  const nextTabs = reassignTabs(tabs, paneTabs);
  const collapsedLayout = collapseLayoutToTabs(nextLayout, nextTabs);

  return {
    layout: collapsedLayout,
    tabs: reassignTabs(nextTabs, clonePaneTabsMap(collapsedLayout, nextTabs)),
    destinationPaneId,
  };
}

export function splitPaneInLayout(
  layout: WorktreeTabLayout,
  targetPaneId: string,
  placement: Exclude<PaneDropPlacement, "center">,
): {
  layout: WorktreeTabLayout;
  destinationPaneId: string;
} | null {
  const tree = buildPaneTree(layout);
  if (!tree) {
    return null;
  }

  if (!collectPaneIds(layout).includes(targetPaneId)) {
    return null;
  }

  const destinationPaneId = makePaneId();
  const splitTree = replaceLeafWithSplit(
    tree,
    targetPaneId,
    placement,
    destinationPaneId,
  );

  return {
    layout: flattenTree(splitTree),
    destinationPaneId,
  };
}

/** Updates a split node's ratio while preserving the rest of the layout. */
export function setPaneSplitRatio(
  layout: WorktreeTabLayout,
  nodeId: string,
  ratio: number,
): WorktreeTabLayout {
  const nextRatio = clampSplitRatio(ratio);
  let changed = false;

  const nextNodes = layout.nodes.map((node) => {
    if (node.type !== "split" || node.id !== nodeId) {
      return node;
    }

    if (Math.abs(node.ratio - nextRatio) < 0.001) {
      return node;
    }

    changed = true;
    return { ...node, ratio: nextRatio };
  });

  return changed ? { ...layout, nodes: nextNodes } : layout;
}
