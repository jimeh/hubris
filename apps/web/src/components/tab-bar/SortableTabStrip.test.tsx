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
    label,
    title,
    iconKind,
    toneClass,
  }: {
    label: string;
    title?: string;
    iconKind?: string;
    toneClass?: string;
  }) => (
    <div>{`${label}:${title ?? ""}:${iconKind ?? ""}:${toneClass ?? ""}`}</div>
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
});
