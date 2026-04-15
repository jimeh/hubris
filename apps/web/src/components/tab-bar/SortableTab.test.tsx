// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import React, { type PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SortableTab from "./SortableTab";

let mockIsDragging = false;

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: mockIsDragging,
  }),
}));

vi.mock("./SortableTabView", () => ({
  default: React.forwardRef<
    HTMLDivElement,
    React.ComponentPropsWithoutRef<"div"> & { label: string }
  >(function SortableTabViewMock({ label, ...props }, ref) {
    return (
      <div ref={ref} {...props}>
        {label}
      </div>
    );
  }),
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
    disabled,
    onSelect,
  }: PropsWithChildren<{
    disabled?: boolean;
    onSelect?: () => void;
  }>) {
    const context = React.useContext(ContextMenuState);
    return (
      <button
        type="button"
        disabled={disabled}
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

describe("SortableTab", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockIsDragging = false;
  });

  it("opens the terminal context menu and starts rename", () => {
    const onBeginRenameTerminal = vi.fn();

    render(
      <SortableTab
        tabId="t1"
        label="Terminal 1"
        isActive={false}
        preview={false}
        dirty={false}
        notification={false}
        locked={false}
        dragging={false}
        canRenameTerminal
        canResetTerminalName
        onBeginRenameTerminal={onBeginRenameTerminal}
        onResetTerminalName={vi.fn()}
        onActivateTab={vi.fn()}
        onPinTab={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Terminal 1"));
    fireEvent.click(screen.getByRole("button", { name: "Rename…" }));

    expect(onBeginRenameTerminal).toHaveBeenCalledWith("t1");
  });

  it("resets a custom terminal name from the context menu", () => {
    const onResetTerminalName = vi.fn();

    render(
      <SortableTab
        tabId="t1"
        label="Deploy"
        isActive={false}
        preview={false}
        dirty={false}
        notification={false}
        locked={false}
        dragging={false}
        canRenameTerminal
        canResetTerminalName
        onBeginRenameTerminal={vi.fn()}
        onResetTerminalName={onResetTerminalName}
        onActivateTab={vi.fn()}
        onPinTab={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Deploy"));
    fireEvent.click(screen.getByRole("button", { name: "Reset Name" }));

    expect(onResetTerminalName).toHaveBeenCalledWith("t1");
  });

  it("keeps the dragged tab in layout but makes it invisible", () => {
    mockIsDragging = true;

    render(
      <SortableTab
        tabId="t1"
        label="Terminal 1"
        isActive={false}
        preview={false}
        dirty={false}
        notification={false}
        locked={false}
        dragging={true}
        onActivateTab={vi.fn()}
        onPinTab={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    );

    const draggedTab = screen.getByText("Terminal 1");
    expect(draggedTab).toHaveStyle({ visibility: "hidden" });
    expect(draggedTab).toHaveStyle({ pointerEvents: "none" });
  });
});
