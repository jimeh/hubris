// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMobile } from "@/test/mobile";
import {
  WORKTREE_RIGHT_SIDEBAR_ALL_FILES_TAB,
  WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB,
} from "@/lib/worktreeRightSidebar";
import type { Worktree } from "@/lib/types";

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
    is_local: false,
    missing_on_disk: false,
    position: 2,
    ...overrides,
  };
}

async function seedSelectedWorktree(worktree = makeWorktree()): Promise<void> {
  const { useWorktreeStore } = await import("@/lib/stores/worktrees");
  useWorktreeStore.setState({
    worktreesByProject: {
      [worktree.project_id]: [worktree],
    },
    projectErrors: {},
    selectedWorktreeId: worktree.id,
  });
}

async function resetStores(): Promise<void> {
  const { resetWorktreeRightSidebarStoreForTests } =
    await import("@/lib/stores/worktreeRightSidebar");
  const { resetWorktreeRightSidebarWidthStoreForTests } =
    await import("@/lib/stores/worktreeRightSidebarWidth");
  const { resetWorktreeFileManagerStoreForTests } =
    await import("@/lib/stores/worktreeFileManager");
  const { resetWorktreeGitStatusViewStoreForTests } =
    await import("@/lib/stores/worktreeGitStatusView");
  const { resetWorktreeStoreForTests } = await import("@/lib/stores/worktrees");

  resetWorktreeRightSidebarStoreForTests();
  resetWorktreeRightSidebarWidthStoreForTests();
  resetWorktreeFileManagerStoreForTests();
  resetWorktreeGitStatusViewStoreForTests();
  resetWorktreeStoreForTests();
}

describe("WorktreeRightSidebar", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    localStorage.clear();
    setMobile(false);
    await resetStores();
  });

  it("renders all-files header actions declaratively on desktop", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);
    const { default: WorktreeRightSidebar } =
      await import("./WorktreeRightSidebar");

    render(<WorktreeRightSidebar worktree={worktree} />);

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

  it("switching tabs swaps header actions immediately", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);
    const { default: WorktreeRightSidebar } =
      await import("./WorktreeRightSidebar");

    render(<WorktreeRightSidebar worktree={worktree} />);

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

  it("shows the total change count on the changes tab", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);
    const { useWorktreeRightSidebarStore } =
      await import("@/lib/stores/worktreeRightSidebar");
    const { useWorktreeFileManagerStore } =
      await import("@/lib/stores/worktreeFileManager");

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

    const { default: WorktreeRightSidebar } =
      await import("./WorktreeRightSidebar");
    render(<WorktreeRightSidebar worktree={worktree} />);

    expect(screen.getByRole("button", { name: /Changes/ })).toHaveTextContent(
      "Changes3",
    );
  });

  it("hides completely when collapsed on desktop", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);
    const { useWorktreeRightSidebarStore } =
      await import("@/lib/stores/worktreeRightSidebar");
    useWorktreeRightSidebarStore.setState({
      desktopOpen: false,
      mobileOpen: false,
    });
    const { default: WorktreeRightSidebar } =
      await import("./WorktreeRightSidebar");

    render(<WorktreeRightSidebar worktree={worktree} />);

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
    const { useWorktreeRightSidebarStore } =
      await import("@/lib/stores/worktreeRightSidebar");
    useWorktreeRightSidebarStore.setState({
      desktopOpen: true,
      mobileOpen: true,
      isMobileViewport: true,
    });
    const { default: WorktreeRightSidebar } =
      await import("./WorktreeRightSidebar");

    render(<WorktreeRightSidebar worktree={worktree} />);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Files panel body")).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Hide right sidebar" }),
    );

    await waitFor(() => {
      expect(useWorktreeRightSidebarStore.getState().mobileOpen).toBe(false);
    });
  });

  it("loads files and git status when all-files becomes visible", async () => {
    const worktree = makeWorktree();
    await seedSelectedWorktree(worktree);
    const { initializeWorktreeRightSidebarStore } =
      await import("@/lib/stores/worktreeRightSidebar");
    const { useWorktreeFileManagerStore } =
      await import("@/lib/stores/worktreeFileManager");

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
    const {
      initializeWorktreeRightSidebarStore,
      useWorktreeRightSidebarStore,
    } = await import("@/lib/stores/worktreeRightSidebar");
    const { useWorktreeFileManagerStore } =
      await import("@/lib/stores/worktreeFileManager");

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
    const {
      initializeWorktreeRightSidebarStore,
      useWorktreeRightSidebarStore,
    } = await import("@/lib/stores/worktreeRightSidebar");
    const { useWorktreeFileManagerStore } =
      await import("@/lib/stores/worktreeFileManager");

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
    const { useWorktreeStore } = await import("@/lib/stores/worktrees");
    useWorktreeStore.setState({
      worktreesByProject: {
        [selectedWorktree.project_id]: [selectedWorktree, unrelatedWorktree],
      },
      projectErrors: {},
      selectedWorktreeId: selectedWorktree.id,
    });
    const { initializeWorktreeRightSidebarStore } =
      await import("@/lib/stores/worktreeRightSidebar");
    const { useWorktreeFileManagerStore } =
      await import("@/lib/stores/worktreeFileManager");

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
