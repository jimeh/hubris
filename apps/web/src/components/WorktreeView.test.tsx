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
import type {
  BrowserTab,
  FileTab,
  GitDiffTab,
  TerminalTab,
  Worktree,
} from "@/lib/types";
import WorktreeView from "./WorktreeView";
import {
  resetFileEditorStoreForTests,
  useFileEditorStore,
} from "@/lib/stores/fileEditorTabs";
import {
  resetGitDiffStoreForTests,
  useGitDiffStore,
} from "@/lib/stores/gitDiffTabs";
import { resetTabStoreForTests, useTabStore } from "@/lib/stores/tabs";
import {
  initializeWorktreeRightSidebarStore,
  resetWorktreeRightSidebarStoreForTests,
  useWorktreeRightSidebarStore,
} from "@/lib/stores/worktreeRightSidebar";
import {
  resetWorktreeRightSidebarWidthStoreForTests,
  useWorktreeRightSidebarWidthStore,
} from "@/lib/stores/worktreeRightSidebarWidth";

const terminalRenderSpy = vi.fn<(tabId: string) => void>();

vi.mock("@/components/TabBar", () => ({
  default: ({
    tabs,
    onClose,
    onAddTerminal,
    onAddBrowser,
  }: {
    tabs: Array<{ id: string }>;
    onClose: (tabId: string) => void;
    onAddTerminal?: () => void;
    onAddBrowser?: () => Promise<void>;
  }) => (
    <div>
      <button onClick={() => onAddTerminal?.()}>Add terminal</button>
      <button onClick={() => void onAddBrowser?.()}>Add browser</button>
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

vi.mock("@/components/BrowserTab", () => ({
  default: ({
    tab,
    visible,
  }: {
    tab: { id: string; url: string };
    visible: boolean;
  }) => (
    <div data-testid={`browser-${tab.id}`} data-visible={visible}>
      {tab.url}
    </div>
  ),
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
    ui_mode: "hubris",
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
    pane_id: overrides.pane_id ?? "pane-1",
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
    pane_id: overrides.pane_id ?? "pane-1",
    session_id: overrides.session_id ?? "default",
    type: "file",
    created_at: overrides.created_at ?? 0,
    preview: overrides.preview ?? false,
    path,
  };
}

function makeGitDiffTab(
  id: string,
  worktreeId: string,
  overrides: Partial<GitDiffTab> = {},
): GitDiffTab {
  const path = overrides.path ?? "src/file.ts";
  return {
    id,
    label: path.split("/").filter(Boolean).at(-1) ?? path,
    position: overrides.position ?? 1,
    worktree_id: worktreeId,
    pane_id: overrides.pane_id ?? "pane-1",
    session_id: overrides.session_id ?? "default",
    type: "git_diff",
    created_at: overrides.created_at ?? 0,
    preview: overrides.preview ?? false,
    path,
    scope: overrides.scope ?? "unstaged",
    original_path: overrides.original_path ?? null,
  };
}

function makeBrowserTab(
  id: string,
  worktreeId: string,
  overrides: Partial<BrowserTab> = {},
): BrowserTab {
  return {
    id,
    label: overrides.label ?? "localhost",
    position: overrides.position ?? 1,
    worktree_id: worktreeId,
    pane_id: overrides.pane_id ?? "pane-1",
    session_id: overrides.session_id ?? "default",
    type: "browser",
    created_at: overrides.created_at ?? 0,
    preview: overrides.preview ?? false,
    url: overrides.url ?? "http://localhost:3000/",
    history: overrides.history ?? [overrides.url ?? "http://localhost:3000/"],
    history_index: overrides.history_index ?? 0,
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

function makeSplitLayout() {
  return {
    rootId: "split-root",
    nodes: [
      { type: "leaf" as const, id: "leaf-a", pane_id: "pane-1" },
      { type: "leaf" as const, id: "leaf-b", pane_id: "pane-2" },
      {
        type: "split" as const,
        id: "split-root",
        axis: "vertical" as const,
        ratio: 0.5,
        first_id: "leaf-a",
        second_id: "leaf-b",
      },
    ],
  };
}

describe("WorktreeView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1200,
        bottom: 800,
        width: 1200,
        height: 800,
        toJSON: () => ({}),
      }),
    );
    terminalRenderSpy.mockClear();
    localStorage.clear();
    setMobile(false);
    resetTabStoreForTests();
    resetFileEditorStoreForTests();
    resetGitDiffStoreForTests();
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
    const worktree = makeWorktree();

    useTabStore.setState({
      tabs: [
        makeTab("a", worktree.id, { position: 1 }),
        makeTab("b", worktree.id, { position: 2 }),
      ],
      activeTabId: "a",
      activeTabByWorktree: { [worktree.id]: "a" },
    });

    render(<WorktreeView worktree={worktree} active />);

    expect(getTerminalRenderCounts()).toEqual({ a: 2, b: 1 });

    act(() => {
      useTabStore.setState((state) => ({
        tabs: [...state.tabs, makeTab("c", worktree.id, { position: 3 })],
      }));
    });

    expect(getTerminalRenderCounts()).toEqual({ a: 2, b: 1, c: 1 });
  });

  it("shows empty-state copy for the separate terminal and browser buttons", () => {
    const worktree = makeWorktree();

    render(<WorktreeView worktree={worktree} active />);

    expect(
      screen.getByText(
        "Use the terminal or browser buttons to open a tab, or select a file to preview.",
      ),
    ).toBeInTheDocument();
  });

  it("does not rerender when tabs change in another worktree", async () => {
    const worktree = makeWorktree();

    useTabStore.setState({
      tabs: [
        makeTab("a", worktree.id, { position: 1 }),
        makeTab("x", "w2", { position: 1 }),
      ],
      activeTabId: "a",
      activeTabByWorktree: { [worktree.id]: "a", w2: "x" },
    });

    render(<WorktreeView worktree={worktree} active />);

    expect(getTerminalRenderCounts()).toEqual({ a: 2 });

    act(() => {
      useTabStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "x" ? { ...tab, label: "Renamed X" } : tab,
        ),
      }));
    });

    expect(getTerminalRenderCounts()).toEqual({ a: 2 });
  });

  it("does not rerender terminal tabs when worktree tabs reorder", async () => {
    const worktree = makeWorktree();

    useTabStore.setState({
      tabs: [
        makeTab("a", worktree.id, { position: 1, created_at: 1 }),
        makeTab("b", worktree.id, { position: 2, created_at: 2 }),
      ],
      activeTabId: "a",
      activeTabByWorktree: { [worktree.id]: "a" },
    });

    render(<WorktreeView worktree={worktree} active />);

    expect(getTerminalRenderCounts()).toEqual({ a: 2, b: 1 });

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

    expect(getTerminalRenderCounts()).toEqual({ a: 2, b: 1 });
  });

  it("updates right sidebar width without rerendering terminal tabs", async () => {
    const worktree = makeWorktree();

    useTabStore.setState({
      tabs: [makeTab("a", worktree.id, { position: 1 })],
      activeTabId: "a",
      activeTabByWorktree: { [worktree.id]: "a" },
    });

    render(<WorktreeView worktree={worktree} active />);
    expect(getTerminalRenderCounts()).toEqual({ a: 2 });
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
    expect(getTerminalRenderCounts()).toEqual({ a: 2 });

    const resizeHandle = await screen.findByRole("button", {
      name: "Resize right sidebar",
    });

    fireEvent.keyDown(resizeHandle, { key: "ArrowLeft" });

    expect(
      viewRoot?.style.getPropertyValue("--worktree-right-sidebar-width"),
    ).toBe("428px");
    expect(getTerminalRenderCounts()).toEqual({ a: 2 });

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
    expect(getTerminalRenderCounts()).toEqual({ a: 2 });

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
    expect(getTerminalRenderCounts()).toEqual({ a: 2 });

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
    expect(getTerminalRenderCounts()).toEqual({ a: 2 });

    act(() => {
      useWorktreeRightSidebarStore.getState().toggleDesktop();
    });

    expect(sidebarWrapper?.dataset.state).toBe("open");
    expect(sidebarPanel).toHaveAttribute("aria-hidden", "false");
    expect(
      viewRoot?.style.getPropertyValue("--worktree-right-sidebar-width"),
    ).toBe("484px");
    expect(getTerminalRenderCounts()).toEqual({ a: 2 });
  });

  it("renders the right sidebar in hubris mode", async () => {
    render(<WorktreeView worktree={makeWorktree()} active />);

    expect(
      screen.getByRole("button", { name: "Resize right sidebar" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Files panel")).toBeInTheDocument();
  });

  it("does not rerender terminal tabs when file editor sessions change", async () => {
    const worktree = makeWorktree();

    useTabStore.setState({
      tabs: [makeTab("a", worktree.id, { position: 1 })],
      activeTabId: "a",
      activeTabByWorktree: { [worktree.id]: "a" },
    });

    render(<WorktreeView worktree={worktree} active />);
    expect(getTerminalRenderCounts()).toEqual({ a: 2 });

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
            reloadGeneration: 0,
            error: null,
          },
        },
      });
    });

    expect(getTerminalRenderCounts()).toEqual({ a: 2 });
  });

  it("keeps browser panes mounted and switches visibility with the active tab", () => {
    const worktree = makeWorktree();
    const browserA = makeBrowserTab("browser-a", worktree.id, {
      position: 1,
      url: "http://localhost:3000/",
    });
    const browserB = makeBrowserTab("browser-b", worktree.id, {
      position: 2,
      url: "https://example.com/docs",
    });

    useTabStore.setState({
      tabs: [browserA, browserB],
      activeTabId: browserA.id,
      activeTabByWorktree: { [worktree.id]: browserA.id },
    });

    render(<WorktreeView worktree={worktree} active />);

    expect(screen.getByTestId("browser-browser-a")).toHaveAttribute(
      "data-visible",
      "true",
    );
    expect(screen.getByTestId("browser-browser-b")).toHaveAttribute(
      "data-visible",
      "false",
    );

    act(() => {
      useTabStore.getState().activate(browserB.id);
    });

    expect(screen.getByTestId("browser-browser-a")).toHaveAttribute(
      "data-visible",
      "false",
    );
    expect(screen.getByTestId("browser-browser-b")).toHaveAttribute(
      "data-visible",
      "true",
    );
  });

  it("renders active scenes in both panes of a split layout", () => {
    const worktree = makeWorktree();
    const terminalTab = makeTab("terminal-a", worktree.id, {
      pane_id: "pane-1",
      position: 1,
    });
    const browserTab = makeBrowserTab("browser-b", worktree.id, {
      pane_id: "pane-2",
      position: 1,
      url: "https://example.com/docs",
    });

    useTabStore.setState({
      tabs: [terminalTab, browserTab],
      layoutsByWorktree: { [worktree.id]: makeSplitLayout() },
      activeTabId: terminalTab.id,
      activeTabByWorktree: { [worktree.id]: terminalTab.id },
      activeTabByPane: {
        "pane-1": terminalTab.id,
        "pane-2": browserTab.id,
      },
      focusedPaneByWorktree: { [worktree.id]: "pane-1" },
    });

    render(<WorktreeView worktree={worktree} active />);

    expect(screen.getByTestId("browser-browser-b")).toHaveAttribute(
      "data-visible",
      "true",
    );
    expect(screen.getByTestId("browser-browser-b")).toBeInTheDocument();
    expect(
      document.querySelector('[data-tab-id="terminal-a"]'),
    ).toHaveAttribute("data-visible", "true");
  });

  it("focuses a pane when clicking inside its terminal scene", () => {
    const worktree = makeWorktree();
    const leftTab = makeTab("terminal-a", worktree.id, {
      pane_id: "pane-1",
      position: 1,
    });
    const rightTab = makeTab("terminal-b", worktree.id, {
      pane_id: "pane-2",
      position: 1,
    });

    useTabStore.setState({
      tabs: [leftTab, rightTab],
      layoutsByWorktree: { [worktree.id]: makeSplitLayout() },
      activeTabId: leftTab.id,
      activeTabByWorktree: { [worktree.id]: leftTab.id },
      activeTabByPane: {
        "pane-1": leftTab.id,
        "pane-2": rightTab.id,
      },
      focusedPaneByWorktree: { [worktree.id]: "pane-1" },
    });

    render(<WorktreeView worktree={worktree} active />);

    fireEvent.mouseDown(document.querySelector('[data-tab-id="terminal-b"]')!);

    expect(useTabStore.getState().focusedPaneByWorktree[worktree.id]).toBe(
      "pane-2",
    );
  });

  it("renders horizontal split handles as a 1px line with external hit margins", () => {
    const worktree = makeWorktree();
    const topTab = makeTab("terminal-a", worktree.id, {
      pane_id: "pane-1",
      position: 1,
    });
    const bottomTab = makeTab("terminal-b", worktree.id, {
      pane_id: "pane-2",
      position: 1,
    });

    useTabStore.setState({
      tabs: [topTab, bottomTab],
      layoutsByWorktree: { [worktree.id]: makeSplitLayout() },
      activeTabId: topTab.id,
      activeTabByWorktree: { [worktree.id]: topTab.id },
      activeTabByPane: {
        "pane-1": topTab.id,
        "pane-2": bottomTab.id,
      },
      focusedPaneByWorktree: { [worktree.id]: "pane-1" },
    });

    render(<WorktreeView worktree={worktree} active />);

    const separator = screen.getByRole("separator");
    expect(separator).toHaveClass("-mx-1");
    expect(separator).toHaveClass("aria-[orientation=horizontal]:h-px");
    expect(separator).not.toHaveClass("aria-[orientation=horizontal]:h-2");
    expect(separator).toHaveClass("aria-[orientation=horizontal]:after:top-0");
    expect(separator).toHaveClass(
      "aria-[orientation=horizontal]:after:translate-y-0",
    );
  });

  it("keeps the save dialog open when saving a dirty file tab fails", async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const saveAttempt = deferred<void>();
    const saveSpy = vi.fn().mockReturnValue(saveAttempt.promise);
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
          reloadGeneration: 0,
          error: null,
        },
      },
      save: saveSpy,
    }));

    render(<WorktreeView worktree={worktree} active />);

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

  it("closes the dirty git diff tab after a successful save", async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const saveAttempt = deferred<void>();
    const worktree = makeWorktree();
    const diffTab = makeGitDiffTab("diff-1", worktree.id, {
      path: "README.md",
    });
    const saveSpy = vi.fn().mockImplementation(async () => {
      await saveAttempt.promise;
      useGitDiffStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [diffTab.id]: {
            ...state.sessions[diffTab.id]!,
            dirty: false,
          },
        },
      }));
    });

    useTabStore.setState((state) => ({
      ...state,
      tabs: [diffTab],
      activeTabId: diffTab.id,
      activeTabByWorktree: { [worktree.id]: diffTab.id },
      close: closeSpy,
    }));
    useGitDiffStore.setState((state) => ({
      ...state,
      sessions: {
        [diffTab.id]: {
          tabId: diffTab.id,
          path: diffTab.path,
          originalPath: null,
          scope: "unstaged",
          originalContent: "hello\n",
          draft: "hello world\n",
          savedContent: "hello\n",
          modifiedVersionToken: "v1",
          language: "markdown",
          readOnly: false,
          unsupportedReason: null,
          dirty: true,
          externalChange: false,
          loadStatus: "loaded",
          saveStatus: "idle",
          reloadGeneration: 0,
          error: null,
        },
      },
      save: saveSpy,
    }));

    render(<WorktreeView worktree={worktree} active />);

    fireEvent.click(
      screen.getByRole("button", { name: `Close ${diffTab.id}` }),
    );
    expect(
      await screen.findByText(`Save changes to ${diffTab.label}?`),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith(
        worktree.project_id,
        worktree.id,
        diffTab.id,
      );
    });

    await act(async () => {
      saveAttempt.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(closeSpy).toHaveBeenCalledWith(diffTab.id);
    });
  });

  it("closes the dirty file tab after a successful save", async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const saveAttempt = deferred<void>();
    const worktree = makeWorktree();
    const fileTab = makeFileTab("file-1", worktree.id);
    const saveSpy = vi.fn().mockImplementation(async () => {
      await saveAttempt.promise;
      useFileEditorStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [fileTab.id]: {
            ...state.sessions[fileTab.id]!,
            dirty: false,
          },
        },
      }));
    });

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
          reloadGeneration: 0,
          error: null,
        },
      },
      save: saveSpy,
    }));

    render(<WorktreeView worktree={worktree} active />);

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
    const worktree = makeWorktree();
    const fileTab = makeFileTab("file-race", worktree.id);
    const saveSpy = vi.fn().mockImplementation(async () => {
      await saveAttempt.promise;
      useFileEditorStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [fileTab.id]: {
            ...state.sessions[fileTab.id]!,
            dirty: false,
          },
        },
      }));
    });

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
          reloadGeneration: 0,
          error: null,
        },
      },
      save: saveSpy,
    }));

    render(<WorktreeView worktree={worktree} active />);

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
          reloadGeneration: 0,
          error: null,
        },
      },
    }));

    render(<WorktreeView worktree={worktree} active />);

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
