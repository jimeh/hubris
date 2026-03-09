// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab, Worktree } from "@/lib/types";

const terminalRenderSpy = vi.fn<(tabId: string) => void>();
const mockGetProjectWorktreeGitStatus = vi.fn();

vi.mock("@/components/TabBar", () => ({
  default: () => null,
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getProjectWorktreeGitStatus: (...args: unknown[]) =>
      mockGetProjectWorktreeGitStatus(...args),
  };
});

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

function setMobile(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation(() => ({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
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
    mockGetProjectWorktreeGitStatus.mockReset();
    mockGetProjectWorktreeGitStatus.mockResolvedValue({
      source_ref: "main",
      unstaged_files: [],
      staged_files: [],
      ahead_count: 0,
      ahead_commits: [],
      comparison_available: true,
      comparison_error: null,
    });

    const { resetTabStoreForTests, useTabStore } =
      await import("@/lib/stores/tabs");
    const { resetWorktreeGitSidebarStoreForTests } =
      await import("@/lib/stores/worktreeGitSidebar");
    const { resetWorktreeGitSidebarWidthStoreForTests } =
      await import("@/lib/stores/worktreeGitSidebarWidth");
    resetTabStoreForTests();
    resetWorktreeGitSidebarStoreForTests();
    resetWorktreeGitSidebarWidthStoreForTests();
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
    await waitFor(() => {
      expect(mockGetProjectWorktreeGitStatus).toHaveBeenCalledTimes(1);
    });

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
    await waitFor(() => {
      expect(mockGetProjectWorktreeGitStatus).toHaveBeenCalledTimes(1);
    });

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

  it("updates git sidebar width without rerendering terminal tabs", async () => {
    const { default: WorktreeView } = await import("./WorktreeView");
    const worktree = makeWorktree();
    const { useTabStore } = await import("@/lib/stores/tabs");
    const { useWorktreeGitSidebarStore } =
      await import("@/lib/stores/worktreeGitSidebar");
    const { useWorktreeGitSidebarWidthStore } =
      await import("@/lib/stores/worktreeGitSidebarWidth");

    useTabStore.setState({
      tabs: [makeTab("a", worktree.id, { position: 1 })],
      activeTabId: "a",
      activeTabByWorktree: { [worktree.id]: "a" },
    });

    render(<WorktreeView worktree={worktree} />);
    await waitFor(() => {
      expect(mockGetProjectWorktreeGitStatus).toHaveBeenCalledTimes(1);
    });
    expect(getTerminalRenderCounts()).toEqual({ a: 1 });

    const host = document.querySelector<HTMLElement>(
      "[data-worktree-git-sidebar-wrapper]",
    );
    expect(host).not.toBeNull();
    expect(host?.style.getPropertyValue("--worktree-git-sidebar-width")).toBe(
      "320px",
    );

    act(() => {
      useWorktreeGitSidebarWidthStore.getState().setWidth(412);
    });

    expect(host?.style.getPropertyValue("--worktree-git-sidebar-width")).toBe(
      "412px",
    );
    expect(getTerminalRenderCounts()).toEqual({ a: 1 });

    fireEvent.keyDown(
      await screen.findByRole("button", { name: "Resize git sidebar" }),
      { key: "ArrowLeft" },
    );

    expect(host?.style.getPropertyValue("--worktree-git-sidebar-width")).toBe(
      "428px",
    );
    expect(getTerminalRenderCounts()).toEqual({ a: 1 });

    act(() => {
      useWorktreeGitSidebarStore.getState().toggleDesktop();
    });
    expect(getTerminalRenderCounts()).toEqual({ a: 1 });

    act(() => {
      useWorktreeGitSidebarStore.getState().toggleDesktop();
    });

    expect(host?.style.getPropertyValue("--worktree-git-sidebar-width")).toBe(
      "428px",
    );
    expect(getTerminalRenderCounts()).toEqual({ a: 1 });
  });
});
