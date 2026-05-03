import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act, useCallback, useState } from "react";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TabBar, { SortableTabView } from "@/components/TabBar";
import type { TerminalTab } from "@/lib/types";

const useDroppableMock = vi.fn();
let resizeCallback: ResizeObserverCallback | null = null;

vi.mock("@dnd-kit/core", () => ({
  useDroppable: (...args: unknown[]) => useDroppableMock(...args),
}));

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }

  observe() {}

  unobserve() {}

  disconnect() {}
}

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

function baseProps() {
  return {
    worktreeId: "w1",
    activeTabId: "a",
    onActivate: vi.fn(),
    onPin: vi.fn(),
    onClose: vi.fn(),
    onAddTerminal: vi.fn(),
    onAddBrowser: vi.fn().mockResolvedValue(undefined),
    onAddChat: vi.fn().mockResolvedValue(undefined),
    onSplitRight: vi.fn(),
    onSplitDown: vi.fn(),
    onReorder: vi.fn().mockResolvedValue(undefined),
  };
}

function setScrollMetrics(
  node: HTMLElement,
  {
    clientWidth,
    scrollWidth,
    scrollLeft = 0,
    scrollBy = vi.fn(),
    scrollTo = vi.fn(),
  }: {
    clientWidth: number;
    scrollWidth: number;
    scrollLeft?: number;
    scrollBy?: ReturnType<typeof vi.fn>;
    scrollTo?: ReturnType<typeof vi.fn>;
  },
) {
  let currentScrollLeft = scrollLeft;

  Object.defineProperties(node, {
    clientWidth: {
      configurable: true,
      get: () => clientWidth,
    },
    scrollWidth: {
      configurable: true,
      get: () => scrollWidth,
    },
    scrollLeft: {
      configurable: true,
      get: () => currentScrollLeft,
      set: (value: number) => {
        currentScrollLeft = value;
      },
    },
    scrollBy: {
      configurable: true,
      value: scrollBy,
    },
    scrollTo: {
      configurable: true,
      value: scrollTo,
    },
  });

  return { scrollBy, scrollTo };
}

function triggerResize(target: Element): void {
  if (!resizeCallback) {
    throw new Error("ResizeObserver callback not registered");
  }

  act(() => {
    resizeCallback?.([{ target } as ResizeObserverEntry], {} as ResizeObserver);
  });
}

