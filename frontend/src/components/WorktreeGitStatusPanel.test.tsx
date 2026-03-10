// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import {
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
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
      <>
        <div>{actions}</div>
        <div className="h-96">
          {/* height ensures ScrollArea has a real container in tests */}
          <Panel worktree={makeWorktree()} onActionsChange={setActions} />
        </div>
      </>
    );
  }

  return render(<Harness />);
}

let Panel: typeof import("./WorktreeGitStatusPanel").default;

describe("WorktreeGitStatusPanel", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    mockGetProjectWorktreeGitStatus.mockReset();
    mockGetProjectWorktreeGitStatus.mockResolvedValue({
      source_ref: "main",
      unstaged_files: [{ path: "src/app.ts", change_type: "modified" }],
      staged_files: [{ path: "README.md", change_type: "added" }],
      ahead_count: 1,
      ahead_commits: [
        { id: "abcdef123456", short_id: "abcdef1", summary: "Ahead commit" },
      ],
      comparison_available: true,
      comparison_error: null,
    });

    Panel = (await import("./WorktreeGitStatusPanel")).default;
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

  it("renders staged, unstaged, and ahead sections", async () => {
    renderPanel();

    expect(await screen.findByText("Unstaged")).toBeInTheDocument();
    expect(screen.getByText("Staged")).toBeInTheDocument();
    expect(screen.getByText("Ahead of main")).toBeInTheDocument();
    expect(screen.getByText("app.ts")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("Ahead commit")).toBeInTheDocument();
  });
});
