// @vitest-environment jsdom
import { act, fireEvent } from "@testing-library/react";
import {
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorktreeGitStatusPanel from "./WorktreeGitStatusPanel";
import WorktreeGitStatusViewToggle from "./WorktreeGitStatusViewToggle";
import { SidebarProvider } from "@/components/ui/sidebar";
import { useWorktreeGitStatusViewStore } from "@/lib/stores/worktreeGitStatusView";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import {
  initializeWorktreeRightSidebarStore,
  useWorktreeRightSidebarStore,
} from "@/lib/stores/worktreeRightSidebar";
import { WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB } from "@/lib/worktreeRightSidebar";
import type { Worktree } from "@/lib/types";

const mockGetProjectWorktreeGitStatus = vi.fn();
const mockGetProjectWorktreeCommitDetails = vi.fn();
const mockStageProjectWorktreePath = vi.fn();
const mockUnstageProjectWorktreePath = vi.fn();
const mockDiscardProjectWorktreePath = vi.fn();
const mockOpenGitDiff = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getProjectWorktreeGitStatus: (...args: unknown[]) =>
      mockGetProjectWorktreeGitStatus(...args),
    getProjectWorktreeCommitDetails: (...args: unknown[]) =>
      mockGetProjectWorktreeCommitDetails(...args),
    stageProjectWorktreePath: (...args: unknown[]) =>
      mockStageProjectWorktreePath(...args),
    unstageProjectWorktreePath: (...args: unknown[]) =>
      mockUnstageProjectWorktreePath(...args),
    discardProjectWorktreePath: (...args: unknown[]) =>
      mockDiscardProjectWorktreePath(...args),
  };
});

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

function renderPanel(): RenderResult {
  return renderPanelWithWorktree();
}

function PanelHarness({ worktree }: { worktree: Worktree }) {
  const viewMode = useWorktreeGitStatusViewStore(
    (state) => state.viewModeByWorktree[worktree.id] ?? "tree",
  );
  const setViewMode = useWorktreeGitStatusViewStore(
    (state) => state.setViewMode,
  );

  return (
    <SidebarProvider defaultOpen>
      <div className="px-3 pt-3">
        <WorktreeGitStatusViewToggle
          viewMode={viewMode}
          onViewModeChange={(nextViewMode) =>
            setViewMode(worktree.id, nextViewMode)
          }
        />
      </div>
      <div className="h-96">
        <WorktreeGitStatusPanel worktree={worktree} />
      </div>
    </SidebarProvider>
  );
}

function renderPanelWithWorktree(
  worktreeOverrides?: Partial<Worktree>,
): RenderResult {
  const worktree = makeWorktree(worktreeOverrides);
  useWorktreeStore.setState({
    worktreesByProject: {
      [worktree.project_id]: [worktree],
    },
    projectErrors: {},
    selectedWorktreeId: worktree.id,
  });
  useWorktreeRightSidebarStore.setState({
    isMobileViewport: false,
    desktopOpen: true,
    mobileOpen: false,
    activeTab: WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB,
  });
  initializeWorktreeRightSidebarStore();

  return render(<PanelHarness worktree={worktree} />);
}

function sectionHeaderTitles(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-git-status-section-header]"),
  ).map((element) => element.dataset.gitStatusSectionHeader ?? "");
}

