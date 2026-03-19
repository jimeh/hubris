// @vitest-environment jsdom
import { act, fireEvent } from "@testing-library/react";
import {
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorktreeGitStatusPanel from "./WorktreeGitStatusPanel";
import { SidebarProvider } from "@/components/ui/sidebar";
import type { Worktree } from "@/lib/types";

const mockGetProjectWorktreeGitStatus = vi.fn();
const mockStageProjectWorktreePath = vi.fn();
const mockUnstageProjectWorktreePath = vi.fn();
const mockDiscardProjectWorktreePath = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getProjectWorktreeGitStatus: (...args: unknown[]) =>
      mockGetProjectWorktreeGitStatus(...args),
    stageProjectWorktreePath: (...args: unknown[]) =>
      mockStageProjectWorktreePath(...args),
    unstageProjectWorktreePath: (...args: unknown[]) =>
      mockUnstageProjectWorktreePath(...args),
    discardProjectWorktreePath: (...args: unknown[]) =>
      mockDiscardProjectWorktreePath(...args),
  };
});

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

function renderPanel(): RenderResult {
  return renderPanelWithOpen(true);
}

function renderPanelWithOpen(open: boolean): RenderResult {
  function Harness({ open: isOpen }: { open: boolean }) {
    const [actions, setActions] = useState<ReactNode>(null);

    return (
      <SidebarProvider defaultOpen>
        <div>{actions}</div>
        <div className="h-96">
          {/* height ensures ScrollArea has a real container in tests */}
          <WorktreeGitStatusPanel
            worktree={makeWorktree()}
            open={isOpen}
            onActionsChange={setActions}
          />
        </div>
      </SidebarProvider>
    );
  }

  return render(<Harness open={open} />);
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
    mockGetProjectWorktreeGitStatus.mockReset();
    mockStageProjectWorktreePath.mockReset();
    mockUnstageProjectWorktreePath.mockReset();
    mockDiscardProjectWorktreePath.mockReset();
    const { resetWorktreeFileManagerStoreForTests } =
      await import("@/lib/stores/worktreeFileManager");
    resetWorktreeFileManagerStoreForTests();
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
  });

  it("fetches on mount and only again on manual refresh", async () => {
    renderPanel();

    await waitFor(() => {
      expect(mockGetProjectWorktreeGitStatus).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh git status" }));

    await waitFor(() => {
      expect(mockGetProjectWorktreeGitStatus).toHaveBeenCalledTimes(2);
    });
  });

  it("does not fetch or publish header actions while closed", async () => {
    renderPanelWithOpen(false);

    expect(mockGetProjectWorktreeGitStatus).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Refresh git status" }),
    ).not.toBeInTheDocument();
  });

  it("fetches once when opened after mounting closed", async () => {
    function Harness() {
      const [actions, setActions] = useState<ReactNode>(null);
      const [open, setOpen] = useState(false);

      return (
        <SidebarProvider defaultOpen>
          <div>{actions}</div>
          <button type="button" onClick={() => setOpen(true)}>
            Open panel
          </button>
          <div className="h-96">
            <WorktreeGitStatusPanel
              worktree={makeWorktree()}
              open={open}
              onActionsChange={setActions}
            />
          </div>
        </SidebarProvider>
      );
    }

    render(<Harness />);

    expect(mockGetProjectWorktreeGitStatus).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open panel" }));

    await waitFor(() => {
      expect(mockGetProjectWorktreeGitStatus).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.getByRole("button", { name: "Refresh git status" }),
    ).toBeInTheDocument();
  });

  it("fetches when reopened and preserves expanded tree state", async () => {
    function Harness() {
      const [actions, setActions] = useState<ReactNode>(null);
      const [open, setOpen] = useState(true);

      return (
        <SidebarProvider defaultOpen>
          <div>{actions}</div>
          <button type="button" onClick={() => setOpen((value) => !value)}>
            Toggle open
          </button>
          <div className="h-96">
            <WorktreeGitStatusPanel
              worktree={makeWorktree()}
              open={open}
              onActionsChange={setActions}
            />
          </div>
        </SidebarProvider>
      );
    }

    render(<Harness />);

    await screen.findByText("Unstaged");
    fireEvent.click(screen.getByRole("button", { name: "Show tree view" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle tmp2/bar" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Toggle tmp2/bar/baz" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Toggle tmp2/bar/baz/qux" }),
    );
    expect(screen.getByText("deep.txt")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Toggle open" }));
    expect(
      screen.queryByRole("button", { name: "Refresh git status" }),
    ).not.toBeInTheDocument();
    expect(mockGetProjectWorktreeGitStatus).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Toggle open" }));

    expect(await screen.findByText("Unstaged")).toBeInTheDocument();
    expect(mockGetProjectWorktreeGitStatus).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Toggle tmp2/bar/baz/qux" }),
    ).toBeVisible();
    expect(screen.getByText("deep.txt")).toBeInTheDocument();
  }, 10_000);

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

  it("renders staged, unstaged, and ahead sections", async () => {
    renderPanel();

    expect(
      await screen.findByRole("button", { name: "Unstaged" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Staged" })).toBeInTheDocument();
    expect(screen.getByText("Ahead of main")).toBeInTheDocument();
    expect(sectionHeaderTitles()).toEqual([
      "Staged",
      "Unstaged",
      "Ahead of main",
    ]);
    expect(screen.getByText("bar.txt")).toBeInTheDocument();
    expect(screen.getAllByText("tmp2/bar").length).toBeGreaterThan(0);
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("Ahead commit")).toBeInTheDocument();
  });

  it("renders compacted directory labels with faded slash separators", async () => {
    mockGetProjectWorktreeGitStatus.mockResolvedValueOnce({
      source_ref: "main",
      generation: 1,
      unstaged_files: [],
      staged_files: [{ path: "tmp2/bar/baz/file.txt", change_type: "modified" }],
      ahead_count: 0,
      ahead_commits: [],
      comparison_available: true,
      comparison_error: null,
    });

    renderPanel();

    await screen.findByRole("button", { name: "Staged" });
    fireEvent.click(screen.getByRole("button", { name: "Show tree view" }));

    const separators = screen.getAllByTestId("changes-directory-separator");
    expect(separators.length).toBeGreaterThan(0);
    for (const separator of separators) {
      expect(separator).toHaveClass("text-sidebar-foreground/35");
    }
  });

  it("collapses sections independently and keeps their headers visible", async () => {
    renderPanel();

    const stagedHeader = await screen.findByRole("button", { name: "Staged" });
    const unstagedHeader = screen.getByRole("button", { name: "Unstaged" });

    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("bar.txt")).toBeInTheDocument();

    fireEvent.click(stagedHeader);

    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
    expect(screen.getByText("bar.txt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Staged" })).toBeInTheDocument();
    expect(unstagedHeader).toBeInTheDocument();
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

    expect(await screen.findByText("copied.txt")).toBeInTheDocument();
    expect(screen.getByText("renamed.txt")).toBeInTheDocument();
    expect(screen.getByText("conflicted.txt")).toBeInTheDocument();
    expect(screen.getByText("C")).toBeInTheDocument();
    expect(screen.getByText("R")).toBeInTheDocument();
    expect(screen.getByText("!")).toBeInTheDocument();
  });

  it("renders inline action buttons and manifest-backed icons in list mode", async () => {
    renderPanel();

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
    fireEvent.contextMenu(screen.getByText("bar.txt"));

    await user.click(
      await screen.findByRole("menuitem", { name: "Stage bar.txt" }),
    );

    await waitFor(() => {
      expect(mockStageProjectWorktreePath).toHaveBeenCalledWith(
        "p1",
        "w1",
        "tmp2/bar/bar.txt",
      );
    });
    expect(mockGetProjectWorktreeGitStatus).toHaveBeenCalledTimes(2);
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

    const dots = screen.getAllByTestId("changes-directory-status-dot");
    expect(dots.length).toBeGreaterThan(0);

    expect(dots.some((dot) => dot.classList.contains("text-rose-500"))).toBe(
      true,
    );
  });

  it("keeps list view unchanged without directory dots", async () => {
    renderPanel();

    await screen.findByRole("button", { name: "Unstaged" });

    expect(
      screen.queryByTestId("changes-directory-status-dot"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("confirms discard before calling the discard API", async () => {
    const user = userEvent.setup();
    renderPanel();

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
    const aheadHeader = document.querySelector<HTMLElement>(
      '[data-git-status-section-header="Ahead of main"]',
    );

    expect(unstagedHeader).toHaveClass("sticky", "top-3");
    expect(stagedHeader).toHaveClass("sticky", "top-3");
    expect(aheadHeader).toHaveClass("sticky", "top-3");
  });

  it("defaults to list mode", async () => {
    renderPanel();

    expect(await screen.findByText("bar.txt")).toBeInTheDocument();
    expect(screen.getAllByText("tmp2/bar").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Toggle tmp2" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Show list view" }),
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

    await screen.findByText("Unstaged");
    fireEvent.click(screen.getByRole("button", { name: "Show tree view" }));

    fireEvent.click(screen.getByRole("button", { name: "Toggle tmp2/bar" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Toggle tmp2/bar/baz" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Toggle tmp2/bar/baz/qux" }),
    );

    expect(screen.getByText("deep.txt")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Toggle tmp2" }));
    expect(screen.queryByText("deep.txt")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Toggle tmp2" }));

    expect(
      screen.getByRole("button", { name: "Toggle tmp2/bar/baz/qux" }),
    ).toBeVisible();
    expect(screen.getByText("deep.txt")).toBeInTheDocument();
  });

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

  it("preserves section collapse state when the panel is temporarily closed", async () => {
    function Harness() {
      const [actions, setActions] = useState<ReactNode>(null);
      const [open, setOpen] = useState(true);

      return (
        <SidebarProvider defaultOpen>
          <div>{actions}</div>
          <button type="button" onClick={() => setOpen((value) => !value)}>
            Toggle open
          </button>
          <div className="h-96">
            <WorktreeGitStatusPanel
              worktree={makeWorktree()}
              open={open}
              onActionsChange={setActions}
            />
          </div>
        </SidebarProvider>
      );
    }

    render(<Harness />);

    const stagedHeader = await screen.findByRole("button", { name: "Staged" });
    fireEvent.click(stagedHeader);
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Toggle open" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle open" }));

    expect(await screen.findByRole("button", { name: "Staged" })).toBeVisible();
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
  });
});
