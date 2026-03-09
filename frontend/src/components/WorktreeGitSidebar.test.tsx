// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Worktree } from "@/lib/types";

const mockGetProjectWorktreeGitStatus = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getProjectWorktreeGitStatus: (...args: unknown[]) =>
      mockGetProjectWorktreeGitStatus(...args),
  };
});

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
    name: "feature-a",
    path: "/tmp/feature-a",
    branch: "feature-a",
    source_ref: "main",
    is_local: false,
    missing_on_disk: false,
    position: 2,
  };
}

describe("WorktreeGitSidebar", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
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

    const { resetWorktreeGitSidebarStoreForTests } =
      await import("@/lib/stores/worktreeGitSidebar");
    const { resetWorktreeGitSidebarWidthStoreForTests } =
      await import("@/lib/stores/worktreeGitSidebarWidth");
    resetWorktreeGitSidebarStoreForTests();
    resetWorktreeGitSidebarWidthStoreForTests();
  });

  it("fetches on mount and only again on manual refresh", async () => {
    const { default: WorktreeGitSidebar } =
      await import("./WorktreeGitSidebar");
    render(<WorktreeGitSidebar worktree={makeWorktree()} />);

    await waitFor(() => {
      expect(mockGetProjectWorktreeGitStatus).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh git status" }));

    await waitFor(() => {
      expect(mockGetProjectWorktreeGitStatus).toHaveBeenCalledTimes(2);
    });
  });

  it("shows the desktop resize handle when expanded", async () => {
    const { default: WorktreeGitSidebar } =
      await import("./WorktreeGitSidebar");

    render(<WorktreeGitSidebar worktree={makeWorktree()} />);

    expect(
      await screen.findByRole("button", { name: "Resize git sidebar" }),
    ).toBeInTheDocument();
  });

  it("shows a collapsed desktop rail without the resize handle", async () => {
    const { useWorktreeGitSidebarStore } =
      await import("@/lib/stores/worktreeGitSidebar");
    useWorktreeGitSidebarStore.setState({
      desktopOpen: false,
      mobileOpen: false,
    });
    const { default: WorktreeGitSidebar } =
      await import("./WorktreeGitSidebar");

    render(<WorktreeGitSidebar worktree={makeWorktree()} />);

    expect(
      screen.queryByRole("button", { name: "Resize git sidebar" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand git sidebar" }));

    expect(
      await screen.findByRole("button", { name: "Collapse git sidebar" }),
    ).toBeInTheDocument();
  });

  it("renders the mobile sheet when opened from store state", async () => {
    setMobile(true);
    const { useWorktreeGitSidebarStore } =
      await import("@/lib/stores/worktreeGitSidebar");
    useWorktreeGitSidebarStore.setState({
      desktopOpen: true,
      mobileOpen: true,
    });
    const { default: WorktreeGitSidebar } =
      await import("./WorktreeGitSidebar");

    render(<WorktreeGitSidebar worktree={makeWorktree()} />);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("Git status")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Resize git sidebar" }),
    ).not.toBeInTheDocument();
  });
});
