// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitDiffTab as GitDiffTabType } from "@/lib/types";

const getProjectWorktreeGitDiff = vi.fn();
const getGitDiffModelPaths = vi.fn();
const applyMonacoTheme = vi.fn();

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: ({
    originalModelPath,
    modifiedModelPath,
  }: {
    originalModelPath: string;
    modifiedModelPath: string;
  }) => (
    <div
      data-testid="diff-editor"
      data-modified-model-path={modifiedModelPath}
      data-original-model-path={originalModelPath}
    />
  ),
}));

vi.mock("@/lib/api", () => ({
  getProjectWorktreeGitDiff,
}));

vi.mock("@/lib/monaco", () => ({
  applyMonacoTheme,
  getGitDiffModelPaths,
}));

vi.mock("@/lib/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({ activeTheme: "hubris" }),
  },
}));

vi.mock("@/lib/stores/terminal", () => ({
  useTerminalSettings: (selector: (store: unknown) => unknown) =>
    selector({
      fontFamily: "Iosevka",
      settings: { fontSize: 14 },
    }),
}));

function makeTab(overrides: Partial<GitDiffTabType> = {}): GitDiffTabType {
  return {
    id: "diff-1",
    label: "README.md",
    position: 1,
    worktree_id: "w1",
    session_id: "default",
    type: "git_diff",
    created_at: 0,
    preview: false,
    path: "README.md",
    scope: "unstaged",
    original_path: null,
    ...overrides,
  };
}

describe("GitDiffTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProjectWorktreeGitDiff.mockResolvedValue({
      path: "README.md",
      scope: "unstaged",
      original_path: null,
      left_label: "Index",
      right_label: "Working Tree",
      left_content: "hello\n",
      right_content: "hello world\n",
      language: "markdown",
      read_only: true,
      unsupported_reason: null,
    });
    getGitDiffModelPaths.mockReturnValue({
      original: "inmemory://orig",
      modified: "inmemory://mod",
    });
  });

  it("keeps model path memoization stable when unrelated props change", async () => {
    const { default: GitDiffTab } = await import("./GitDiffTab");
    const tab = makeTab();
    const { rerender } = render(
      <GitDiffTab projectId="p1" worktreeId="w1" tab={tab} />,
    );

    await waitFor(() => {
      expect(getProjectWorktreeGitDiff).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(getGitDiffModelPaths).toHaveBeenCalledTimes(1);
    });

    rerender(<GitDiffTab projectId="p2" worktreeId="w1" tab={{ ...tab }} />);

    await waitFor(() => {
      expect(getProjectWorktreeGitDiff).toHaveBeenCalledTimes(2);
    });
    expect(getGitDiffModelPaths).toHaveBeenCalledTimes(1);
  });

  it("shows backend denied-path messages verbatim", async () => {
    const { default: GitDiffTab } = await import("./GitDiffTab");
    getProjectWorktreeGitDiff.mockRejectedValue(
      new Error(
        "This path resolves outside the allowed roots. Only files inside this worktree or symlinks into the repository root can be opened.",
      ),
    );

    render(<GitDiffTab projectId="p1" worktreeId="w1" tab={makeTab()} />);

    expect(
      await screen.findByText(/resolves outside the allowed roots/i),
    ).toBeInTheDocument();
  });
});
