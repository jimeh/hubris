import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TreeView, type TreeRowRenderProps } from "@/components/tree/TreeView";
import { createTreeExpansionStore } from "@/components/tree/treeExpansionStore";

type TestNode = {
  path: string;
  children?: TestNode[];
};

function getPath(node: TestNode): string {
  return node.path;
}

function isBranch(node: TestNode): boolean {
  return node.children != null;
}

function getChildren(node: TestNode): readonly TestNode[] {
  return node.children ?? [];
}

describe("TreeView", () => {
  it("does not rerender sibling rows when one path expands", () => {
    const expansion = createTreeExpansionStore();
    const renderCounts = new Map<string, number>();
    const nodes: TestNode[] = [
      { path: "src", children: [{ path: "src/main.ts" }] },
      { path: "docs", children: [{ path: "docs/readme.md" }] },
    ];
    const renderRow = ({
      path,
      expanded,
      setExpanded,
      rowProps,
    }: TreeRowRenderProps<TestNode>) => {
      renderCounts.set(path, (renderCounts.get(path) ?? 0) + 1);
      return (
        <button
          {...rowProps}
          type="button"
          onClick={() => setExpanded(!expanded)}
        >
          {path}
        </button>
      );
    };

    render(
      <TreeView
        nodes={nodes}
        getPath={getPath}
        isBranch={isBranch}
        getChildren={getChildren}
        expansion={expansion}
        renderRow={renderRow}
      />,
    );

    expect(renderCounts.get("src")).toBe(1);
    expect(renderCounts.get("docs")).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "src" }));

    expect(renderCounts.get("src")).toBe(2);
    expect(renderCounts.get("src/main.ts")).toBe(1);
    expect(renderCounts.get("docs")).toBe(1);
  });

  it("applies layout, paint, and content-visibility containment per row", () => {
    render(
      <TreeView
        nodes={[{ path: "src" }]}
        getPath={getPath}
        renderRow={({ path, rowProps }) => (
          <button {...rowProps} type="button">
            {path}
          </button>
        )}
      />,
    );

    expect(screen.getByRole("treeitem")).toHaveStyle({
      contain: "layout style paint",
      containIntrinsicSize: "0 2rem",
      contentVisibility: "auto",
    });
  });
});
