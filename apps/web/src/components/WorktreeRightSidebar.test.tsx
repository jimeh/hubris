// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMobile } from "@/test/mobile";
import WorktreeRightSidebar from "./WorktreeRightSidebar";
import { resetChatStoreForTests, useChatStore } from "@/lib/stores/chats";
import {
  initializeWorktreeRightSidebarStore,
  resetWorktreeRightSidebarStoreForTests,
  useWorktreeRightSidebarStore,
} from "@/lib/stores/worktreeRightSidebar";
import { resetWorktreeRightSidebarWidthStoreForTests } from "@/lib/stores/worktreeRightSidebarWidth";
import {
  resetWorktreeFileManagerStoreForTests,
  useWorktreeFileManagerStore,
} from "@/lib/stores/worktreeFileManager";
import { resetWorktreeGitStatusViewStoreForTests } from "@/lib/stores/worktreeGitStatusView";
import {
  resetWorktreeStoreForTests,
  useWorktreeStore,
} from "@/lib/stores/worktrees";
import {
  WORKTREE_RIGHT_SIDEBAR_ALL_FILES_TAB,
  WORKTREE_RIGHT_SIDEBAR_CHATS_TAB,
  WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB,
} from "@/lib/worktreeRightSidebar";
import type { Worktree } from "@/lib/types";

class ResizeObserverMock {
  static instances = new Set<ResizeObserverMock>();

  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverMock.instances.add(this);
  }

  observe() {}

  unobserve() {}

  disconnect() {
    ResizeObserverMock.instances.delete(this);
  }

  notify(target: Element): void {
    this.callback([{ target } as ResizeObserverEntry], this as ResizeObserver);
  }

  static reset(): void {
    ResizeObserverMock.instances.clear();
  }
}

let originalResizeObserver = window.ResizeObserver;

vi.mock("@/components/WorktreeGitStatusPanel", () => ({
  default: function MockWorktreeGitStatusPanel() {
    return <div>Git panel body</div>;
  },
}));

vi.mock("@/components/WorktreeAllFilesPanel", () => ({
  default: function MockWorktreeAllFilesPanel() {
    return <div>Files panel body</div>;
  },
}));

function makeWorktree(overrides?: Partial<Worktree>): Worktree {
  return {
    id: "w1",
    project_id: "p1",
    name: "feature-a",
    path: "/tmp/feature-a",
    branch: "feature-a",
    source_ref: "main",
    ui_mode: "hubris",
    is_local: false,
    missing_on_disk: false,
    position: 2,
    ...overrides,
  };
}

async function seedSelectedWorktree(worktree = makeWorktree()): Promise<void> {
  useWorktreeStore.setState({
    worktreesByProject: {
      [worktree.project_id]: [worktree],
    },
    projectErrors: {},
    selectedWorktreeId: worktree.id,
  });
}

async function resetStores(): Promise<void> {
  resetChatStoreForTests();
  resetWorktreeRightSidebarStoreForTests();
  resetWorktreeRightSidebarWidthStoreForTests();
  resetWorktreeFileManagerStoreForTests();
  resetWorktreeGitStatusViewStoreForTests();
  resetWorktreeStoreForTests();
}

function setElementWidths(
  element: HTMLElement,
  {
    clientWidth,
    scrollWidth,
  }: {
    clientWidth: number;
    scrollWidth: number;
  },
): void {
  Object.defineProperties(element, {
    clientWidth: {
      configurable: true,
      get: () => clientWidth,
    },
    scrollWidth: {
      configurable: true,
      get: () => scrollWidth,
    },
  });
}

function triggerResize(target: Element): void {
  const observers = Array.from(ResizeObserverMock.instances);

  if (observers.length === 0) {
    throw new Error("ResizeObserver callback not registered");
  }

  act(() => {
    for (const observer of observers) {
      observer.notify(target);
    }
  });
}

