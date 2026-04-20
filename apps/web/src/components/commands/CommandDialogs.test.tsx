// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
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

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock("@/components/AddProjectDialog", () => ({ default: () => null }));
vi.mock("@/components/AddWorktreeDialog", () => ({ default: () => null }));
vi.mock("@/components/ConfirmDialog", () => ({ default: () => null }));
vi.mock("@/components/ProjectRemoveDialog", () => ({ default: () => null }));
vi.mock("@/components/RenameProjectDialog", () => ({ default: () => null }));
vi.mock("@/components/SettingsDialog", () => ({ default: () => null }));
vi.mock("@/components/WorktreeRemoveDialog", () => ({ default: () => null }));

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
      onClick={() => onClick?.({ preventDefault: () => {} })}
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
      tabs: [tab],
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
      tabs: [tab],
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
      tabs: [tab],
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
});
