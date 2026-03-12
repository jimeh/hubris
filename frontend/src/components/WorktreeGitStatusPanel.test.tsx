// @vitest-environment jsdom
import { act, fireEvent } from "@testing-library/react";
import {
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorktreeGitStatusPanel from "./WorktreeGitStatusPanel";
import { SidebarProvider } from "@/components/ui/sidebar";
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
  function Harness() {
    const [actions, setActions] = useState<ReactNode>(null);

    return (
      <SidebarProvider defaultOpen>
        <div>{actions}</div>
        <div className="h-96">
          {/* height ensures ScrollArea has a real container in tests */}
          <WorktreeGitStatusPanel
            worktree={makeWorktree()}
            onActionsChange={setActions}
          />
        </div>
      </SidebarProvider>
    );
  }

  return render(<Harness />);
}

describe("WorktreeGitStatusPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    mockGetProjectWorktreeGitStatus.mockReset();
    mockGetProjectWorktreeGitStatus.mockResolvedValue({
      source_ref: "main",
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

    expect(screen.getByText("Unstaged")).toBeInTheDocument();
  });

  it("renders staged, unstaged, and ahead sections", async () => {
    renderPanel();

    expect(await screen.findByText("Unstaged")).toBeInTheDocument();
    expect(screen.getByText("Staged")).toBeInTheDocument();
    expect(screen.getByText("Ahead of main")).toBeInTheDocument();
    expect(screen.getByText("bar.txt")).toBeInTheDocument();
    expect(screen.getAllByText("tmp2/bar").length).toBeGreaterThan(0);
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("Ahead commit")).toBeInTheDocument();
  });

  it("renders copied, renamed, and conflict badges", async () => {
    mockGetProjectWorktreeGitStatus.mockResolvedValueOnce({
      source_ref: "main",
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

  it("uses sticky section headers inside the panel scroll area", async () => {
    renderPanel();

    expect(await screen.findByText("Unstaged")).toBeInTheDocument();

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

    await screen.findByText("Unstaged");

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
});