function setHeaderMetrics({
  headerWidth,
  tabsWidth,
  actionsWidth,
}: {
  headerWidth: number;
  tabsWidth: number;
  actionsWidth: number;
}): void {
  const header = document.querySelector<HTMLElement>(
    "[data-worktree-right-sidebar-header]",
  );
  const tabsMeasure = document.querySelector<HTMLElement>(
    "[data-worktree-right-sidebar-tabs-measure]",
  );
  const actions = document.querySelector<HTMLElement>(
    "[data-worktree-right-sidebar-actions]",
  );

  if (!header || !tabsMeasure || !actions) {
    throw new Error("Right sidebar header metrics targets not found");
  }

  setElementWidths(header, {
    clientWidth: headerWidth,
    scrollWidth: headerWidth,
  });
  setElementWidths(tabsMeasure, {
    clientWidth: tabsWidth,
    scrollWidth: tabsWidth,
  });
  setElementWidths(actions, {
    clientWidth: actionsWidth,
    scrollWidth: actionsWidth,
  });

  triggerResize(header);
}

describe("WorktreeRightSidebar", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    originalResizeObserver = window.ResizeObserver;
    ResizeObserverMock.reset();
    window.ResizeObserver = ResizeObserverMock;
    localStorage.clear();
    setMobile(false);
    await resetStores();
  });

  afterEach(() => {
    cleanup();
    ResizeObserverMock.reset();
    window.ResizeObserver = originalResizeObserver;
  });

  it("renders all-files header actions declaratively on desktop", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);

    render(<WorktreeRightSidebar worktree={worktree} active />);

    expect(screen.getByText("Files panel body")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh files" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Refresh git status" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Resize right sidebar" }),
    ).toBeInTheDocument();
  });

  it("switches to the chats tab without triggering unstable snapshot errors", async () => {
    const worktree = makeWorktree();
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await seedSelectedWorktree(worktree);
    useChatStore.setState({
      conversationsById: {
        "chat-1": {
          id: "chat-1",
          sessionId: "default",
          projectId: worktree.project_id,
          worktreeId: worktree.id,
          provider: "codex",
          providerThreadId: "thread-1",
          title: "Investigate build failure",
          createdAt: 10,
          updatedAt: 10,
          lastActivityAt: 10,
          lastMessageAt: 10,
          openTabId: null,
          lastRunState: "completed",
          lastError: null,
          lastReconciliationState: "not_needed",
          lastReconciliationError: null,
          pendingRequestCount: 0,
          latestPendingRequestId: null,
          latestPendingRequestKind: null,
          latestPendingRequestStatus: null,
          hasPendingRequestAttention: false,
          revision: 1,
        },
      },
      runtimesByConversationId: {},
      detailsByConversationId: {},
    });

    render(<WorktreeRightSidebar worktree={worktree} active />);

    fireEvent.click(screen.getByRole("button", { name: "Chats" }));

    expect(
      await screen.findByText("Investigate build failure"),
    ).toBeInTheDocument();
    expect(useWorktreeRightSidebarStore.getState().activeTab).toBe(
      WORKTREE_RIGHT_SIDEBAR_CHATS_TAB,
    );
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining(
        "The result of getSnapshot should be cached to avoid an infinite loop",
      ),
    );
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Maximum update depth exceeded"),
    );
  });

  it("keeps labeled tabs when the desktop header has enough room", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);

    render(<WorktreeRightSidebar worktree={worktree} active />);
    setHeaderMetrics({
      headerWidth: 280,
      tabsWidth: 150,
      actionsWidth: 80,
    });

    expect(
      document
        .querySelector("[data-worktree-right-sidebar-header]")
        ?.getAttribute("data-compact-tabs"),
    ).toBe("false");
    expect(screen.getByRole("button", { name: "All Files" })).toHaveTextContent(
      "All Files",
    );
    expect(screen.getByRole("button", { name: "Changes" })).toHaveTextContent(
      "Changes",
    );
  });

  it("collapses desktop tabs to icons when the header gets too tight", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);

    render(<WorktreeRightSidebar worktree={worktree} active />);
    setHeaderMetrics({
      headerWidth: 220,
      tabsWidth: 150,
      actionsWidth: 80,
    });

    expect(
      document
        .querySelector("[data-worktree-right-sidebar-header]")
        ?.getAttribute("data-compact-tabs"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "All Files" }),
    ).not.toHaveTextContent("All Files");
    expect(
      screen.getByRole("button", { name: "Changes" }),
    ).not.toHaveTextContent("Changes");
  });

  it("applies compact tabs on first render when the header is already tight", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);

    const clientWidthSpy = vi.spyOn(
      HTMLElement.prototype,
      "clientWidth",
      "get",
    );
    clientWidthSpy.mockImplementation(function clientWidth(this: HTMLElement) {
      if (this.matches("[data-worktree-right-sidebar-header]")) {
        return 220;
      }
      if (this.matches("[data-worktree-right-sidebar-actions]")) {
        return 80;
      }

      return 0;
    });

    const scrollWidthSpy = vi.spyOn(
      HTMLElement.prototype,
      "scrollWidth",
      "get",
    );
    scrollWidthSpy.mockImplementation(function scrollWidth(this: HTMLElement) {
      if (this.matches("[data-worktree-right-sidebar-tabs-measure]")) {
        return 150;
      }
      if (this.matches("[data-worktree-right-sidebar-actions]")) {
        return 80;
      }

      return 0;
    });

    render(<WorktreeRightSidebar worktree={worktree} active />);

    expect(
      document
        .querySelector("[data-worktree-right-sidebar-header]")
        ?.getAttribute("data-compact-tabs"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "All Files" }),
    ).not.toHaveTextContent("All Files");
  });

  it("collapses slightly before the exact width boundary", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);

    render(<WorktreeRightSidebar worktree={worktree} active />);
    setHeaderMetrics({
      headerWidth: 250,
      tabsWidth: 150,
      actionsWidth: 80,
    });

    expect(
      document
        .querySelector("[data-worktree-right-sidebar-header]")
        ?.getAttribute("data-compact-tabs"),
    ).toBe("true");
  });

  it("switching tabs swaps header actions immediately", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);

    render(<WorktreeRightSidebar worktree={worktree} active />);

    fireEvent.click(screen.getByRole("button", { name: /Changes/ }));

    expect(
      screen.getByRole("button", { name: "Refresh git status" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show list view" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show tree view" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Refresh files" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Git panel body")).toBeInTheDocument();
  });

  it("recomputes compact mode when the changes actions get wider", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);

    render(<WorktreeRightSidebar worktree={worktree} active />);
    setHeaderMetrics({
      headerWidth: 248,
      tabsWidth: 150,
      actionsWidth: 70,
    });

    expect(
      document
        .querySelector("[data-worktree-right-sidebar-header]")
        ?.getAttribute("data-compact-tabs"),
    ).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    setHeaderMetrics({
      headerWidth: 248,
      tabsWidth: 150,
      actionsWidth: 100,
    });

    expect(
      document
        .querySelector("[data-worktree-right-sidebar-header]")
        ?.getAttribute("data-compact-tabs"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Changes" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Changes" }),
    ).not.toHaveTextContent("Changes");
  });

  it("shows the total change count on the changes tab", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);

    useWorktreeRightSidebarStore.setState({
      activeTab: WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB,
    });
    useWorktreeFileManagerStore.setState({
      worktrees: {
        [worktree.id]: {
          directories: {},
          expandedPaths: [],
          selectedPath: null,
          renamePath: null,
          gitStatus: {
            source_ref: "main",
            generation: 1,
            unstaged_files: [
              { path: "foo.txt", change_type: "modified" },
              { path: "bar.txt", change_type: "untracked" },
            ],
            staged_files: [{ path: "README.md", change_type: "added" }],
            ahead_count: 0,
            ahead_commits: [],
            comparison_available: true,
            comparison_error: null,
          },
          gitStatusStatus: "loaded",
          gitError: null,
          pendingGeneration: 0,
          pendingGitGeneration: 0,
          pendingChangedPaths: [],
          pendingListingPaths: [],
        },
      },
    });

    render(<WorktreeRightSidebar worktree={worktree} active />);

    expect(screen.getByRole("button", { name: /Changes/ })).toHaveTextContent(
      "Changes3",
    );
  });

  it("keeps the numeric changes badge visible in compact mode", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);

    useWorktreeRightSidebarStore.setState({
      activeTab: WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB,
    });
    useWorktreeFileManagerStore.setState({
      worktrees: {
        [worktree.id]: {
          directories: {},
          expandedPaths: [],
          selectedPath: null,
          renamePath: null,
          gitStatus: {
            source_ref: "main",
            generation: 1,
            unstaged_files: [
              { path: "foo.txt", change_type: "modified" },
              { path: "bar.txt", change_type: "untracked" },
            ],
            staged_files: [{ path: "README.md", change_type: "added" }],
            ahead_count: 0,
            ahead_commits: [],
            comparison_available: true,
            comparison_error: null,
          },
          gitStatusStatus: "loaded",
          gitError: null,
          pendingGeneration: 0,
          pendingGitGeneration: 0,
          pendingChangedPaths: [],
          pendingListingPaths: [],
        },
      },
    });

    render(<WorktreeRightSidebar worktree={worktree} active />);
    setHeaderMetrics({
      headerWidth: 220,
      tabsWidth: 165,
      actionsWidth: 100,
    });

    expect(screen.getByRole("button", { name: "Changes" })).toHaveTextContent(
      "3",
    );
    expect(
      screen.getByRole("button", { name: "Changes" }),
    ).not.toHaveTextContent("Changes");
  });

  it("hides completely when collapsed on desktop", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);
    useWorktreeRightSidebarStore.setState({
      desktopOpen: false,
      mobileOpen: false,
    });

    render(<WorktreeRightSidebar worktree={worktree} active />);

    const host = document.querySelector<HTMLElement>(
      "[data-worktree-right-sidebar-wrapper]",
    );
    const gap = document.querySelector<HTMLElement>(
      "[data-worktree-right-sidebar-gap]",
    );
    const panel = document.querySelector<HTMLElement>(
      "[data-worktree-right-sidebar-panel]",
    );
    expect(host?.dataset.state).toBe("closed");
    expect(gap?.style.width).toBe("0px");
    expect(panel).toHaveAttribute("aria-hidden", "true");
    expect(panel).toHaveAttribute("inert");
    expect(panel).toHaveClass("translate-x-full");
    expect(
      screen.queryByRole("button", { name: "Resize right sidebar" }),
    ).not.toBeInTheDocument();
  });

  it("renders the mobile sheet with the active tab content", async () => {
    setMobile(true);
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);
    useWorktreeRightSidebarStore.setState({
      desktopOpen: true,
      mobileOpen: true,
      isMobileViewport: true,
    });

    render(<WorktreeRightSidebar worktree={worktree} active />);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Files panel body")).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Hide right sidebar" }),
    );

    await waitFor(() => {
      expect(useWorktreeRightSidebarStore.getState().mobileOpen).toBe(false);
    });
  });

  it("collapses tabs in the mobile sheet when the header is tight", async () => {
    setMobile(true);
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);
    useWorktreeRightSidebarStore.setState({
      desktopOpen: true,
      mobileOpen: true,
      isMobileViewport: true,
    });

    render(<WorktreeRightSidebar worktree={worktree} active />);
    setHeaderMetrics({
      headerWidth: 220,
      tabsWidth: 150,
      actionsWidth: 110,
    });

    expect(
      document
        .querySelector("[data-worktree-right-sidebar-header]")
        ?.getAttribute("data-compact-tabs"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "All Files" }),
    ).not.toHaveTextContent("All Files");
    expect(
      screen.getByRole("button", { name: "Hide right sidebar" }),
    ).toBeInTheDocument();
  });

  it("keeps resize measurement working after the sidebar remounts", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);

    const { rerender } = render(
      <WorktreeRightSidebar worktree={worktree} active />,
    );
    setHeaderMetrics({
      headerWidth: 280,
      tabsWidth: 150,
      actionsWidth: 80,
    });

    rerender(
      <WorktreeRightSidebar worktree={{ ...worktree, id: "w2" }} active />,
    );
    setHeaderMetrics({
      headerWidth: 220,
      tabsWidth: 150,
      actionsWidth: 80,
    });

    expect(
      document
        .querySelector("[data-worktree-right-sidebar-header]")
        ?.getAttribute("data-compact-tabs"),
    ).toBe("true");
  });

  it("loads files and git status when all-files becomes visible", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);

    const loadDirectory = vi.fn().mockResolvedValue(undefined);
    const preloadVisibleDirectories = vi.fn().mockResolvedValue(undefined);
    const loadGitStatus = vi.fn().mockResolvedValue(undefined);

    useWorktreeFileManagerStore.setState({
      loadDirectory,
      preloadVisibleDirectories,
      loadGitStatus,
    });

    initializeWorktreeRightSidebarStore();

    await waitFor(() => {
      expect(loadDirectory).toHaveBeenCalledWith("p1", "w1", "");
      expect(preloadVisibleDirectories).toHaveBeenCalledWith("p1", "w1");
      expect(loadGitStatus).toHaveBeenCalledWith("p1", "w1");
    });
  });

  it("loads git status when changes becomes visible", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);

    const loadGitStatus = vi.fn().mockResolvedValue(undefined);
    useWorktreeRightSidebarStore.setState({
      activeTab: WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB,
    });
    useWorktreeFileManagerStore.setState({ loadGitStatus });

    initializeWorktreeRightSidebarStore();

    await waitFor(() => {
      expect(loadGitStatus).toHaveBeenCalledWith("p1", "w1");
    });
  });

  it("keeps pending refresh queued while hidden and flushes on open", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);

    const refreshPendingPaths = vi.fn().mockResolvedValue(undefined);
    useWorktreeRightSidebarStore.setState({
      desktopOpen: false,
      mobileOpen: false,
      activeTab: WORKTREE_RIGHT_SIDEBAR_ALL_FILES_TAB,
    });
    useWorktreeFileManagerStore.setState({
      refreshPendingPaths,
      worktrees: {
        [worktree.id]: {
          directories: {},
          expandedPaths: [],
          selectedPath: null,
          renamePath: null,
          gitStatus: null,
          gitStatusStatus: "idle",
          gitError: null,
          pendingGeneration: 4,
          pendingGitGeneration: 0,
          pendingChangedPaths: [""],
          pendingListingPaths: [""],
        },
      },
    });

    initializeWorktreeRightSidebarStore();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refreshPendingPaths).not.toHaveBeenCalled();

    useWorktreeRightSidebarStore.setState({ desktopOpen: true });

    await waitFor(() => {
      expect(refreshPendingPaths).toHaveBeenCalledWith("p1", "w1");
    });
  });

  it("ignores unrelated file-manager updates for sidebar coordination", async () => {
    const selectedWorktree = makeWorktree();
    const unrelatedWorktree = makeWorktree({
      id: "w2",
      name: "feature-b",
      path: "/tmp/feature-b",
      branch: "feature-b",
      position: 3,
    });
    useWorktreeStore.setState({
      worktreesByProject: {
        [selectedWorktree.project_id]: [selectedWorktree, unrelatedWorktree],
      },
      projectErrors: {},
      selectedWorktreeId: selectedWorktree.id,
    });
    const loadDirectory = vi.fn().mockResolvedValue(undefined);
    const preloadVisibleDirectories = vi.fn().mockResolvedValue(undefined);
    const loadGitStatus = vi.fn().mockResolvedValue(undefined);

    useWorktreeFileManagerStore.setState({
      loadDirectory,
      preloadVisibleDirectories,
      loadGitStatus,
    });

    initializeWorktreeRightSidebarStore();

    await waitFor(() => {
      expect(loadDirectory).toHaveBeenCalledWith("p1", "w1", "");
      expect(preloadVisibleDirectories).toHaveBeenCalledWith("p1", "w1");
      expect(loadGitStatus).toHaveBeenCalledWith("p1", "w1");
    });

    loadDirectory.mockClear();
    preloadVisibleDirectories.mockClear();
    loadGitStatus.mockClear();

    useWorktreeFileManagerStore.setState((state) => ({
      worktrees: {
        ...state.worktrees,
        [unrelatedWorktree.id]: {
          directories: {},
          expandedPaths: [],
          selectedPath: null,
          renamePath: null,
          gitStatus: null,
          gitStatusStatus: "idle",
          gitError: null,
          pendingGeneration: 7,
          pendingGitGeneration: 0,
          pendingChangedPaths: [""],
          pendingListingPaths: [""],
        },
      },
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadDirectory).not.toHaveBeenCalled();
    expect(preloadVisibleDirectories).not.toHaveBeenCalled();
    expect(loadGitStatus).not.toHaveBeenCalled();
  });
});
