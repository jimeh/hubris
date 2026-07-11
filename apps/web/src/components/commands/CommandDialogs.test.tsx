// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CommandDialogs from "./CommandDialogs";
import { resetBootstrapForTests } from "@/lib/bootstrap";
import { useCommandUiStore } from "@/lib/stores/commandUi";
import { useFileEditorStore } from "@/lib/stores/fileEditorTabs";
import { useGitDiffStore } from "@/lib/stores/gitDiffTabs";
import { useProjectStore } from "@/lib/stores/projects";
import { useTabStore } from "@/lib/stores/tabs";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import { normalizedTabState } from "@/test/tabs";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock("@/components/AddProjectDialog", () => ({ default: () => null }));
vi.mock("@/components/AddWorktreeDialog", () => ({
  default: ({
    onAdd,
    onImport,
  }: {
    onAdd: (
      branch: string,
      startPoint?: string,
      sourceRef?: string,
    ) => Promise<void>;
    onImport: (path: string) => Promise<void>;
  }) => (
    <div>
      <button onClick={() => void onAdd("feature")}>Create worktree</button>
      <button onClick={() => void onImport("/tmp/imported")}>
        Import worktree
      </button>
    </div>
  ),
}));
vi.mock("@/components/ConfirmDialog", () => ({ default: () => null }));
vi.mock("@/components/ProjectRemoveDialog", () => ({ default: () => null }));
vi.mock("@/components/RenameProjectDialog", () => ({ default: () => null }));
vi.mock("@/components/SettingsDialog", () => ({ default: () => null }));
vi.mock("@/components/WorktreeRemoveDialog", () => ({
  default: ({
    onDeleteFromDisk,
    onUntrackOnly,
  }: {
    onDeleteFromDisk: () => void;
    onUntrackOnly: () => void;
  }) => (
    <div>
      <button onClick={onDeleteFromDisk}>Delete from disk</button>
      <button onClick={onUntrackOnly}>Untrack only</button>
    </div>
  ),
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open: boolean;
  }) => (open ? <div>{children}</div> : null),
  AlertDialogAction: ({
    children,
    disabled,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: (event: { preventDefault: () => void }) => void;
  }) => (
    <button
      disabled={disabled}
      onClick={() => {
        if (!disabled) {
          onClick?.({ preventDefault: () => {} });
        }
      }}
    >
      {children}
    </button>
  ),
  AlertDialogCancel: ({
    children,
    disabled,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
  }) => <button disabled={disabled}>{children}</button>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeProject() {
  return {
    id: "p1",
    name: "Devbox",
    path: "/tmp/devbox",
    position: 1,
  };
}

function makeWorktree() {
  return {
    id: "w1",
    project_id: "p1",
    name: "local",
    path: "/tmp/devbox",
    branch: "main",
    source_ref: null,
    ui_mode: "hubris" as const,
    is_local: true,
    missing_on_disk: false,
    position: 1,
  };
}

function makeFileTab(id: string) {
  return {
    id,
    label: "file.ts",
    position: 1,
    worktree_id: "w1",
    pane_id: "pane-1",
    session_id: "default",
    type: "file" as const,
    created_at: 0,
    preview: false,
    path: "src/file.ts",
  };
}

function makeGitDiffTab(id: string) {
  return {
    id,
    label: "README.md",
    position: 1,
    worktree_id: "w1",
    pane_id: "pane-1",
    session_id: "default",
    type: "git_diff" as const,
    created_at: 0,
    preview: false,
    path: "README.md",
    scope: "unstaged" as const,
    original_path: null,
    commit_id: null,
  };
}

describe("CommandDialogs", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBootstrapForTests();
    vi.restoreAllMocks();

    const project = makeProject();
    const worktree = makeWorktree();

    useProjectStore.setState({ projects: [project] });
    useWorktreeStore.setState({
      selectedWorktreeId: worktree.id,
      worktreesByProject: {
        [project.id]: [worktree],
      },
    });
  });

  it("keeps the dirty-close dialog open when saving a file tab fails", async () => {
    const tab = makeFileTab("file-1");
    const closeSpy = vi
      .spyOn(useTabStore.getState(), "close")
      .mockResolvedValue(undefined);
    const saveAttempt = deferred<void>();
    const saveSpy = vi
      .spyOn(useFileEditorStore.getState(), "save")
      .mockReturnValue(saveAttempt.promise);

    useTabStore.setState({
      activeTabId: tab.id,
      ...normalizedTabState([tab]),
    });
    useFileEditorStore.setState({
      sessions: {
        [tab.id]: {
          dirty: true,
          draft: "draft",
          error: null,
          externalChange: false,
          language: "typescript",
          loadStatus: "loaded",
          path: tab.path,
          readOnly: false,
          reloadGeneration: 0,
          saveStatus: "idle",
          savedContent: "saved",
          tabId: tab.id,
          unsupportedReason: null,
          versionToken: "v1",
        },
      },
    });
    useCommandUiStore.setState({
      dialog: { tabId: tab.id, type: "close-dirty-tab" },
    });

    render(<CommandDialogs />);

    expect(
      screen.getByText(`Save changes to ${tab.label}?`),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith("p1", "w1", tab.id);
    });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Don't Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await act(async () => {
      saveAttempt.reject(new Error("save failed"));
      await Promise.resolve();
    });

    expect(closeSpy).not.toHaveBeenCalled();
    expect(
      screen.getByText(`Save changes to ${tab.label}?`),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Don't Save" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("closes a dirty git diff tab after a successful save", async () => {
    const tab = makeGitDiffTab("diff-1");
    const closeSpy = vi
      .spyOn(useTabStore.getState(), "close")
      .mockResolvedValue(undefined);
    const saveAttempt = deferred<void>();
    const saveSpy = vi
      .spyOn(useGitDiffStore.getState(), "save")
      .mockImplementation(async () => {
        await saveAttempt.promise;
        useGitDiffStore.setState((state) => ({
          sessions: {
            ...state.sessions,
            [tab.id]: {
              ...state.sessions[tab.id]!,
              dirty: false,
            },
          },
        }));
      });

    useTabStore.setState({
      activeTabId: tab.id,
      ...normalizedTabState([tab]),
    });
    useGitDiffStore.setState({
      sessions: {
        [tab.id]: {
          dirty: true,
          draft: "draft",
          error: null,
          externalChange: false,
          language: "markdown",
          loadStatus: "loaded",
          modifiedVersionToken: "v1",
          originalContent: "hello\n",
          originalPath: null,
          path: tab.path,
          readOnly: false,
          reloadGeneration: 0,
          saveStatus: "idle",
          savedContent: "saved",
          scope: "unstaged",
          tabId: tab.id,
          unsupportedReason: null,
        },
      },
    });
    useCommandUiStore.setState({
      dialog: { tabId: tab.id, type: "close-dirty-tab" },
    });

    render(<CommandDialogs />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith("p1", "w1", tab.id);
    });

    await act(async () => {
      saveAttempt.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(closeSpy).toHaveBeenCalledWith(tab.id);
    });
  });

  it("shows a searchable project-scoped worktree picker", async () => {
    const alpha = makeProject();
    const beta = {
      ...makeProject(),
      id: "p2",
      name: "Beta",
      path: "/tmp/beta",
      position: 2,
    };
    const local = makeWorktree();
    const feature = {
      ...makeWorktree(),
      id: "w2",
      project_id: beta.id,
      name: "feature-a",
      path: "/tmp/beta-feature-a",
      branch: "feature-a",
      is_local: false,
      position: 1,
    };

    useProjectStore.setState({ projects: [alpha, beta] });
    useWorktreeStore.setState({
      selectedWorktreeId: local.id,
      worktreesByProject: {
        [alpha.id]: [local],
        [beta.id]: [feature],
      },
    });
    useCommandUiStore.setState({
      dialog: { type: "select-worktree" },
    });

    render(<CommandDialogs />);

    expect(
      screen.getByPlaceholderText("Switch worktree..."),
    ).toBeInTheDocument();
    expect(screen.getByText("Beta • feature-a")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Switch worktree..."), {
      target: { value: "beta feature" },
    });
    fireEvent.click(
      within(screen.getByText("feature-a").closest("[cmdk-item]")!).getByText(
        "feature-a",
      ),
    );

    await waitFor(() => {
      expect(useWorktreeStore.getState().selectedWorktreeId).toBe(feature.id);
    });
    expect(useCommandUiStore.getState().dialog).toBeNull();
  });

  it("does not allow cancel or discard to race a pending save", async () => {
    const tab = makeFileTab("file-race");
    const closeSpy = vi
      .spyOn(useTabStore.getState(), "close")
      .mockResolvedValue(undefined);
    const saveAttempt = deferred<void>();
    const saveSpy = vi
      .spyOn(useFileEditorStore.getState(), "save")
      .mockImplementation(async () => {
        await saveAttempt.promise;
        useFileEditorStore.setState((state) => ({
          sessions: {
            ...state.sessions,
            [tab.id]: {
              ...state.sessions[tab.id]!,
              dirty: false,
            },
          },
        }));
      });

    useTabStore.setState({
      activeTabId: tab.id,
      ...normalizedTabState([tab]),
    });
    useFileEditorStore.setState({
      sessions: {
        [tab.id]: {
          dirty: true,
          draft: "draft",
          error: null,
          externalChange: false,
          language: "typescript",
          loadStatus: "loaded",
          path: tab.path,
          readOnly: false,
          reloadGeneration: 0,
          saveStatus: "idle",
          savedContent: "saved",
          tabId: tab.id,
          unsupportedReason: null,
          versionToken: "v1",
        },
      },
    });
    useCommandUiStore.setState({
      dialog: { tabId: tab.id, type: "close-dirty-tab" },
    });

    render(<CommandDialogs />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith("p1", "w1", tab.id);
    });
    closeSpy.mockClear();

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    const discardButton = screen.getByRole("button", { name: "Don't Save" });

    expect(cancelButton).toBeDisabled();
    expect(discardButton).toBeDisabled();

    fireEvent.click(cancelButton);
    fireEvent.click(discardButton);
    expect(closeSpy).not.toHaveBeenCalled();

    await act(async () => {
      saveAttempt.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledWith(tab.id);
    });
  });

  it("does not allow duplicate discard actions while a dirty close is pending", async () => {
    const tab = makeFileTab("file-discard");
    const closeAttempt = deferred<void>();
    const closeSpy = vi
      .spyOn(useTabStore.getState(), "close")
      .mockImplementation(async () => {
        await closeAttempt.promise;
      });

    useTabStore.setState({
      activeTabId: tab.id,
      ...normalizedTabState([tab]),
    });
    useFileEditorStore.setState({
      sessions: {
        [tab.id]: {
          dirty: true,
          draft: "draft",
          error: null,
          externalChange: false,
          language: "typescript",
          loadStatus: "loaded",
          path: tab.path,
          readOnly: false,
          reloadGeneration: 0,
          saveStatus: "idle",
          savedContent: "saved",
          tabId: tab.id,
          unsupportedReason: null,
          versionToken: "v1",
        },
      },
    });
    useCommandUiStore.setState({
      dialog: { tabId: tab.id, type: "close-dirty-tab" },
    });

    render(<CommandDialogs />);

    fireEvent.click(screen.getByRole("button", { name: "Don't Save" }));

    await waitFor(() => {
      expect(closeSpy).toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalledWith(tab.id);
    });

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    const discardButton = screen.getByRole("button", { name: "Don't Save" });
    const saveButton = screen.getByRole("button", { name: "Save" });
    const pendingCallCount = closeSpy.mock.calls.length;

    expect(cancelButton).toBeDisabled();
    expect(discardButton).toBeDisabled();
    expect(saveButton).toBeDisabled();

    fireEvent.click(discardButton);
    expect(closeSpy).toHaveBeenCalledTimes(pendingCallCount);

    await act(async () => {
      closeAttempt.resolve();
      await Promise.resolve();
    });
  });

  it("passes explicit delete args when removing a worktree from disk", async () => {
    const project = makeProject();
    const worktree = makeWorktree();
    const removeSpy = vi
      .spyOn(useWorktreeStore.getState(), "remove")
      .mockResolvedValue(undefined);

    useCommandUiStore.setState({
      dialog: {
        projectId: project.id,
        type: "remove-worktree",
        worktreeId: worktree.id,
      },
    });

    render(<CommandDialogs />);

    fireEvent.click(screen.getByRole("button", { name: "Delete from disk" }));

    await waitFor(() => {
      expect(removeSpy).toHaveBeenCalledWith(
        project.id,
        worktree.id,
        false,
        undefined,
      );
    });
  });

  it("routes worktree imports through the command runtime", async () => {
    const project = makeProject();
    const importedWorktree = {
      ...makeWorktree(),
      id: "w-imported",
      is_local: false,
      path: "/tmp/imported",
    };
    const importSpy = vi
      .spyOn(useWorktreeStore.getState(), "importWorktree")
      .mockResolvedValue(importedWorktree);

    useCommandUiStore.setState({
      dialog: {
        projectId: project.id,
        type: "add-worktree",
      },
    });

    render(<CommandDialogs />);

    fireEvent.click(screen.getByRole("button", { name: "Import worktree" }));

    await waitFor(() => {
      expect(importSpy).toHaveBeenCalledWith(project.id, "/tmp/imported");
    });
    expect(useCommandUiStore.getState().dialog).toBeNull();
  });

  it("clears stale worktree dialog intents when the worktree no longer exists", async () => {
    const project = makeProject();

    useCommandUiStore.setState({
      dialog: {
        projectId: project.id,
        type: "remove-worktree",
        worktreeId: "missing-worktree",
      },
    });

    render(<CommandDialogs />);

    await waitFor(() => {
      expect(useCommandUiStore.getState().dialog).toBeNull();
    });
  });

  it("clears stale tab dialog intents when the tab no longer exists", async () => {
    useCommandUiStore.setState({
      dialog: {
        tabId: "missing-tab",
        type: "close-dirty-tab",
      },
    });

    render(<CommandDialogs />);

    await waitFor(() => {
      expect(useCommandUiStore.getState().dialog).toBeNull();
    });
  });
});
