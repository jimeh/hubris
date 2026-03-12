// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMobile } from "@/test/mobile";
import type { Tab, Worktree } from "@/lib/types";

const terminalRenderSpy = vi.fn<(tabId: string) => void>();

vi.mock("@/components/TabBar", () => ({
  default: () => null,
}));

vi.mock("@/components/WorktreeGitStatusPanel", () => ({
  default: () => <div>Git panel</div>,
}));

vi.mock("@/components/TerminalTab", async () => {
  const { memo } = await vi.importActual<typeof import("react")>("react");

  return {
    default: memo(function MockTerminalTab({
      tabId,
      visible,
    }: {
      tabId: string;
      visible: boolean;
      onClosed?: (tabId: string) => void;
    }) {
      terminalRenderSpy(tabId);
      return <div data-tab-id={tabId} data-visible={visible} />;
    }),
  };
});

function getTerminalRenderCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [tabId] of terminalRenderSpy.mock.calls) {
    counts[tabId] = (counts[tabId] ?? 0) + 1;
  }
  return counts;
}

function makeWorktree(): Worktree {
  return {
    id: "w1",
    project_id: "p1",
    name: "local",
    path: "/tmp/devbox",
    branch: "main",
    source_ref: null,
    is_local: true,
    missing_on_disk: false,
    position: 1,
  };
}

function makeTab(
  id: string,
  worktreeId: string,
  overrides: Partial<Tab> = {},
): Tab {
  return {
    id,
    label: `Tab ${id.toUpperCase()}`,
    position: overrides.position ?? 1,
    worktree_id: worktreeId,
    session_id: overrides.session_id ?? "default",
    type: overrides.type ?? "terminal",
    created_at: overrides.created_at ?? 0,
  };
}

describe("WorktreeView", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    terminalRenderSpy.mockClear();
    localStorage.clear();
    setMobile(false);

    const { resetTabStoreForTests, useTabStore } =
      await import("@/lib/stores/tabs");
    const { resetWorktreeRightSidebarStoreForTests } =
      await import("@/lib/stores/worktreeRightSidebar");
    const { resetWorktreeRightSidebarWidthStoreForTests } =
      await import("@/lib/stores/worktreeRightSidebarWidth");
    resetTabStoreForTests();
    resetWorktreeRightSidebarStoreForTests();
    resetWorktreeRightSidebarWidthStoreForTests();
    useTabStore.setState({
      tabs: [],
      activeTabId: null,
      activeTabByWorktree: {},
    });
  });

  it("does not rerender terminal tabs when sibling tabs are added", async () => {
    const { useTabStore } = await import("@/lib/stores/tabs");
    const { default: WorktreeView } = await import("./WorktreeView");
    const worktree = makeWorktree();

    useTabStore.setState({
      tabs: [
        makeTab("a", worktree.id, { position: 1 }),
        makeTab("b", worktree.id, { position: 2 }),
      ],
      activeTabId: "a",
      activeTabByWorktree: { [worktree.id]: "a" },
    });

    render(<WorktreeView worktree={worktree} />);

    expect(getTerminalRenderCounts()).toEqual({ a: 1, b: 1 });

    act(() => {
      useTabStore.setState((state) => ({
        tabs: [...state.tabs, makeTab("c", worktree.id, { position: 3 })],
      }));
    });

    expect(getTerminalRenderCounts()).toEqual({ a: 1, b: 1, c: 1 });
  });

  it("does not rerender when tabs change in another worktree", async () => {
    const { useTabStore } = await import("@/lib/stores/tabs");
    const { default: WorktreeView } = await import("./WorktreeView");
    const worktree = makeWorktree();

    useTabStore.setState({
      tabs: [
        makeTab("a", worktree.id, { position: 1 }),
        makeTab("x", "w2", { position: 1 }),
      ],
      activeTabId: "a",
      activeTabByWorktree: { [worktree.id]: "a", w2: "x" },
    });

    render(<WorktreeView worktree={worktree} />);

    expect(getTerminalRenderCounts()).toEqual({ a: 1 });

    act(() => {
      useTabStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "x" ? { ...tab, label: "Renamed X" } : tab,
        ),
      }));
    });

    expect(getTerminalRenderCounts()).toEqual({ a: 1 });
  });

  it("updates right sidebar width without rerendering terminal tabs", async () => {
    const { default: WorktreeView } = await import("./WorktreeView");
    const worktree = makeWorktree();
    const { useTabStore } = await import("@/lib/stores/tabs");
    const { useWorktreeRightSidebarStore } =
      await import("@/lib/stores/worktreeRightSidebar");
    const { useWorktreeRightSidebarWidthStore } =
      await import("@/lib/stores/worktreeRightSidebarWidth");

    useTabStore.setState({
      tabs: [makeTab("a", worktree.id, { position: 1 })],
      activeTabId: "a",
      activeTabByWorktree: { [worktree.id]: "a" },
    });

    render(<WorktreeView worktree={worktree} />);
    expect(getTerminalRenderCounts()).toEqual({ a: 1 });
    expect(screen.getByText("Git panel")).toBeInTheDocument();

    const viewRoot = document.querySelector<HTMLElement>(
      "[data-worktree-view]",
    );
    expect(
      viewRoot?.style.getPropertyValue("--worktree-right-sidebar-width"),
    ).toBe("320px");

    const host = document.querySelector<HTMLElement>(
      "[data-worktree-right-sidebar-wrapper]",
    );
    expect(host).not.toBeNull();
    expect(host?.style.getPropertyValue("--worktree-right-sidebar-width")).toBe(
      "320px",
    );

    act(() => {
      useWorktreeRightSidebarWidthStore.getState().setWidth(412);
    });

    expect(host?.style.getPropertyValue("--worktree-right-sidebar-width")).toBe(
      "412px",
    );
    expect(getTerminalRenderCounts()).toEqual({ a: 1 });

    fireEvent.keyDown(
      await screen.findByRole("button", { name: "Resize right sidebar" }),
      { key: "ArrowLeft" },
    );

    expect(host?.style.getPropertyValue("--worktree-right-sidebar-width")).toBe(
      "428px",
    );
    expect(getTerminalRenderCounts()).toEqual({ a: 1 });

    act(() => {
      useWorktreeRightSidebarStore.getState().toggleDesktop();
    });
    expect(screen.getByText("Git panel")).toBeInTheDocument();
    expect(getTerminalRenderCounts()).toEqual({ a: 1 });

    act(() => {
      useWorktreeRightSidebarStore.getState().toggleDesktop();
    });

    expect(host?.style.getPropertyValue("--worktree-right-sidebar-width")).toBe(
      "428px",
    );
    expect(getTerminalRenderCounts()).toEqual({ a: 1 });
  });
});
