// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMobile } from "@/test/mobile";
import type { FileTab, TerminalTab, Worktree } from "@/lib/types";

const terminalRenderSpy = vi.fn<(tabId: string) => void>();

vi.mock("@/components/TabBar", () => ({
  default: ({
    tabs,
    onClose,
  }: {
    tabs: Array<{ id: string }>;
    onClose: (tabId: string) => void;
  }) => (
    <div>
      {tabs.map((tab) => (
        <button key={tab.id} onClick={() => onClose(tab.id)}>
          Close {tab.id}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/components/WorktreeGitStatusPanel", () => ({
  default: () => <div>Git panel</div>,
}));

vi.mock("@/components/WorktreeAllFilesPanel", () => ({
  default: () => <div>Files panel</div>,
}));

vi.mock("@/components/TerminalTab", async () => {
  const { memo } = await vi.importActual<typeof import("react")>("react");

  return {
    default: memo(function MockTerminalTab({
      tabId,
      visible,
    }: {
      tabId: string;
      visible: boolean;
      onClosed?: (tabId: string) => void;
    }) {
      terminalRenderSpy(tabId);
      return <div data-tab-id={tabId} data-visible={visible} />;
    }),
  };
});

vi.mock("@/components/FileEditorTab", () => ({
  default: () => <div>File editor</div>,
}));

vi.mock("@/components/GitDiffTab", () => ({
  default: () => <div>Git diff</div>,
}));

function getTerminalRenderCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [tabId] of terminalRenderSpy.mock.calls) {
    counts[tabId] = (counts[tabId] ?? 0) + 1;
  }
  return counts;
}

function makeWorktree(): Worktree {
  return {
    id: "w1",
    project_id: "p1",
    name: "local",
    path: "/tmp/devbox",
    branch: "main",
    source_ref: null,
    is_local: true,
    missing_on_disk: false,
    position: 1,
  };
}

function makeTab(
  id: string,
  worktreeId: string,
  overrides: Partial<TerminalTab> = {},
): TerminalTab {
  return {
    id,
    label: `Tab ${id.toUpperCase()}`,
    position: overrides.position ?? 1,
    worktree_id: worktreeId,
    session_id: overrides.session_id ?? "default",
    type: overrides.type ?? "terminal",
    created_at: overrides.created_at ?? 0,
    preview: overrides.preview ?? false,
  };
}

function makeFileTab(
  id: string,
  worktreeId: string,
  overrides: Partial<FileTab> = {},
): FileTab {
  const path = overrides.path ?? "src/file.ts";
  return {
    id,
    label: path.split("/").filter(Boolean).at(-1) ?? path,
    position: overrides.position ?? 1,
    worktree_id: worktreeId,
    session_id: overrides.session_id ?? "default",
    type: "file",
    created_at: overrides.created_at ?? 0,
    preview: overrides.preview ?? false,
    path,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("WorktreeView", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    terminalRenderSpy.mockClear();
    localStorage.clear();
    setMobile(false);

    const { resetTabStoreForTests, useTabStore } =
      await import("@/lib/stores/tabs");
    const {
      initializeWorktreeRightSidebarStore,
      resetWorktreeRightSidebarStoreForTests,
    } = await import("@/lib/stores/worktreeRightSidebar");
    const { resetFileEditorStoreForTests } =
      await import("@/lib/stores/fileEditorTabs");
    const { resetWorktreeRightSidebarWidthStoreForTests } =
      await import("@/lib/stores/worktreeRightSidebarWidth");
    resetTabStoreForTests();
    resetFileEditorStoreForTests();
    resetWorktreeRightSidebarStoreForTests();
    resetWorktreeRightSidebarWidthStoreForTests();
    initializeWorktreeRightSidebarStore();
    useTabStore.setState({
      tabs: [],
      activeTabId: null,
      activeTabByWorktree: {},
    });
  });

  it("does not rerender terminal tabs when sibling tabs are added", async () => {
    const { useTabStore } = await import("@/lib/stores/tabs");
    const { default: WorktreeView } = await import("./WorktreeView");
    const worktree = makeWorktree();

    useTabStore.setState({
      tabs: [
        makeTab("a", worktree.id, { position: 1 }),
        makeTab("b", worktree.id, { position: 2 }),
      ],
      activeTabId: "a",
      activeTabByWorktree: { [worktree.id]: "a" },
    });

    render(<WorktreeView worktree={worktree} />);

    expect(getTerminalRenderCounts()).toEqual({ a: 1, b: 1 });

    act(() => {
      useTabStore.setState((state) => ({
        tabs: [...state.tabs, makeTab("c", worktree.id, { position: 3 })],
      }));
    });

    expect(getTerminalRenderCounts()).toEqual({ a: 1, b: 1, c: 1 });
  });

  it("does not rerender when tabs change in another worktree", async () => {
    const { useTabStore } = await import("@/lib/stores/tabs");
    const { default: WorktreeView } = await import("./WorktreeView");
    const worktree = makeWorktree();

    useTabStore.setState({
      tabs: [
        makeTab("a", worktree.id, { position: 1 }),
        makeTab("x", "w2", { position: 1 }),
      ],
      activeTabId: "a",
      activeTabByWorktree: { [worktree.id]: "a", w2: "x" },
    });

    render(<WorktreeView worktree={worktree} />);

    expect(getTerminalRenderCounts()).toEqual({ a: 1 });

    act(() => {
      useTabStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "x" ? { ...tab, label: "Renamed X" } : tab,
        ),
      }));
    });

    expect(getTerminalRenderCounts()).toEqual({ a: 1 });
  });

  it("does not rerender terminal tabs when worktree tabs reorder", async () => {
    const { useTabStore } = await import("@/lib/stores/tabs");
    const { default: WorktreeView } = await import("./WorktreeView");
    const worktree = makeWorktree();

    useTabStore.setState({
      tabs: [
        makeTab("a", worktree.id, { position: 1, created_at: 1 }),
        makeTab("b", worktree.id, { position: 2, created_at: 2 }),
      ],
      activeTabId: "a",
      activeTabByWorktree: { [worktree.id]: "a" },
    });

    render(<WorktreeView worktree={worktree} />);

    expect(getTerminalRenderCounts()).toEqual({ a: 1, b: 1 });

    act(() => {
      useTabStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "a"
            ? { ...tab, position: 2 }
            : tab.id === "b"
              ? { ...tab, position: 1 }
              : tab,
        ),
      }));
    });

    expect(getTerminalRenderCounts()).toEqual({ a: 1, b: 1 });
  });

  it("updates right sidebar width without rerendering terminal tabs", async () => {
    const { default: WorktreeView } = await import("./WorktreeView");
    const worktree = makeWorktree();
    const { useTabStore } = await import("@/lib/stores/tabs");
    const { useWorktreeRightSidebarStore } =
      await import("@/lib/stores/worktreeRightSidebar");
    const { useWorktreeRightSidebarWidthStore } =
      await import("@/lib/stores/worktreeRightSidebarWidth");

    useTabStore.setState({
      tabs: [makeTab("a", worktree.id, { position: 1 })],
      activeTabId: "a",
      activeTabByWorktree: { [worktree.id]: "a" },
    });

    render(<WorktreeView worktree={worktree} />);
    expect(getTerminalRenderCounts()).toEqual({ a: 1 });
    expect(screen.getByText("Files panel")).toBeInTheDocument();

    const viewRoot = document.querySelector<HTMLElement>(
      "[data-worktree-view]",
    );
    expect(
      viewRoot?.style.getPropertyValue("--worktree-right-sidebar-width"),
    ).toBe("320px");

    const host = document.querySelector<HTMLElement>(
      "[data-worktree-right-sidebar-wrapper]",
    );
    expect(host).not.toBeNull();
    expect(host?.style.getPropertyValue("--worktree-right-sidebar-width")).toBe(
      "",
    );

    act(() => {
      useWorktreeRightSidebarWidthStore.getState().setWidth(412);
    });

    expect(
      viewRoot?.style.getPropertyValue("--worktree-right-sidebar-width"),
    ).toBe("412px");
    expect(host?.style.getPropertyValue("--worktree-right-sidebar-width")).toBe(
      "",
    );
    expect(getTerminalRenderCounts()).toEqual({ a: 1 });

    const resizeHandle = await screen.findByRole("button", {
      name: "Resize right sidebar",
    });

    fireEvent.keyDown(resizeHandle, { key: "ArrowLeft" });

    expect(
      viewRoot?.style.getPropertyValue("--worktree-right-sidebar-width"),
    ).toBe("428px");
    expect(getTerminalRenderCounts()).toEqual({ a: 1 });

    Object.defineProperty(resizeHandle, "setPointerCapture", {
      value: vi.fn(),
      configurable: true,
    });
    Object.defineProperty(resizeHandle, "releasePointerCapture", {
      value: vi.fn(),
      configurable: true,
    });
    Object.defineProperty(resizeHandle, "hasPointerCapture", {
      value: vi.fn(() => true),
      configurable: true,
    });

    fireEvent.pointerDown(resizeHandle, {
      button: 0,
      pointerId: 1,
      clientX: 900,
    });
    fireEvent.pointerMove(resizeHandle, {
      pointerId: 1,
      clientX: 860,
    });
    await act(async () => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => resolve(null)),
      );
    });
    fireEvent.pointerUp(resizeHandle, {
      pointerId: 1,
      clientX: 860,
    });

    expect(
      viewRoot?.style.getPropertyValue("--worktree-right-sidebar-width"),
    ).toBe("468px");
    expect(getTerminalRenderCounts()).toEqual({ a: 1 });

    act(() => {
      setMobile(true);
    });
    expect(
      screen.queryByRole("button", { name: "Resize right sidebar" }),
    ).not.toBeInTheDocument();

    act(() => {
      setMobile(false);
    });

    const resizeHandleAfterViewportReset = await screen.findByRole("button", {
      name: "Resize right sidebar",
    });

    expect(
      viewRoot?.style.getPropertyValue("--worktree-right-sidebar-width"),
    ).toBe("468px");

    fireEvent.keyDown(resizeHandleAfterViewportReset, { key: "ArrowLeft" });

    expect(
      viewRoot?.style.getPropertyValue("--worktree-right-sidebar-width"),
    ).toBe("484px");
    expect(getTerminalRenderCounts()).toEqual({ a: 1 });

    act(() => {
      useWorktreeRightSidebarStore.getState().toggleDesktop();
    });
    const sidebarWrapper = document.querySelector<HTMLElement>(
      "[data-worktree-right-sidebar-wrapper]",
    );
    const sidebarPanel = document.querySelector<HTMLElement>(
      "[data-worktree-right-sidebar-panel]",
    );
    expect(sidebarWrapper?.dataset.state).toBe("closed");
    expect(sidebarPanel).toHaveAttribute("aria-hidden", "true");
    expect(getTerminalRenderCounts()).toEqual({ a: 1 });

    act(() => {
      useWorktreeRightSidebarStore.getState().toggleDesktop();
    });

    expect(sidebarWrapper?.dataset.state).toBe("open");
    expect(sidebarPanel).toHaveAttribute("aria-hidden", "false");
    expect(
      viewRoot?.style.getPropertyValue("--worktree-right-sidebar-width"),
    ).toBe("484px");
    expect(getTerminalRenderCounts()).toEqual({ a: 1 });
  });

  it("does not rerender terminal tabs when file editor sessions change", async () => {
    const { default: WorktreeView } = await import("./WorktreeView");
    const { useTabStore } = await import("@/lib/stores/tabs");
    const { useFileEditorStore } = await import("@/lib/stores/fileEditorTabs");
    const worktree = makeWorktree();

    useTabStore.setState({
      tabs: [makeTab("a", worktree.id, { position: 1 })],
      activeTabId: "a",
      activeTabByWorktree: { [worktree.id]: "a" },
    });

    render(<WorktreeView worktree={worktree} />);
    expect(getTerminalRenderCounts()).toEqual({ a: 1 });

    act(() => {
      useFileEditorStore.setState({
        sessions: {
          "file-1": {
            tabId: "file-1",
            path: "src/file.ts",
            draft: "draft",
            savedContent: "draft",
            versionToken: "v1",
            language: "typescript",
            readOnly: false,
            unsupportedReason: null,
            dirty: false,
            externalChange: true,
            loadStatus: "loaded",
            saveStatus: "idle",
            error: null,
          },
        },
      });
    });

    expect(getTerminalRenderCounts()).toEqual({ a: 1 });
  });

  it("keeps the save dialog open when saving a dirty file tab fails", async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const saveAttempt = deferred<void>();
    const saveSpy = vi.fn().mockReturnValue(saveAttempt.promise);
    const { default: WorktreeView } = await import("./WorktreeView");
    const { useTabStore } = await import("@/lib/stores/tabs");
    const { useFileEditorStore } = await import("@/lib/stores/fileEditorTabs");
    const worktree = makeWorktree();
    const fileTab = makeFileTab("file-1", worktree.id);

    useTabStore.setState((state) => ({
      ...state,
      tabs: [fileTab],
      activeTabId: fileTab.id,
      activeTabByWorktree: { [worktree.id]: fileTab.id },
      close: closeSpy,
    }));
    useFileEditorStore.setState((state) => ({
      ...state,
      sessions: {
        [fileTab.id]: {
          tabId: fileTab.id,
          path: fileTab.path,
          draft: "draft",
          savedContent: "saved",
          versionToken: "v1",
          language: "typescript",
          readOnly: false,
          unsupportedReason: null,
          dirty: true,
          externalChange: false,
          loadStatus: "loaded",
          saveStatus: "idle",
          error: null,
        },
      },
      save: saveSpy,
    }));

    render(<WorktreeView worktree={worktree} />);

    fireEvent.click(
      screen.getByRole("button", { name: `Close ${fileTab.id}` }),
    );
    expect(
      await screen.findByText(`Save changes to ${fileTab.label}?`),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith(
        worktree.project_id,
        worktree.id,
        fileTab.id,
      );
    });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Don't Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await act(async () => {
      saveAttempt.reject(new Error("save failed"));
      await Promise.resolve();
    });

    expect(closeSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        screen.getByText(`Save changes to ${fileTab.label}?`),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Don't Save" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("closes the dirty file tab after a successful save", async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const saveAttempt = deferred<void>();
    const saveSpy = vi.fn().mockReturnValue(saveAttempt.promise);
    const { default: WorktreeView } = await import("./WorktreeView");
    const { useTabStore } = await import("@/lib/stores/tabs");
    const { useFileEditorStore } = await import("@/lib/stores/fileEditorTabs");
    const worktree = makeWorktree();
    const fileTab = makeFileTab("file-1", worktree.id);

    useTabStore.setState((state) => ({
      ...state,
      tabs: [fileTab],
      activeTabId: fileTab.id,
      activeTabByWorktree: { [worktree.id]: fileTab.id },
      close: closeSpy,
    }));
    useFileEditorStore.setState((state) => ({
      ...state,
      sessions: {
        [fileTab.id]: {
          tabId: fileTab.id,
          path: fileTab.path,
          draft: "draft",
          savedContent: "saved",
          versionToken: "v1",
          language: "typescript",
          readOnly: false,
          unsupportedReason: null,
          dirty: true,
          externalChange: false,
          loadStatus: "loaded",
          saveStatus: "idle",
          error: null,
        },
      },
      save: saveSpy,
    }));

    render(<WorktreeView worktree={worktree} />);

    fireEvent.click(
      screen.getByRole("button", { name: `Close ${fileTab.id}` }),
    );
    expect(
      await screen.findByText(`Save changes to ${fileTab.label}?`),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith(
        worktree.project_id,
        worktree.id,
        fileTab.id,
      );
    });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Don't Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await act(async () => {
      saveAttempt.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(closeSpy).toHaveBeenCalledWith(fileTab.id);
    });
    await waitFor(() => {
      expect(
        screen.queryByText(`Save changes to ${fileTab.label}?`),
      ).not.toBeInTheDocument();
    });
  });

  it("does not allow cancel or discard to race a pending save", async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const saveAttempt = deferred<void>();
    const saveSpy = vi.fn().mockReturnValue(saveAttempt.promise);
    const { default: WorktreeView } = await import("./WorktreeView");
    const { useTabStore } = await import("@/lib/stores/tabs");
    const { useFileEditorStore } = await import("@/lib/stores/fileEditorTabs");
    const worktree = makeWorktree();
    const fileTab = makeFileTab("file-race", worktree.id);

    useTabStore.setState((state) => ({
      ...state,
      tabs: [fileTab],
      activeTabId: fileTab.id,
      activeTabByWorktree: { [worktree.id]: fileTab.id },
      close: closeSpy,
    }));
    useFileEditorStore.setState((state) => ({
      ...state,
      sessions: {
        [fileTab.id]: {
          tabId: fileTab.id,
          path: fileTab.path,
          draft: "draft",
          savedContent: "saved",
          versionToken: "v1",
          language: "typescript",
          readOnly: false,
          unsupportedReason: null,
          dirty: true,
          externalChange: false,
          loadStatus: "loaded",
          saveStatus: "idle",
          error: null,
        },
      },
      save: saveSpy,
    }));

    render(<WorktreeView worktree={worktree} />);

    fireEvent.click(
      screen.getByRole("button", { name: `Close ${fileTab.id}` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith(
        worktree.project_id,
        worktree.id,
        fileTab.id,
      );
    });

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    const discardButton = screen.getByRole("button", { name: "Don't Save" });

    expect(cancelButton).toBeDisabled();
    expect(discardButton).toBeDisabled();

    fireEvent.click(cancelButton);
    fireEvent.click(discardButton);
    expect(closeSpy).not.toHaveBeenCalled();
    expect(
      screen.getByText(`Save changes to ${fileTab.label}?`),
    ).toBeInTheDocument();

    await act(async () => {
      saveAttempt.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledWith(fileTab.id);
    });
  });

  it("uses the current tab store snapshot when deciding whether close needs confirmation", async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const { default: WorktreeView } = await import("./WorktreeView");
    const { useTabStore } = await import("@/lib/stores/tabs");
    const { useFileEditorStore } = await import("@/lib/stores/fileEditorTabs");
    const worktree = makeWorktree();
    const fileTab = makeFileTab("shared-id", worktree.id);

    useTabStore.setState((state) => ({
      ...state,
      tabs: [fileTab],
      activeTabId: fileTab.id,
      activeTabByWorktree: { [worktree.id]: fileTab.id },
      close: closeSpy,
    }));
    useFileEditorStore.setState((state) => ({
      ...state,
      sessions: {
        [fileTab.id]: {
          tabId: fileTab.id,
          path: fileTab.path,
          draft: "draft",
          savedContent: "saved",
          versionToken: "v1",
          language: "typescript",
          readOnly: false,
          unsupportedReason: null,
          dirty: true,
          externalChange: false,
          loadStatus: "loaded",
          saveStatus: "idle",
          error: null,
        },
      },
    }));

    render(<WorktreeView worktree={worktree} />);

    act(() => {
      useTabStore.setState((state) => ({
        ...state,
        tabs: [makeTab(fileTab.id, worktree.id, { position: 1 })],
      }));
    });

    fireEvent.click(
      screen.getByRole("button", { name: `Close ${fileTab.id}` }),
    );

    await waitFor(() => {
      expect(closeSpy).toHaveBeenCalledWith(fileTab.id);
    });
    expect(
      screen.queryByText(`Save changes to ${fileTab.label}?`),
    ).not.toBeInTheDocument();
  });
});
