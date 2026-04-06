// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GitDiffTab from "./GitDiffTab";
import type { GitDiffSession } from "@/lib/stores/gitDiffTabs";
import type { GitDiffTab as GitDiffTabType } from "@/lib/types";

const ensureLoaded = vi.fn();
const updateDraft = vi.fn();
const save = vi.fn().mockResolvedValue(undefined);
const reload = vi.fn();
const clearExternalChange = vi.fn();
const pin = vi.fn();

const editableSession: GitDiffSession = {
  tabId: "diff-1",
  path: "README.md",
  originalPath: null,
  scope: "unstaged" as const,
  originalContent: "hello\n",
  draft: "hello world\n",
  savedContent: "hello\n",
  modifiedVersionToken: "v1",
  language: "markdown",
  readOnly: false,
  unsupportedReason: null,
  dirty: true,
  externalChange: false,
  loadStatus: "loaded" as const,
  saveStatus: "idle" as const,
  reloadGeneration: 0,
  error: null,
};

const sessionState: { session: GitDiffSession } = {
  session: editableSession,
};

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: () => <div data-testid="diff-editor" />,
}));

vi.mock("@/lib/monaco", () => ({
  applyMonacoTheme: vi.fn(),
  getGitDiffModelPaths: () => ({
    original: "inmemory://orig",
    modified: "inmemory://mod",
  }),
}));

vi.mock("@/lib/stores/gitDiffTabs", () => ({
  useGitDiffStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: { "diff-1": sessionState.session },
      ensureLoaded,
      updateDraft,
      save,
      reload,
      clearExternalChange,
    }),
}));

vi.mock("@/lib/stores/tabs", () => ({
  useTabStore: (selector: (state: unknown) => unknown) =>
    selector({
      pin,
    }),
}));

vi.mock("@/lib/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({ activeTheme: "hubris" }),
  },
}));

vi.mock("@/lib/stores/terminal", () => ({
  useTerminalSettings: (selector: (state: unknown) => unknown) =>
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
    commit_id: null,
    ...overrides,
  };
}

describe("GitDiffTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.session = editableSession;
  });

  it("shows a save footer for editable unstaged diffs", () => {
    render(
      <GitDiffTab projectId="p1" worktreeId="w1" tab={makeTab()} visible />,
    );

    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith("p1", "w1", "diff-1");
  });

  it("shows backend denied-path messages verbatim", () => {
    sessionState.session = {
      ...editableSession,
      loadStatus: "error",
      error:
        "This path resolves outside the allowed roots. Only files inside this worktree or symlinks into the repository root can be opened.",
    };

    render(
      <GitDiffTab projectId="p1" worktreeId="w1" tab={makeTab()} visible />,
    );

    expect(
      screen.getByText(/resolves outside the allowed roots/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("hides save controls for read-only commit diffs", () => {
    sessionState.session = {
      ...editableSession,
      scope: "commit",
      readOnly: true,
      dirty: false,
      saveStatus: "idle",
    };

    render(
      <GitDiffTab
        projectId="p1"
        worktreeId="w1"
        tab={makeTab({ scope: "commit", commit_id: "abcdef123456" })}
        visible
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  });
});
