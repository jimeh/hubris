import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TabBar from "@/components/TabBar";
import type { Tab } from "$lib/types";

let resizeCallback: ResizeObserverCallback | null = null;

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }

  observe() {}

  unobserve() {}

  disconnect() {}
}

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
    window.ResizeObserver = ResizeObserverMock;
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    };
    window.cancelAnimationFrame = vi.fn();
  });

  it("renders the active tab style and keeps close separate from activate", () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();

    render(
      <TabBar
        worktreeId="w1"
        tabs={[makeTab("a", 1), makeTab("b", 2)]}
        activeTabId="a"
        onActivate={onActivate}
        onClose={onClose}
        onAdd={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const activeTab = screen.getByRole("tab", { selected: true });
    expect(activeTab).toHaveClass("bg-tab-active");
    expect(activeTab).toHaveClass(
      "shadow-[inset_0_-2px_0_var(--tab-active-border)]",
    );

    fireEvent.click(screen.getByText("Tab B"));
    expect(onActivate).toHaveBeenCalledWith("b");

    fireEvent.click(screen.getByRole("button", { name: "Close Tab B" }));
    expect(onClose).toHaveBeenCalledWith("b");
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("shows overflow chevrons and scrolls the tab strip", () => {
    render(
      <TabBar
        worktreeId="w1"
        tabs={[makeTab("a", 1), makeTab("b", 2), makeTab("c", 3)]}
        activeTabId="a"
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onAdd={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
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
    const props = {
      worktreeId: "w1",
      activeTabId: "a",
      onActivate: vi.fn(),
      onClose: vi.fn(),
      onAdd: vi.fn(),
      onReorder: vi.fn().mockResolvedValue(undefined),
    };

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
      <TabBar
        worktreeId="w1"
        tabs={[makeTab("a", 1)]}
        activeTabId="a"
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onAdd={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const tabList = screen.getByRole("tablist");
    setScrollMetrics(tabList, {
      clientWidth: 120,
      scrollWidth: 420,
    });

    rerender(
      <TabBar
        worktreeId="w1"
        tabs={[makeTab("a", 1), makeTab("b", 2)]}
        activeTabId="a"
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onAdd={vi.fn()}
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    unmount();

    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(77);
  });
});
