import { describe, expect, it } from "vitest";
import {
  buildPaneTree,
  collapseLayoutToTabs,
  moveTabBetweenPanes,
  setPaneSplitRatio,
  serializePaneTabs,
  sortTabs,
  type PaneTree,
} from "@/lib/tabLayout";
import type { Tab, TerminalTab, WorktreeTabLayout } from "@/lib/types";

function makeTerminalTab(
  id: string,
  paneId: string,
  position: number,
): TerminalTab {
  return {
    id,
    label: `Terminal ${id}`,
    position,
    worktreeId: "w1",
    paneId: paneId,
    sessionId: "default",
    type: "terminal",
    createdAt: position,
    preview: false,
  };
}

function splitLayout(
  leftPaneId: string,
  rightPaneId: string,
): WorktreeTabLayout {
  return {
    rootId: "split-root",
    nodes: [
      { type: "leaf", id: "leaf-left", paneId: leftPaneId },
      { type: "leaf", id: "leaf-right", paneId: rightPaneId },
      {
        type: "split",
        id: "split-root",
        axis: "vertical",
        ratio: 0.5,
        firstId: "leaf-left",
        secondId: "leaf-right",
      },
    ],
  };
}

function collectLeafPaneIds(tree: PaneTree | null): string[] {
  if (!tree) {
    return [];
  }
  if (tree.type === "leaf") {
    return [tree.paneId];
  }
  return [
    ...collectLeafPaneIds(tree.first),
    ...collectLeafPaneIds(tree.second),
  ];
}

describe("tabLayout", () => {
  it("moves a tab into another pane without leaving an empty source pane", () => {
    const layout = splitLayout("pane-a", "pane-b");
    const tabs: Tab[] = [
      makeTerminalTab("tab-a", "pane-a", 1),
      makeTerminalTab("tab-b", "pane-b", 1),
    ];

    const next = moveTabBetweenPanes(layout, tabs, "tab-a", "pane-b", "center");

    expect(next).not.toBeNull();
    expect(next?.tabs.map((tab) => [tab.id, tab.paneId, tab.position])).toEqual(
      [
        ["tab-b", "pane-b", 1],
        ["tab-a", "pane-b", 2],
      ],
    );
    expect(collectLeafPaneIds(buildPaneTree(next?.layout ?? layout))).toEqual([
      "pane-b",
    ]);
  });

  it("keeps existing split node ids when moving between non-empty panes", () => {
    const layout = splitLayout("pane-a", "pane-b");
    const tabs: Tab[] = [
      makeTerminalTab("tab-a", "pane-a", 1),
      makeTerminalTab("tab-b", "pane-a", 2),
      makeTerminalTab("tab-c", "pane-b", 1),
    ];

    const next = moveTabBetweenPanes(layout, tabs, "tab-b", "pane-b", "center");

    expect(next).not.toBeNull();
    expect(next?.layout).toEqual(layout);
  });

  it("splits a pane when dropping on an edge target", () => {
    const layout: WorktreeTabLayout = {
      rootId: "leaf-root",
      nodes: [{ type: "leaf", id: "leaf-root", paneId: "pane-a" }],
    };
    const tabs: Tab[] = [
      makeTerminalTab("tab-a", "pane-a", 1),
      makeTerminalTab("tab-b", "pane-a", 2),
    ];

    const next = moveTabBetweenPanes(layout, tabs, "tab-b", "pane-a", "right");

    expect(next).not.toBeNull();
    const tree = buildPaneTree(next?.layout ?? layout);
    expect(tree?.type).toBe("split");
    expect(tree && tree.type === "split" ? tree.axis : null).toBe("vertical");
    expect(collectLeafPaneIds(tree)).toHaveLength(2);
    expect(next?.tabs.find((tab) => tab.id === "tab-a")?.paneId).toBe("pane-a");
    expect(next?.tabs.find((tab) => tab.id === "tab-b")?.paneId).not.toBe(
      "pane-a",
    );
  });

  it("serializes pane tab membership in layout order after collapsing empties", () => {
    const layout = splitLayout("pane-a", "pane-b");
    const tabs: Tab[] = [makeTerminalTab("tab-b", "pane-b", 1)];

    const collapsed = collapseLayoutToTabs(layout, tabs);
    const paneTabs = serializePaneTabs(collapsed, tabs);

    expect(collectLeafPaneIds(buildPaneTree(collapsed))).toEqual(["pane-b"]);
    expect(paneTabs).toEqual([{ paneId: "pane-b", tabIds: ["tab-b"] }]);
  });

  it("updates a split ratio without rebuilding the layout shape", () => {
    const layout = splitLayout("pane-a", "pane-b");

    const next = setPaneSplitRatio(layout, "split-root", 0.7);

    expect(next.rootId).toBe("split-root");
    expect(next.nodes).toEqual([
      { type: "leaf", id: "leaf-left", paneId: "pane-a" },
      { type: "leaf", id: "leaf-right", paneId: "pane-b" },
      {
        type: "split",
        id: "split-root",
        axis: "vertical",
        ratio: 0.7,
        firstId: "leaf-left",
        secondId: "leaf-right",
      },
    ]);
  });

  it("dedupes repeated tab ids when sorting tabs", () => {
    const tabs: Tab[] = [
      makeTerminalTab("tab-a", "pane-a", 1),
      {
        ...makeTerminalTab("tab-a", "pane-b", 2),
        createdAt: 10,
      },
      makeTerminalTab("tab-b", "pane-b", 1),
    ];

    expect(tabs.map((tab) => tab.id)).toEqual(["tab-a", "tab-a", "tab-b"]);
    expect(sortTabs(tabs).map((tab) => [tab.id, tab.paneId])).toEqual([
      ["tab-b", "pane-b"],
      ["tab-a", "pane-b"],
    ]);
  });
});
