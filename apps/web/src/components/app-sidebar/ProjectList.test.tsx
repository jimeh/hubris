// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/lib/types";
import ProjectList from "./ProjectList";

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
  }: React.PropsWithChildren<CapturedDndHandlers>) => {
    capturedDndHandlers.onDragStart = onDragStart;
    capturedDndHandlers.onDragEnd = onDragEnd;
    capturedDndHandlers.onDragCancel = onDragCancel;
    return <>{children}</>;
  },
  DragOverlay: ({ children }: React.PropsWithChildren) => <>{children}</>,
  PointerSensor: class PointerSensor {},
  closestCenter: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: React.PropsWithChildren) => <>{children}</>,
  verticalListSortingStrategy: vi.fn(),
  arrayMove: <T,>(items: T[], oldIndex: number, newIndex: number) => {
    const next = [...items];
    const [moved] = next.splice(oldIndex, 1);
    next.splice(newIndex, 0, moved);
    return next;
  },
}));

vi.mock("./ProjectRow", () => ({
  default: ({
    project,
    isSorting,
    dragLock,
    suppressAnimations,
    onToggleExpand,
  }: {
    project: Project;
    isSorting: boolean;
    dragLock: boolean;
    suppressAnimations: boolean;
    onToggleExpand: () => void;
  }) => (
    <div data-testid={`row-${project.id}`}>
      <span>{project.name}</span>
      <span>{`sorting:${String(isSorting)}`}</span>
      <span>{`drag-lock:${String(dragLock)}`}</span>
      <span>{`suppressed:${String(suppressAnimations)}`}</span>
      <button
        type="button"
        onClick={() => {
          if (!dragLock) {
            onToggleExpand();
          }
        }}
      >
        {`toggle-${project.id}`}
      </button>
    </div>
  ),
}));

vi.mock("./ProjectDragOverlay", () => ({
  default: ({ project, width }: { project: Project; width: number | null }) => (
    <div>{`overlay:${project.name}:${width ?? "null"}`}</div>
  ),
}));

function makeProject(id: string, name: string, position: number): Project {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    position,
  };
}

function renderProjectList(
  overrides: Partial<React.ComponentProps<typeof ProjectList>> = {},
) {
  const defaultProjects = [
    makeProject("p1", "Devbox", 1),
    makeProject("p2", "760-grid-system", 2),
  ];

  return render(
    <ProjectList
      projects={defaultProjects}
      expandedById={{ p1: true, p2: true }}
      selectedWorktreeId={null}
      worktreesByProject={{ p1: [], p2: [] }}
      projectErrors={{}}
      onReorderProjects={vi.fn()}
      onToggleExpand={vi.fn()}
      onSelectWorktree={vi.fn()}
      onAddWorktree={vi.fn()}
      onRenameProject={vi.fn()}
      onRemoveProject={vi.fn()}
      onRenameWorktree={vi.fn()}
      onRemoveWorktree={vi.fn()}
      onReorderWorktrees={vi.fn()}
      {...overrides}
    />,
  );
}

describe("ProjectList", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    capturedDndHandlers.onDragStart = undefined;
    capturedDndHandlers.onDragEnd = undefined;
    capturedDndHandlers.onDragCancel = undefined;
  });

  it("sets sorting state and shows the overlay on drag start", () => {
    renderProjectList();

    act(() => {
      capturedDndHandlers.onDragStart?.({
        active: {
          id: "p1",
          rect: { current: { initial: { width: 321 } } },
        },
      });
    });

    expect(screen.getByText("overlay:Devbox:321")).toBeInTheDocument();
    expect(screen.getAllByText("sorting:true")).toHaveLength(2);
  });

  it("reorders projects on drag end and clears the overlay", () => {
    const onReorderProjects = vi.fn();
    renderProjectList({ onReorderProjects });

    act(() => {
      capturedDndHandlers.onDragStart?.({
        active: {
          id: "p1",
          rect: { current: { initial: { width: 321 } } },
        },
      });
    });

    act(() => {
      capturedDndHandlers.onDragEnd?.({
        active: { id: "p1" },
        over: { id: "p2" },
      });
    });

    expect(onReorderProjects).toHaveBeenCalledWith(["p2", "p1"]);
    expect(screen.queryByText("overlay:Devbox:321")).not.toBeInTheDocument();
  });

  it("clears drag state on drag cancel", () => {
    renderProjectList();

    act(() => {
      capturedDndHandlers.onDragStart?.({
        active: {
          id: "p1",
          rect: { current: { initial: { width: 321 } } },
        },
      });
    });

    act(() => {
      capturedDndHandlers.onDragCancel?.();
    });

    expect(screen.queryByText("overlay:Devbox:321")).not.toBeInTheDocument();
    expect(screen.getAllByText("sorting:false")).toHaveLength(2);
  });

  it("ignores expand toggles while the drag lock is active", () => {
    const onToggleExpand = vi.fn();
    renderProjectList({ onToggleExpand });

    act(() => {
      capturedDndHandlers.onDragStart?.({
        active: {
          id: "p1",
          rect: { current: { initial: { width: 321 } } },
        },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "toggle-p1" }));

    expect(onToggleExpand).not.toHaveBeenCalled();
  });

  it("keeps suppression after drop until that project is intentionally toggled", () => {
    const onToggleExpand = vi.fn();
    renderProjectList({ onToggleExpand });

    act(() => {
      capturedDndHandlers.onDragStart?.({
        active: {
          id: "p1",
          rect: { current: { initial: { width: 321 } } },
        },
      });
    });

    act(() => {
      capturedDndHandlers.onDragEnd?.({
        active: { id: "p1" },
        over: { id: "p1" },
      });
    });

    expect(screen.getAllByText("suppressed:true")).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(180);
    });

    fireEvent.click(screen.getByRole("button", { name: "toggle-p1" }));

    expect(onToggleExpand).toHaveBeenCalledWith("p1");
    expect(screen.getByTestId("row-p1")).toHaveTextContent("suppressed:false");
    expect(screen.getByTestId("row-p2")).toHaveTextContent("suppressed:true");
  });
});
