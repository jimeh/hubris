// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import React, { type PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Project } from "@/lib/types";
import ProjectRow from "./ProjectRow";

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

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DragOverlay: ({ children }: React.PropsWithChildren) => <>{children}</>,
  PointerSensor: class PointerSensor {},
  closestCenter: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
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

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? "p1",
    name: overrides.name ?? "Devbox",
    path: overrides.path ?? "/tmp/devbox",
    position: overrides.position ?? 1,
  };
}

function renderProjectRow(
  overrides: Partial<React.ComponentProps<typeof ProjectRow>> = {},
) {
  return render(
    <SidebarProvider defaultOpen>
      <TooltipProvider>
        <ProjectRow
          project={makeProject()}
          isExpanded
          selectedWorktreeId={null}
          projectError={null}
          worktrees={[]}
          isSorting={false}
          dragLock={false}
          suppressAnimations={false}
          onToggleExpand={vi.fn()}
          onSelectWorktree={vi.fn()}
          onAddWorktree={vi.fn()}
          onRenameProject={vi.fn()}
          onRemoveProject={vi.fn()}
          onRenameWorktree={vi.fn()}
          onRemoveWorktree={vi.fn()}
          onReorderWorktrees={vi.fn()}
          {...overrides}
        />
      </TooltipProvider>
    </SidebarProvider>,
  );
}

describe("ProjectRow", () => {
  it("opens project actions on right click and runs rename", () => {
    const onRenameProject = vi.fn();

    renderProjectRow({ onRenameProject });

    fireEvent.contextMenu(screen.getByRole("button", { name: "Devbox" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    expect(onRenameProject).toHaveBeenCalledTimes(1);
  });

  it("keeps left click behavior for expand and does not open the menu", () => {
    const onToggleExpand = vi.fn();

    renderProjectRow({ onToggleExpand });

    fireEvent.click(screen.getByRole("button", { name: "Devbox" }));

    expect(onToggleExpand).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Rename" }),
    ).not.toBeInTheDocument();
  });

  it("opens the project menu from the keyboard context menu shortcut", () => {
    renderProjectRow();

    fireEvent.keyDown(screen.getByRole("button", { name: "Devbox" }), {
      key: "F10",
      shiftKey: true,
    });

    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("keeps the new worktree button working without opening the menu", () => {
    const onAddWorktree = vi.fn();

    renderProjectRow({ onAddWorktree });

    fireEvent.click(screen.getByRole("button", { name: "New worktree" }));

    expect(onAddWorktree).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Rename" }),
    ).not.toBeInTheDocument();
  });
});