describe("WorktreeGitStatusPanel", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    localStorage.clear();
    mockGetProjectWorktreeGitStatus.mockReset();
    mockGetProjectWorktreeCommitDetails.mockReset();
    mockStageProjectWorktreePath.mockReset();
    mockUnstageProjectWorktreePath.mockReset();
    mockDiscardProjectWorktreePath.mockReset();
    const { resetWorktreeFileManagerStoreForTests } =
      await import("@/lib/stores/worktreeFileManager");
    const { resetWorktreeRightSidebarStoreForTests } =
      await import("@/lib/stores/worktreeRightSidebar");
    resetWorktreeFileManagerStoreForTests();
    resetWorktreeRightSidebarStoreForTests();
    const { resetWorktreeGitStatusViewStoreForTests } =
      await import("@/lib/stores/worktreeGitStatusView");
    resetWorktreeGitStatusViewStoreForTests();
    const { resetTabStoreForTests, useTabStore } =
      await import("@/lib/stores/tabs");
    resetTabStoreForTests();
    useTabStore.setState({
      openGitDiff: mockOpenGitDiff,
    });
    const { resetWorktreeStoreForTests } =
      await import("@/lib/stores/worktrees");
    resetWorktreeStoreForTests();
    mockOpenGitDiff.mockReset();
    mockGetProjectWorktreeGitStatus.mockResolvedValue({
      source_ref: "main",
      generation: 1,
      unstaged_files: [
        { path: "tmp2/bar/bar.txt", change_type: "modified" },
        { path: "tmp2/bar/baz/fox.txt", change_type: "untracked" },
        { path: "tmp2/bar/baz/qux/deep.txt", change_type: "modified" },
        { path: "tmp2/foo.txt", change_type: "modified" },
      ],
      staged_files: [
        { path: "README.md", change_type: "added" },
        { path: "src/main.ts", change_type: "modified" },
      ],
      ahead_count: 1,
      ahead_commits: [
        { id: "abcdef123456", short_id: "abcdef1", summary: "Ahead commit" },
      ],
      comparison_available: true,
      comparison_error: null,
    });
    mockStageProjectWorktreePath.mockResolvedValue(undefined);
    mockUnstageProjectWorktreePath.mockResolvedValue(undefined);
    mockDiscardProjectWorktreePath.mockResolvedValue(undefined);
    mockGetProjectWorktreeCommitDetails.mockResolvedValue({
      id: "abcdef123456",
      short_id: "abcdef1",
      summary: "Ahead commit",
      message: "Ahead commit\n\nMore context",
      author: {
        name: "Author Example",
        email: "author@example.com",
        date: "2026-03-19T12:00:00+00:00",
      },
      committer: {
        name: "Committer Example",
        email: "committer@example.com",
        date: "2026-03-19T12:30:00+00:00",
      },
      files: [
        { path: "src/nested/deep.ts", change_type: "modified" },
        { path: "src/main.ts", change_type: "added" },
      ],
    });
  });

  it("loads git status through the sidebar coordinator", async () => {
    renderPanel();

    await waitFor(() => {
      expect(mockGetProjectWorktreeGitStatus).toHaveBeenCalledTimes(1);
    });
  });

  it("does not flash loading skeletons for fast responses", async () => {
    renderPanel();

    expect(document.querySelectorAll("[data-slot='skeleton']")).toHaveLength(0);
    expect(await screen.findByText("Unstaged")).toBeInTheDocument();
  });

  it("shows loading skeletons when the response is slow", async () => {
    vi.useFakeTimers();
    mockGetProjectWorktreeGitStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              source_ref: "main",
              generation: 1,
              unstaged_files: [],
              staged_files: [],
              ahead_count: 0,
              ahead_commits: [],
              comparison_available: true,
              comparison_error: null,
            });
          }, 300);
        }),
    );

    renderPanel();

    expect(document.querySelectorAll("[data-slot='skeleton']")).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(160);
    });

    expect(document.querySelectorAll("[data-slot='skeleton']")).toHaveLength(6);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(
      screen.getByRole("button", { name: "Unstaged" }),
    ).toBeInTheDocument();
  });

  it("renders staged, unstaged, and commits sections", async () => {
    renderPanel();

    expect(
      await screen.findByRole("button", { name: "Unstaged" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));
    expect(screen.getByRole("button", { name: "Staged" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commits" })).toBeInTheDocument();
    expect(sectionHeaderTitles()).toEqual(["Staged", "Unstaged", "Commits"]);
    expect(screen.getByText("bar.txt")).toBeInTheDocument();
    expect(screen.getAllByText("tmp2/bar").length).toBeGreaterThan(0);
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("Ahead commit")).toBeInTheDocument();
  });

  it("opens preview diffs from list rows via keyboard", async () => {
    renderPanel();

    await screen.findByRole("button", { name: "Unstaged" });
    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));

    const listRow = screen.getByText("README.md").closest("[role='button']");
    expect(listRow).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(listRow!, { key: "Enter" });
    fireEvent.keyDown(listRow!, { key: " " });

    expect(mockOpenGitDiff).toHaveBeenNthCalledWith(1, {
      worktreeId: "w1",
      path: "README.md",
      scope: "staged",
      originalPath: undefined,
      preview: true,
    });
    expect(mockOpenGitDiff).toHaveBeenNthCalledWith(2, {
      worktreeId: "w1",
      path: "README.md",
      scope: "staged",
      originalPath: undefined,
      preview: true,
    });
  });

  it("opens preview diffs from tree file rows via keyboard", async () => {
    renderPanel();

    const treeRow = (await screen.findByText("README.md")).closest(
      "[role='button']",
    );
    expect(treeRow).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(treeRow!, { key: "Enter" });
    fireEvent.keyDown(treeRow!, { key: " " });

    expect(mockOpenGitDiff).toHaveBeenNthCalledWith(1, {
      worktreeId: "w1",
      path: "README.md",
      scope: "staged",
      originalPath: undefined,
      preview: true,
    });
    expect(mockOpenGitDiff).toHaveBeenNthCalledWith(2, {
      worktreeId: "w1",
      path: "README.md",
      scope: "staged",
      originalPath: undefined,
      preview: true,
    });
  });

  it("renders compacted directory labels with faded slash separators", async () => {
    mockGetProjectWorktreeGitStatus.mockResolvedValueOnce({
      source_ref: "main",
      generation: 1,
      unstaged_files: [],
      staged_files: [
        { path: "tmp2/bar/baz/file.txt", change_type: "modified" },
      ],
      ahead_count: 0,
      ahead_commits: [],
      comparison_available: true,
      comparison_error: null,
    });

    renderPanel();

    await screen.findByRole("button", { name: "Staged" });
    fireEvent.click(screen.getByRole("button", { name: "Show tree view" }));

    const compactedToggle = await screen.findByRole("button", {
      name: "Toggle tmp2/bar/baz",
    });
    expect(compactedToggle).toHaveTextContent("tmp2 / bar / baz");
  });

  it("collapses sections independently and keeps their headers visible", async () => {
    renderPanel();

    const stagedHeader = await screen.findByRole("button", { name: "Staged" });
    const unstagedHeader = screen.getByRole("button", { name: "Unstaged" });
    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));

    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("bar.txt")).toBeInTheDocument();

    fireEvent.click(stagedHeader);

    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
    expect(screen.getByText("bar.txt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Staged" })).toBeInTheDocument();
    expect(unstagedHeader).toBeInTheDocument();
  });

  it("collapses the commits section independently", async () => {
    renderPanel();

    const commitsHeader = await screen.findByRole("button", {
      name: "Commits",
    });
    expect(screen.getByText("Ahead commit")).toBeInTheDocument();

    fireEvent.click(commitsHeader);

    expect(screen.queryByText("Ahead commit")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commits" })).toBeInTheDocument();
  });

  it("preserves section collapse state across view mode changes", async () => {
    renderPanel();

    const stagedHeader = await screen.findByRole("button", { name: "Staged" });

    fireEvent.click(stagedHeader);
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show tree view" }));
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle tmp2" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
  });

  it("renders copied, renamed, and conflict badges", async () => {
    mockGetProjectWorktreeGitStatus.mockResolvedValueOnce({
      source_ref: "main",
      generation: 1,
      unstaged_files: [
        { path: "copied.txt", change_type: "copied" },
        { path: "conflicted.txt", change_type: "conflict" },
      ],
      staged_files: [{ path: "renamed.txt", change_type: "renamed" }],
      ahead_count: 0,
      ahead_commits: [],
      comparison_available: true,
      comparison_error: null,
    });

    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: "Show list view" }),
    );

    expect(await screen.findByText("copied.txt")).toBeInTheDocument();
    expect(screen.getByText("renamed.txt")).toBeInTheDocument();
    expect(screen.getByText("conflicted.txt")).toBeInTheDocument();
    expect(screen.getByText("C")).toBeInTheDocument();
    expect(screen.getByText("R")).toBeInTheDocument();
    expect(screen.getByText("!")).toBeInTheDocument();
  });

  it("shows a rich hover card for commits and lazy-loads details once", async () => {
    const user = userEvent.setup();
    renderPanel();

    const commitRow = await screen.findByRole("button", {
      name: "Toggle commit Ahead commit",
    });
    await user.hover(commitRow);

    expect(
      await screen.findByText("Author Example <author@example.com>"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Committer Example <committer@example.com>"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Ahead commit").length).toBeGreaterThan(0);
    expect(
      screen.getByText((_, element) => {
        return element?.textContent === "Ahead commit\n\nMore context";
      }),
    ).toBeInTheDocument();

    await user.unhover(commitRow);
    await user.hover(commitRow);

    expect(mockGetProjectWorktreeCommitDetails).toHaveBeenCalledTimes(1);
    expect(mockGetProjectWorktreeCommitDetails).toHaveBeenCalledWith(
      "p1",
      "w1",
      "abcdef123456",
    );
  });

  it("renders a head marker and connector segments for the commit timeline", async () => {
    mockGetProjectWorktreeGitStatus.mockResolvedValueOnce({
      source_ref: "main",
      generation: 1,
      unstaged_files: [],
      staged_files: [],
      ahead_count: 2,
      ahead_commits: [
        { id: "head123456", short_id: "head123", summary: "Head commit" },
        {
          id: "older123456",
          short_id: "older12",
          summary: "Older commit",
        },
      ],
      comparison_available: true,
      comparison_error: null,
    });

    renderPanel();

    expect(await screen.findByText("Head commit")).toBeInTheDocument();
    expect(screen.getByText("Older commit")).toBeInTheDocument();
    expect(screen.getAllByTestId("commit-marker-head")).toHaveLength(1);
    expect(screen.getAllByTestId("commit-marker-dot")).toHaveLength(1);
    expect(
      screen.queryAllByTestId("commit-marker-connector-after"),
    ).toHaveLength(1);
    expect(
      screen.queryAllByTestId("commit-marker-connector-before"),
    ).toHaveLength(1);
  });

  it("expands a commit into a changed-file tree", async () => {
    mockGetProjectWorktreeGitStatus.mockResolvedValueOnce({
      source_ref: "main",
      generation: 1,
      unstaged_files: [
        { path: "tmp2/bar/bar.txt", change_type: "modified" },
        { path: "tmp2/foo.txt", change_type: "modified" },
      ],
      staged_files: [{ path: "README.md", change_type: "added" }],
      ahead_count: 2,
      ahead_commits: [
        { id: "abcdef123456", short_id: "abcdef1", summary: "Ahead commit" },
        {
          id: "older123456",
          short_id: "older12",
          summary: "Older commit",
        },
      ],
      comparison_available: true,
      comparison_error: null,
    });

    renderPanel();

    const commitRow = await screen.findByRole("button", {
      name: "Toggle commit Ahead commit",
    });
    fireEvent.click(commitRow);

    expect(await screen.findByText("main.ts")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Toggle src/nested" }),
    ).toBeVisible();
    expect(
      screen.getByTestId("commit-marker-connector-content"),
    ).toBeInTheDocument();
    expect(mockGetProjectWorktreeCommitDetails).toHaveBeenCalledTimes(1);
  });

  it("renders inline action buttons and manifest-backed icons in list mode", async () => {
    renderPanel();

    await screen.findByText("Unstaged");
    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));
    expect(await screen.findByText("bar.txt")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Stage bar.txt" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Discard bar.txt" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Unstage README.md" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Discard README.md" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByTestId("changes-file-icon").length).toBeGreaterThan(
      0,
    );
  });

  it("opens a row context menu in list view and stages a file", async () => {
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText("Unstaged");
    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));
    fireEvent.contextMenu(screen.getByText("bar.txt"));

    await user.click(
      await screen.findByRole("menuitem", { name: "Stage bar.txt" }),
    );

    await waitFor(() => {
      expect(mockStageProjectWorktreePath).toHaveBeenCalledWith(
        "p1",
        "w1",
        "tmp2/bar/bar.txt",
        undefined,
      );
    });
    expect(
      mockGetProjectWorktreeGitStatus.mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("shows recursive stage actions for tree directories", async () => {
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText("Unstaged");
    fireEvent.click(screen.getByRole("button", { name: "Show tree view" }));

    await user.click(screen.getByRole("button", { name: "Stage tmp2" }));

    await waitFor(() => {
      expect(mockStageProjectWorktreePath).toHaveBeenCalledWith(
        "p1",
        "w1",
        "tmp2",
        undefined,
      );
    });
  });

  it("passes original_path when staging a renamed file in list view", async () => {
    const user = userEvent.setup();
    mockGetProjectWorktreeGitStatus.mockResolvedValueOnce({
      source_ref: "main",
      generation: 1,
      unstaged_files: [
        {
          path: "new/target.txt",
          original_path: "old/source.txt",
          change_type: "renamed",
        },
      ],
      staged_files: [],
      ahead_count: 0,
      ahead_commits: [],
      comparison_available: true,
      comparison_error: null,
    });

    renderPanel();

    await screen.findByText("Unstaged");
    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));
    await user.click(screen.getByRole("button", { name: "Stage target.txt" }));

    await waitFor(() => {
      expect(mockStageProjectWorktreePath).toHaveBeenCalledWith(
        "p1",
        "w1",
        "new/target.txt",
        "old/source.txt",
      );
    });
  });

  it("passes original_path when staging a copied file in tree view", async () => {
    const user = userEvent.setup();
    mockGetProjectWorktreeGitStatus.mockResolvedValueOnce({
      source_ref: "main",
      generation: 1,
      unstaged_files: [
        {
          path: "copied-target.txt",
          original_path: "copy-source.txt",
          change_type: "copied",
        },
      ],
      staged_files: [],
      ahead_count: 0,
      ahead_commits: [],
      comparison_available: true,
      comparison_error: null,
    });

    renderPanel();

    await screen.findByText("Unstaged");
    fireEvent.click(screen.getByRole("button", { name: "Show tree view" }));
    await user.click(
      screen.getByRole("button", { name: "Stage copied-target.txt" }),
    );

    await waitFor(() => {
      expect(mockStageProjectWorktreePath).toHaveBeenCalledWith(
        "p1",
        "w1",
        "copied-target.txt",
        "copy-source.txt",
      );
    });
  });

  it("renders directory status dots in tree view while files keep letter badges", async () => {
    renderPanel();

    await screen.findByRole("button", { name: "Unstaged" });
    fireEvent.click(screen.getByRole("button", { name: "Show tree view" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle tmp2/bar" }));

    expect(
      screen.getAllByTestId("changes-directory-status-dot").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("M").length).toBeGreaterThan(0);
  });

  it("aggregates directory dots by most significant descendant change", async () => {
    mockGetProjectWorktreeGitStatus.mockResolvedValueOnce({
      source_ref: "main",
      generation: 1,
      unstaged_files: [
        { path: "tmp2/added.txt", change_type: "added" },
        { path: "tmp2/deleted.txt", change_type: "deleted" },
        { path: "tmp2/nested/copied.txt", change_type: "copied" },
      ],
      staged_files: [],
      ahead_count: 0,
      ahead_commits: [],
      comparison_available: true,
      comparison_error: null,
    });

    renderPanel();

    await screen.findByRole("button", { name: "Unstaged" });
    fireEvent.click(screen.getByRole("button", { name: "Show tree view" }));

    expect(
      screen
        .getAllByTestId("changes-directory-status-dot")
        .some((dot) => dot.classList.contains("text-rose-500")),
    ).toBe(true);
  });

  it("keeps list view unchanged without directory dots", async () => {
    renderPanel();

    await screen.findByRole("button", { name: "Unstaged" });
    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));

    expect(
      screen.queryAllByTestId("changes-directory-status-dot"),
    ).toHaveLength(0);
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("confirms discard before calling the discard API", async () => {
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText("Unstaged");
    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));
    expect(await screen.findByText("bar.txt")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Discard bar.txt" }));

    expect(
      screen.getByRole("heading", { name: "Discard changes in bar.txt?" }),
    ).toBeInTheDocument();
    expect(mockDiscardProjectWorktreePath).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(mockDiscardProjectWorktreePath).toHaveBeenCalledWith(
        "p1",
        "w1",
        "tmp2/bar/bar.txt",
      );
    });
  });

  it("uses sticky section headers inside the panel scroll area", async () => {
    renderPanel();

    expect(
      await screen.findByRole("button", { name: "Unstaged" }),
    ).toBeInTheDocument();

    const unstagedHeader = document.querySelector<HTMLElement>(
      '[data-git-status-section-header="Unstaged"]',
    );
    const stagedHeader = document.querySelector<HTMLElement>(
      '[data-git-status-section-header="Staged"]',
    );
    const commitsHeader = document.querySelector<HTMLElement>(
      '[data-git-status-section-header="Commits"]',
    );

    expect(unstagedHeader).toHaveClass("sticky", "top-3");
    expect(stagedHeader).toHaveClass("sticky", "top-3");
    expect(commitsHeader).toHaveClass("sticky", "top-3");
  });

  it("defaults to tree mode", async () => {
    renderPanel();

    await screen.findByText("Unstaged");

    expect(screen.getByRole("button", { name: "Toggle tmp2" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Toggle src" })).toBeVisible();
    expect(screen.queryByText("tmp2/bar/bar.txt")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Show tree view" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("switches both sections into tree mode", async () => {
    renderPanel();

    await screen.findByText("Unstaged");

    fireEvent.click(screen.getByRole("button", { name: "Show tree view" }));

    expect(screen.getByRole("button", { name: "Toggle tmp2" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Toggle src" })).toBeVisible();
    expect(screen.queryByText("tmp2/bar/bar.txt")).toBeNull();
    expect(screen.queryByText("src/main.ts")).toBeNull();
    expect(screen.getByText("main.ts")).toBeInTheDocument();
  });

  it("updates nested chevrons based on open state", async () => {
    renderPanel();

    await screen.findByText("Unstaged");
    fireEvent.click(screen.getByRole("button", { name: "Show tree view" }));

    const tmp2Toggle = screen.getByRole("button", { name: "Toggle tmp2" });
    const barToggle = screen.getByRole("button", { name: "Toggle tmp2/bar" });
    const bazToggle = screen.queryByRole("button", {
      name: "Toggle tmp2/bar/baz",
    });

    expect(tmp2Toggle.firstElementChild).toHaveClass("rotate-90");
    expect(barToggle.firstElementChild).not.toHaveClass("rotate-90");
    expect(bazToggle).toBeNull();

    fireEvent.click(barToggle);

    const bazToggleAfterOpen = screen.getByRole("button", {
      name: "Toggle tmp2/bar/baz",
    });

    expect(barToggle.firstElementChild).toHaveClass("rotate-90");
    expect(bazToggleAfterOpen.firstElementChild).not.toHaveClass("rotate-90");

    fireEvent.click(barToggle);

    expect(
      screen.queryByRole("button", { name: "Toggle tmp2/bar/baz" }),
    ).toBeNull();
    expect(barToggle.firstElementChild).not.toHaveClass("rotate-90");
  });

  it("remembers expanded descendants when an ancestor is collapsed", async () => {
    renderPanel();

    await screen.findByRole("button", { name: "Unstaged" });
    fireEvent.click(screen.getByRole("button", { name: "Show tree view" }));

    fireEvent.click(
      await screen.findByRole("button", { name: "Toggle tmp2/bar" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Toggle tmp2/bar/baz" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Toggle tmp2/bar/baz/qux" }),
    );

    expect(await screen.findByText("deep.txt")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Toggle tmp2" }));
    await waitFor(() => {
      expect(screen.queryByText("deep.txt")).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Toggle tmp2" }));

    expect(
      await screen.findByRole("button", { name: "Toggle tmp2/bar/baz/qux" }),
    ).toBeVisible();
    expect(await screen.findByText("deep.txt")).toBeInTheDocument();
  }, 10_000);

  it("uses one header toggle to switch both sections", async () => {
    renderPanel();

    await screen.findByRole("button", { name: "Unstaged" });

    const treeButton = screen.getByRole("button", { name: "Show tree view" });
    const listButton = screen.getByRole("button", { name: "Show list view" });

    fireEvent.click(treeButton);

    await waitFor(() => {
      expect(treeButton).toHaveAttribute("aria-pressed", "true");
      expect(listButton).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByRole("button", { name: "Toggle tmp2" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Toggle src" })).toBeVisible();
    });
  });

  it("persists list mode across remounts for the same worktree", async () => {
    const firstRender = renderPanel();

    await screen.findByRole("button", { name: "Unstaged" });
    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Show list view" }),
      ).toHaveAttribute("aria-pressed", "true");
    });

    firstRender.unmount();

    renderPanel();

    await screen.findByRole("button", { name: "Unstaged" });
    expect(screen.getAllByText("tmp2/bar").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Toggle tmp2" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Show list view" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps view mode separate per worktree", async () => {
    const firstRender = renderPanelWithWorktree({ id: "w-alpha" });

    await screen.findByRole("button", { name: "Unstaged" });
    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Show list view" }),
      ).toHaveAttribute("aria-pressed", "true");
    });

    firstRender.unmount();

    renderPanelWithWorktree({ id: "w-beta" });

    await screen.findByRole("button", { name: "Unstaged" });
    expect(screen.getByRole("button", { name: "Toggle tmp2" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Show tree view" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("preserves section collapse state per worktree without reset effects", async () => {
    const alpha = makeWorktree({ id: "w-alpha" });
    const beta = makeWorktree({ id: "w-beta", name: "feature-b" });
    useWorktreeStore.setState({
      worktreesByProject: {
        [alpha.project_id]: [alpha, beta],
      },
      projectErrors: {},
      selectedWorktreeId: alpha.id,
    });
    useWorktreeRightSidebarStore.setState({
      isMobileViewport: false,
      desktopOpen: true,
      mobileOpen: false,
      activeTab: WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB,
    });
    initializeWorktreeRightSidebarStore();

    const view = render(<PanelHarness worktree={alpha} />);

    const stagedHeader = await screen.findByRole("button", { name: "Staged" });
    fireEvent.click(stagedHeader);
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();

    useWorktreeStore.setState({ selectedWorktreeId: beta.id });
    view.rerender(<PanelHarness worktree={beta} />);

    expect(await screen.findByRole("button", { name: "Staged" })).toBeVisible();
    expect(await screen.findByText("README.md")).toBeInTheDocument();

    useWorktreeStore.setState({ selectedWorktreeId: alpha.id });
    view.rerender(<PanelHarness worktree={alpha} />);

    expect(await screen.findByRole("button", { name: "Staged" })).toBeVisible();
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
  });
});
