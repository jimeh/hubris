// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { createRef, type PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalTab } from "@/lib/types";
import SortableTabStrip from "./SortableTabStrip";

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: PropsWithChildren) => <>{children}</>,
  horizontalListSortingStrategy: vi.fn(),
}));

vi.mock("@/lib/stores/theme", () => ({
  useThemeSettings: (selector: (state: { activeTheme: null }) => unknown) =>
    selector({ activeTheme: null }),
}));

vi.mock("@/lib/stores/worktreeFileManager", () => ({
  useWorktreeFileManagerStore: (
    selector: (state: {
      worktrees: Record<string, { gitStatus: null }>;
    }) => unknown,
  ) => selector({ worktrees: { w1: { gitStatus: null } } }),
}));

const presentTabMock = vi.fn((tab: TerminalTab) => ({
  label: `${tab.label}!`,
  title: `${tab.label} title`,
  iconKind: "terminal" as const,
  iconPath: undefined,
  iconId: undefined,
  toneClass: "text-amber-500",
}));

vi.mock("@/lib/tabPresentation", () => ({
  presentTab: (tab: TerminalTab) => presentTabMock(tab),
}));

vi.mock("./SortableTab", () => ({
  default: ({
    tabId,
    label,
    title,
    iconKind,
    toneClass,
  }: {
    tabId: string;
    label: string;
    title?: string;
    iconKind?: string;
    toneClass?: string;
  }) => (
    <div data-sortable-tab={tabId}>
      {`${label}:${title ?? ""}:${iconKind ?? ""}:${toneClass ?? ""}`}
    </div>
  ),
}));

function makeTab(id: string, position: number): TerminalTab {
  return {
    id,
    label: `Tab ${id.toUpperCase()}`,
    position,
    worktree_id: "w1",
    pane_id: "pane-1",
    session_id: "default",
    type: "terminal",
    created_at: 0,
    preview: false,
  };
}

describe("SortableTabStrip", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    presentTabMock.mockClear();
  });

  it("renders tab presentations from presentTab()", () => {
    render(
      <SortableTabStrip
        worktreeId="w1"
        paneId="pane-1"
        tabBarDropTargetId="pane-tab-bar:pane-1"
        tabs={[makeTab("a", 1), makeTab("b", 2)]}
        activeTabId="a"
        tabListRef={createRef<HTMLDivElement>()}
        onScroll={vi.fn()}
        onActivate={vi.fn()}
        onPin={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Tab A!:Tab A title:terminal:text-amber-500"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Tab B!:Tab B title:terminal:text-amber-500"),
    ).toBeInTheDocument();
  });

  it("marks the tab list as dragging when requested", () => {
    render(
      <SortableTabStrip
        worktreeId="w1"
        paneId="pane-1"
        tabBarDropTargetId="pane-tab-bar:pane-1"
        tabs={[makeTab("a", 1), makeTab("b", 2)]}
        activeTabId="a"
        tabListRef={createRef<HTMLDivElement>()}
        onScroll={vi.fn()}
        onActivate={vi.fn()}
        onPin={vi.fn()}
        onClose={vi.fn()}
        dragging
      />,
    );

    expect(screen.getByRole("tablist")).toHaveAttribute(
      "data-tab-dragging",
      "true",
    );
  });

  it("does not mark the tab list as dragging by default", () => {
    render(
      <SortableTabStrip
        worktreeId="w1"
        paneId="pane-1"
        tabBarDropTargetId="pane-tab-bar:pane-1"
        tabs={[makeTab("a", 1), makeTab("b", 2)]}
        activeTabId="a"
        tabListRef={createRef<HTMLDivElement>()}
        onScroll={vi.fn()}
        onActivate={vi.fn()}
        onPin={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("tablist")).not.toHaveAttribute(
      "data-tab-dragging",
      "true",
    );
  });

  it("shows an insert indicator before the hovered tab for cross-pane drags", () => {
    const { container } = render(
      <SortableTabStrip
        worktreeId="w1"
        paneId="pane-1"
        tabBarDropTargetId="pane-tab-bar:pane-1"
        tabs={[makeTab("a", 1), makeTab("b", 2)]}
        activeTabId="a"
        tabListRef={createRef<HTMLDivElement>()}
        onScroll={vi.fn()}
        onActivate={vi.fn()}
        onPin={vi.fn()}
        onClose={vi.fn()}
        dragging
        draggingTabId="external-tab"
        dragOverId="b"
      />,
    );

    const tabBWrapper = container.querySelector('[data-tab-strip-item="b"]');
    const indicator = container.querySelector("[data-tab-insert-indicator]");

    expect(indicator).toBeInTheDocument();
    expect(tabBWrapper?.firstElementChild).toBe(indicator);
  });

  it("shows an insert indicator after the hovered tab for same-pane drags moving right", () => {
    const { container } = render(
      <SortableTabStrip
        worktreeId="w1"
        paneId="pane-1"
        tabBarDropTargetId="pane-tab-bar:pane-1"
        tabs={[makeTab("a", 1), makeTab("b", 2)]}
        activeTabId="a"
        tabListRef={createRef<HTMLDivElement>()}
        onScroll={vi.fn()}
        onActivate={vi.fn()}
        onPin={vi.fn()}
        onClose={vi.fn()}
        dragging
        draggingTabId="a"
        dragOverId="b"
      />,
    );

    const tabBWrapper = container.querySelector('[data-tab-strip-item="b"]');
    const indicator = container.querySelector("[data-tab-insert-indicator]");

    expect(indicator).toBeInTheDocument();
    expect(tabBWrapper?.lastElementChild).toBe(indicator);
  });

  it("shows an insert indicator at the end when hovering the pane tab bar", () => {
    const { container } = render(
      <SortableTabStrip
        worktreeId="w1"
        paneId="pane-1"
        tabBarDropTargetId="pane-tab-bar:pane-1"
        tabs={[makeTab("a", 1), makeTab("b", 2)]}
        activeTabId="a"
        tabListRef={createRef<HTMLDivElement>()}
        onScroll={vi.fn()}
        onActivate={vi.fn()}
        onPin={vi.fn()}
        onClose={vi.fn()}
        dragging
        draggingTabId="external-tab"
        dragOverId="pane-tab-bar:pane-1"
      />,
    );

    const tabBWrapper = container.querySelector('[data-tab-strip-item="b"]');
    const indicator = container.querySelector("[data-tab-insert-indicator]");

    expect(indicator).toBeInTheDocument();
    expect(tabBWrapper?.lastElementChild).toBe(indicator);
  });
});
