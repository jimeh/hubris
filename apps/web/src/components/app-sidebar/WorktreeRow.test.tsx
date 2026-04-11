// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import React, { type PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Worktree } from "@/lib/types";
import WorktreeList from "./WorktreeList";
import WorktreeRow from "./WorktreeRow";

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DragOverlay: ({ children }: React.PropsWithChildren) => <>{children}</>,
  PointerSensor: class PointerSensor {},
  closestCenter: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
  SortableContext: ({ children }: React.PropsWithChildren) => <>{children}</>,
  rectSortingStrategy: vi.fn(),
  arrayMove: <T,>(items: T[], oldIndex: number, newIndex: number) => {
    const next = [...items];
    const [moved] = next.splice(oldIndex, 1);
    next.splice(newIndex, 0, moved);
    return next;
  },
}));

vi.mock("@/components/ui/context-menu", async () => {
  const React = await import("react");

  type ContextMenuValue = {
    open: boolean;
    setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  };

  const ContextMenuState = React.createContext<ContextMenuValue | null>(null);

  function mergeHandler<E>(
    first: ((event: E) => void) | undefined,
    second: ((event: E) => void) | undefined,
  ) {
    return (event: E) => {
      first?.(event);
      second?.(event);
    };
  }

  function ContextMenu({ children }: { children: React.ReactNode }) {
    const [open, setOpen] = React.useState(false);
    return (
      <ContextMenuState.Provider value={{ open, setOpen }}>
        {children}
      </ContextMenuState.Provider>
    );
  }

  function ContextMenuTrigger({
    asChild,
    children,
  }: PropsWithChildren<{ asChild?: boolean }>) {
    const context = React.useContext(ContextMenuState);
    if (!context) {
      return <>{children}</>;
    }

    const openMenu = (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      context.setOpen(true);
    };

    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<{
        onContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
      }>;
      return React.cloneElement(child, {
        onContextMenu: mergeHandler(child.props.onContextMenu, openMenu),
      });
    }

    return <div onContextMenu={openMenu}>{children}</div>;
  }

  function ContextMenuContent({ children }: PropsWithChildren) {
    const context = React.useContext(ContextMenuState);
    if (!context?.open) {
      return null;
    }
    return <div>{children}</div>;
  }

  function ContextMenuItem({
    children,
    onSelect,
  }: PropsWithChildren<{ onSelect?: () => void }>) {
    const context = React.useContext(ContextMenuState);
    return (
      <button
        type="button"
        onClick={() => {
          onSelect?.();
          context?.setOpen(false);
        }}
      >
        {children}
      </button>
    );
  }

  return {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
  };
});

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: overrides.id ?? "w1",
    project_id: overrides.project_id ?? "p1",
    path: overrides.path ?? "/tmp/feature-a",
    branch: overrides.branch ?? "feature-a",
    source_ref: overrides.source_ref ?? null,
    ui_mode: overrides.ui_mode ?? "hubris",
    name: overrides.name ?? "feature-a",
    position: overrides.position ?? 1,
    is_local: overrides.is_local ?? false,
    missing_on_disk: overrides.missing_on_disk ?? false,
    is_imported: overrides.is_imported,
  };
}

function renderWorktreeRow(
  overrides: Partial<React.ComponentProps<typeof WorktreeRow>> = {},
) {
  return render(
    <TooltipProvider>
      <WorktreeRow
        worktree={makeWorktree()}
        isSelected={false}
        isSorting={false}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onRemove={vi.fn()}
        {...overrides}
      />
    </TooltipProvider>,
  );
}

describe("WorktreeRow", () => {
  it("opens worktree actions on right click and runs rename", () => {
    const onRename = vi.fn();

    renderWorktreeRow({ onRename });

    fireEvent.contextMenu(screen.getByRole("button", { name: "feature-a" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("keeps left click behavior for selection and does not open the menu", () => {
    const onSelect = vi.fn();

    renderWorktreeRow({ onSelect });

    fireEvent.click(screen.getByRole("button", { name: "feature-a" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Rename" }),
    ).not.toBeInTheDocument();
  });

  it("opens the worktree menu from the keyboard context menu key", () => {
    renderWorktreeRow();

    fireEvent.keyDown(screen.getByRole("button", { name: "feature-a" }), {
      key: "ContextMenu",
    });

    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("does not expose a context menu for the local worktree row", () => {
    render(
      <TooltipProvider>
        <WorktreeList
          localWorktree={makeWorktree({
            id: "local",
            name: "local",
            is_local: true,
          })}
          worktrees={[]}
          projectError={null}
          selectedWorktreeId={null}
          onSelectWorktree={vi.fn()}
          onRenameWorktree={vi.fn()}
          onRemoveWorktree={vi.fn()}
          onReorder={vi.fn()}
        />
      </TooltipProvider>,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "local" }));

    expect(
      screen.queryByRole("button", { name: "Rename" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
  });
});
