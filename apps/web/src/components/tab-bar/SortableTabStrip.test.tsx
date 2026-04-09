// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { createRef, type PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalTab } from "@/lib/types";
import SortableTabStrip from "./SortableTabStrip";

type CapturedDndHandlers = {
  onDragStart?: (event: unknown) => void;
  onDragEnd?: (event: unknown) => void;
  onDragCancel?: () => void;
};

const capturedDndHandlers: CapturedDndHandlers = {};

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragStart,
    onDragEnd,
    onDragCancel,
  }: PropsWithChildren<CapturedDndHandlers>) => {
    capturedDndHandlers.onDragStart = onDragStart;
    capturedDndHandlers.onDragEnd = onDragEnd;
    capturedDndHandlers.onDragCancel = onDragCancel;
    return <>{children}</>;
  },
  DragOverlay: ({ children }: PropsWithChildren) => <>{children}</>,
  PointerSensor: class PointerSensor {},
  closestCenter: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: PropsWithChildren) => <>{children}</>,
  horizontalListSortingStrategy: vi.fn(),
  arrayMove: <T,>(items: T[], oldIndex: number, newIndex: number) => {
    const next = [...items];
    const [moved] = next.splice(oldIndex, 1);
    next.splice(newIndex, 0, moved);
    return next;
  },
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

vi.mock("./SortableTabView", () => ({
  default: ({
    label,
    title,
    iconKind,
    toneClass,
    isOverlay,
    width,
  }: {
    label: string;
    title?: string;
    iconKind?: string;
    toneClass?: string;
    isOverlay?: boolean;
    width?: number | null;
  }) => (
    <div>
      {`overlay:${label}:${title ?? ""}:${iconKind ?? ""}:${toneClass ?? ""}:${String(
        isOverlay,
      )}:${width ?? "null"}`}
    </div>
  ),
}));

function makeTab(id: string, position: number): TerminalTab {
  return {
    id,
    label: `Tab ${id.toUpperCase()}`,
    position,
    worktree_id: "w1",
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
    capturedDndHandlers.onDragStart = undefined;
    capturedDndHandlers.onDragEnd = undefined;
    capturedDndHandlers.onDragCancel = undefined;
  });

  it("shows the drag overlay on drag start", () => {
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
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    act(() => {
      capturedDndHandlers.onDragStart?.({
        active: {
          id: "b",
          rect: { current: { initial: { width: 321 } } },
        },
      });
    });

    expect(screen.getByRole("tablist")).toHaveAttribute(
      "data-tab-dragging",
      "true",
    );
    expect(
      screen.getByText(
        "overlay:Tab B!:Tab B title:terminal:text-amber-500:true:321",
      ),
    ).toBeInTheDocument();
  });

  it("reorders tabs on drag end and clears the overlay", () => {
    const onReorder = vi.fn().mockResolvedValue(undefined);

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
        onReorder={onReorder}
      />,
    );

    act(() => {
      capturedDndHandlers.onDragStart?.({
        active: {
          id: "b",
          rect: { current: { initial: { width: 321 } } },
        },
      });
    });

    act(() => {
      capturedDndHandlers.onDragEnd?.({
        active: { id: "b" },
        over: { id: "a" },
      });
    });

    expect(onReorder).toHaveBeenCalledWith(["b", "a"]);
    expect(
      screen.queryByText(
        "overlay:Tab B!:Tab B title:terminal:text-amber-500:true:321",
      ),
    ).not.toBeInTheDocument();
  });

  it("clears the overlay on drag cancel", () => {
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
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    act(() => {
      capturedDndHandlers.onDragStart?.({
        active: {
          id: "b",
          rect: { current: { initial: { width: 321 } } },
        },
      });
    });

    act(() => {
      capturedDndHandlers.onDragCancel?.();
    });

    expect(screen.getByRole("tablist")).not.toHaveAttribute(
      "data-tab-dragging",
      "true",
    );
    expect(
      screen.queryByText(
        "overlay:Tab B!:Tab B title:terminal:text-amber-500:true:321",
      ),
    ).not.toBeInTheDocument();
  });
});