describe("TabBar", () => {
  beforeEach(() => {
    resizeCallback = null;
    vi.restoreAllMocks();
    useDroppableMock.mockReturnValue({
      isOver: false,
      setNodeRef: vi.fn(),
    });
    window.ResizeObserver = ResizeObserverMock;
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    };
    window.cancelAnimationFrame = vi.fn();
  });

  it("renders the active tab style and keeps close separate from activate", () => {
    const props = baseProps();

    render(<TabBar {...props} tabs={[makeTab("a", 1), makeTab("b", 2)]} />);

    const activeTab = screen.getByRole("tab", { selected: true });
    expect(activeTab).toHaveClass("bg-tab-active");
    expect(activeTab).toHaveClass(
      "shadow-[inset_0_-2px_0_var(--tab-active-border)]",
    );

    fireEvent.click(screen.getByText("Tab B"));
    expect(props.onActivate).toHaveBeenCalledWith("b");

    fireEvent.click(screen.getByRole("button", { name: "Close Tab B" }));
    expect(props.onClose).toHaveBeenCalledWith("b");
    expect(props.onActivate).toHaveBeenCalledTimes(1);
  });

  it("shows overflow chevrons and scrolls the tab strip", () => {
    const props = baseProps();

    render(
      <TabBar
        {...props}
        tabs={[makeTab("a", 1), makeTab("b", 2), makeTab("c", 3)]}
      />,
    );

    const tabList = screen.getByRole("tablist");
    const { scrollBy } = setScrollMetrics(tabList, {
      clientWidth: 120,
      scrollWidth: 360,
    });

    triggerResize(tabList);

    fireEvent.click(screen.getByRole("button", { name: "Scroll tabs right" }));
    expect(scrollBy).toHaveBeenCalledWith({
      left: 200,
      behavior: "smooth",
    });
  });

  it("auto-scrolls to the end when a tab is added", () => {
    const props = baseProps();

    const { rerender } = render(<TabBar {...props} tabs={[makeTab("a", 1)]} />);

    const tabList = screen.getByRole("tablist");
    const { scrollTo } = setScrollMetrics(tabList, {
      clientWidth: 120,
      scrollWidth: 420,
    });

    rerender(<TabBar {...props} tabs={[makeTab("a", 1), makeTab("b", 2)]} />);

    expect(scrollTo).toHaveBeenCalledWith({
      left: 420,
      behavior: "smooth",
    });
  });

  it("cancels queued auto-scroll frames on cleanup", () => {
    window.requestAnimationFrame = vi.fn(() => 77);

    const { rerender, unmount } = render(
      <TabBar {...baseProps()} tabs={[makeTab("a", 1)]} />,
    );

    const tabList = screen.getByRole("tablist");
    setScrollMetrics(tabList, {
      clientWidth: 120,
      scrollWidth: 420,
    });

    rerender(
      <TabBar {...baseProps()} tabs={[makeTab("a", 1), makeTab("b", 2)]} />,
    );

    unmount();

    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(77);
  });

  it("renders dedicated create buttons for terminal and browser tabs", async () => {
    const props = baseProps();

    render(<TabBar {...props} tabs={[makeTab("a", 1)]} />);

    fireEvent.click(screen.getByRole("button", { name: "Split Vertically" }));
    expect(props.onSplitRight).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Split Horizontally" }));
    expect(props.onSplitDown).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "New Terminal" }));
    expect(props.onAddTerminal).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "New Browser" }));

    await waitFor(() => {
      expect(props.onAddBrowser).toHaveBeenCalledWith();
    });
  });

  it("renders contributed active-tab actions before pane controls", () => {
    const props = baseProps();
    const onPreviousChange = vi.fn();
    const onNextChange = vi.fn();

    render(
      <TabBar
        {...props}
        tabs={[makeTab("a", 1)]}
        activeTabActions={[
          {
            id: "previous-change",
            icon: ChevronsLeft,
            label: "Previous Change",
            onClick: onPreviousChange,
          },
          {
            id: "next-change",
            icon: ChevronsRight,
            label: "Next Change",
            onClick: onNextChange,
          },
        ]}
      />,
    );

    const actions = screen.getByTestId("tab-bar-pane-1-actions");
    const buttons = actions.querySelectorAll("button");

    expect(buttons[0]).toHaveAttribute("aria-label", "Previous Change");
    expect(buttons[1]).toHaveAttribute("aria-label", "Next Change");
    expect(buttons[2]).toHaveAttribute("aria-label", "Split Vertically");
    expect(buttons[3]).toHaveAttribute("aria-label", "Split Horizontally");
    expect(buttons[4]).toHaveAttribute("aria-label", "New Browser");
    expect(buttons[5]).toHaveAttribute("aria-label", "New Chat");
    expect(buttons[6]).toHaveAttribute("aria-label", "New Terminal");

    fireEvent.click(screen.getByRole("button", { name: "Previous Change" }));
    fireEvent.click(screen.getByRole("button", { name: "Next Change" }));
    fireEvent.click(screen.getByRole("button", { name: "New Chat" }));

    expect(onPreviousChange).toHaveBeenCalledTimes(1);
    expect(onNextChange).toHaveBeenCalledTimes(1);
    expect(props.onAddChat).toHaveBeenCalledTimes(1);
  });

  it("renders the extra divider only when active-tab actions exist", () => {
    const props = baseProps();
    const { rerender } = render(<TabBar {...props} tabs={[makeTab("a", 1)]} />);

    expect(
      screen.queryByTestId("tab-bar-pane-1-divider"),
    ).not.toBeInTheDocument();

    rerender(
      <TabBar
        {...props}
        tabs={[makeTab("a", 1)]}
        activeTabActions={[
          {
            id: "previous-change",
            icon: ChevronsLeft,
            label: "Previous Change",
            onClick: vi.fn(),
          },
        ]}
      />,
    );

    expect(screen.getAllByTestId("tab-bar-pane-1-divider")).toHaveLength(1);
  });

  it("registers the pane tab bar as a drop target during drag", () => {
    useDroppableMock.mockReturnValue({
      isOver: true,
      setNodeRef: vi.fn(),
    });

    render(<TabBar {...baseProps()} tabs={[makeTab("a", 1)]} dragging />);

    expect(useDroppableMock).toHaveBeenCalledWith({
      id: "pane-tab-bar:pane-1",
      disabled: false,
    });
  });

  it("mutes the active tab styling in unfocused panes", () => {
    render(
      <TabBar
        {...baseProps()}
        tabs={[makeTab("a", 1), makeTab("b", 2)]}
        paneFocused={false}
      />,
    );

    const activeTab = screen.getByRole("tab", { selected: true });
    expect(activeTab).not.toHaveClass("bg-tab-bar");
    expect(activeTab).toHaveClass(
      "shadow-[inset_0_-2px_0_color-mix(in_srgb,_var(--tab-active-border)_55%,_transparent)]",
    );
    expect(activeTab).not.toHaveClass("bg-tab-active");
  });

  it("does not rerender a tab view when its props stay stable", () => {
    const renderSpy = vi.spyOn(
      (SortableTabView as unknown as { type: { render: () => unknown } }).type,
      "render",
    );

    function Harness() {
      const [count, setCount] = useState(0);
      const handleActivateTab = useCallback((_tabId: string) => {}, []);
      const handleCloseTab = useCallback((_tabId: string) => {}, []);

      return (
        <>
          <button onClick={() => setCount((value) => value + 1)} type="button">
            bump
          </button>
          <span>{count}</span>
          <SortableTabView
            tabId="a"
            label="Tab A"
            isActive={false}
            dragging={false}
            onActivateTab={handleActivateTab}
            onCloseTab={handleCloseTab}
          />
        </>
      );
    }

    render(<Harness />);

    expect(renderSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "bump" }));

    expect(renderSpy).toHaveBeenCalledTimes(1);
  });
});
