// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { createRef, type PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@/lib/types";
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

vi.mock("./SortableTab", () => ({
  default: ({ label }: { label: string }) => <div>{label}</div>,
}));

vi.mock("./SortableTabView", () => ({
  default: ({
    label,
    isOverlay,
    width,
  }: {
    label: string;
    isOverlay?: boolean;
    width?: number | null;
  }) => <div>{`overlay:${label}:${String(isOverlay)}:${width ?? "null"}`}</div>,
}));

function makeTab(id: string, position: number): Tab {
  return {
    id,
    label: `Tab ${id.toUpperCase()}`,
    position,
    worktree_id: "w1",
    session_id: "default",
    type: "terminal",
    created_at: 0,
  };
}

describe("SortableTabStrip", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    capturedDndHandlers.onDragStart = undefined;
    capturedDndHandlers.onDragEnd = undefined;
    capturedDndHandlers.onDragCancel = undefined;
  });

  it("shows the drag overlay on drag start", () => {
    render(
      <SortableTabStrip
        tabs={[makeTab("a", 1), makeTab("b", 2)]}
        activeTabId="a"
        tabListRef={createRef<HTMLDivElement>()}
        onScroll={vi.fn()}
        onActivate={vi.fn()}
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
    expect(screen.getByText("overlay:Tab B:true:321")).toBeInTheDocument();
  });

  it("reorders tabs on drag end and clears the overlay", () => {
    const onReorder = vi.fn().mockResolvedValue(undefined);

    render(
      <SortableTabStrip
        tabs={[makeTab("a", 1), makeTab("b", 2)]}
        activeTabId="a"
        tabListRef={createRef<HTMLDivElement>()}
        onScroll={vi.fn()}
        onActivate={vi.fn()}
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
      screen.queryByText("overlay:Tab B:true:321"),
    ).not.toBeInTheDocument();
  });

  it("clears the overlay on drag cancel", () => {
    render(
      <SortableTabStrip
        tabs={[makeTab("a", 1), makeTab("b", 2)]}
        activeTabId="a"
        tabListRef={createRef<HTMLDivElement>()}
        onScroll={vi.fn()}
        onActivate={vi.fn()}
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
      screen.queryByText("overlay:Tab B:true:321"),
    ).not.toBeInTheDocument();
  });
});
