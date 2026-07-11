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
import { resetWorktreeFileManagerStoreForTests } from "@/lib/stores/worktreeFileManager";
import { resetGitStatusStoreForTests } from "@/lib/stores/gitStatus";
import {
  resetWorktreeGitStatusViewStoreForTests,
  useWorktreeGitStatusViewStore,
} from "@/lib/stores/worktreeGitStatusView";
import {
  resetWorktreeRightSidebarStoreForTests,
  initializeWorktreeRightSidebarStore,
  useWorktreeRightSidebarStore,
} from "@/lib/stores/worktreeRightSidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { resetTabStoreForTests, useTabStore } from "@/lib/stores/tabs";
import {
  resetWorktreeStoreForTests,
  useWorktreeStore,
} from "@/lib/stores/worktrees";
import { WORKTREE_RIGHT_SIDEBAR_CHANGES_TAB } from "@/lib/worktreeRightSidebar";
import type { Worktree } from "@/lib/types";

const mockGetProjectWorktreeGitStatus = vi.fn();
const mockGetProjectWorktreeCommitDetails = vi.fn();
const mockStageProjectWorktreePath = vi.fn();
const mockUnstageProjectWorktreePath = vi.fn();
const mockDiscardProjectWorktreePath = vi.fn();
const mockOpenGitDiff = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/materialIconTheme", () => ({
  resolveMaterialFileIcon: (path: string) => ({
    iconPath: `/icons/${path.split("/").pop() ?? "file"}.svg`,
    iconId: "test-file",
  }),
  resolveMaterialFolderIcon: (
    name: string,
    _theme: unknown,
    open: boolean,
  ) => ({
    iconPath: `/icons/${name}.svg`,
    iconId: open ? "test-folder-open" : "test-folder-closed",
  }),
}));

vi.mock("@/lib/stores/theme", () => ({
  useThemeSettings: <T,>(selector: (state: { activeTheme: null }) => T) =>
    selector({ activeTheme: null }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    type = "button",
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
    <span {...props}>{children}</span>
  ),
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: (props: React.HTMLAttributes<HTMLHRElement>) => <hr {...props} />,
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div data-slot="skeleton" className={className} {...props} />
  ),
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SidebarMenu: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  SidebarMenuItem: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
}));

vi.mock("@/components/ui/collapsible", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  type CollapsibleContextValue = {
    open: boolean;
    setOpen: (open: boolean) => void;
  };

  const CollapsibleContext =
    React.createContext<CollapsibleContextValue | null>(null);

  function Collapsible({
    open,
    onOpenChange,
    children,
    ...props
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  } & React.HTMLAttributes<HTMLDivElement>) {
    return (
      <CollapsibleContext.Provider value={{ open, setOpen: onOpenChange }}>
        <div {...props}>{children}</div>
      </CollapsibleContext.Provider>
    );
  }

  function CollapsibleTrigger({
    asChild,
    children,
  }: {
    asChild?: boolean;
    children: React.ReactNode;
  }) {
    const context = React.useContext(CollapsibleContext);
    if (!context) {
      return <>{children}</>;
    }

    const toggle = () => context.setOpen(!context.open);
    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<{
        onClick?: (event: React.MouseEvent<HTMLElement>) => void;
      }>;
      return React.cloneElement(child, {
        onClick: (event: React.MouseEvent<HTMLElement>) => {
          child.props.onClick?.(event);
          if (!event.defaultPrevented) {
            toggle();
          }
        },
      } as Partial<typeof child.props>);
    }

    return <button onClick={toggle}>{children}</button>;
  }

  function CollapsibleContent({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) {
    const context = React.useContext(CollapsibleContext);
    if (!context?.open) {
      return null;
    }
    return <div {...props}>{children}</div>;
  }

  return {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
  };
});

vi.mock("@/components/ui/context-menu", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  type ContextMenuValue = {
    open: boolean;
    setOpen: (open: boolean) => void;
  };

  const ContextMenuState = React.createContext<ContextMenuValue | null>(null);

  function mergeHandler<T extends React.SyntheticEvent>(
    existing: ((event: T) => void) | undefined,
    next: (event: T) => void,
  ) {
    return (event: T) => {
      existing?.(event);
      if (!event.defaultPrevented) {
        next(event);
      }
    };
  }

  function ContextMenu({ children }: { children: React.ReactNode }) {
    const [open, setOpen] = React.useState(false);
    return (
      <ContextMenuState.Provider value={{ open, setOpen }}>
        {children}
      </ContextMenuState.Provider>
    );
  }

  function ContextMenuTrigger({
    asChild,
    children,
  }: {
    asChild?: boolean;
    children: React.ReactNode;
  }) {
    const context = React.useContext(ContextMenuState);
    if (!context) {
      return <>{children}</>;
    }

    const openMenu = (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      context.setOpen(true);
    };

    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<{
        onContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
      }>;
      return React.cloneElement(child, {
        onContextMenu: mergeHandler(child.props.onContextMenu, openMenu),
      } as Partial<typeof child.props>);
    }

    return <div onContextMenu={openMenu}>{children}</div>;
  }

  function ContextMenuContent({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) {
    const context = React.useContext(ContextMenuState);
    if (!context?.open) {
      return null;
    }
    return (
      <div role="menu" {...props}>
        {children}
      </div>
    );
  }

  function ContextMenuItem({
    children,
    onSelect,
    onClick,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    onSelect?: () => void;
  }) {
    const context = React.useContext(ContextMenuState);

    return (
      <button
        role="menuitem"
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) {
            onSelect?.();
            context?.setOpen(false);
          }
        }}
        {...props}
      >
        {children}
      </button>
    );
  }

  return {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
  };
});

vi.mock("@/components/ui/hover-card", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  type HoverCardValue = {
    open: boolean;
    setOpen: (open: boolean) => void;
  };

  const HoverCardState = React.createContext<HoverCardValue | null>(null);

  function mergeHandler<T extends React.SyntheticEvent>(
    existing: ((event: T) => void) | undefined,
    next: (event: T) => void,
  ) {
    return (event: T) => {
      existing?.(event);
      if (!event.defaultPrevented) {
        next(event);
      }
    };
  }

  function HoverCard({ children }: { children: React.ReactNode }) {
    const [open, setOpen] = React.useState(false);
    return (
      <HoverCardState.Provider value={{ open, setOpen }}>
        {children}
      </HoverCardState.Provider>
    );
  }

  function HoverCardTrigger({
    asChild,
    children,
  }: {
    asChild?: boolean;
    children: React.ReactNode;
  }) {
    const context = React.useContext(HoverCardState);
    if (!context) {
      return <>{children}</>;
    }

    const open = () => context.setOpen(true);
    const close = () => context.setOpen(false);

    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<{
        onPointerEnter?: (event: React.PointerEvent<HTMLElement>) => void;
        onPointerLeave?: (event: React.PointerEvent<HTMLElement>) => void;
        onFocus?: (event: React.FocusEvent<HTMLElement>) => void;
        onBlur?: (event: React.FocusEvent<HTMLElement>) => void;
      }>;
      return React.cloneElement(child, {
        onPointerEnter: mergeHandler(child.props.onPointerEnter, () => open()),
        onPointerLeave: mergeHandler(child.props.onPointerLeave, () => close()),
        onFocus: mergeHandler(child.props.onFocus, () => open()),
        onBlur: mergeHandler(child.props.onBlur, () => close()),
      } as Partial<typeof child.props>);
    }

    return <div>{children}</div>;
  }

  function HoverCardContent({
    children,
    side: _side,
    align: _align,
    sideOffset: _sideOffset,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & {
    side?: string;
    align?: string;
    sideOffset?: number;
  }) {
    const context = React.useContext(HoverCardState);
    if (!context?.open) {
      return null;
    }
    return <div {...props}>{children}</div>;
  }

  return {
    HoverCard,
    HoverCardContent,
    HoverCardTrigger,
  };
});

vi.mock("@/components/ui/alert-dialog", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  const AlertDialogState = React.createContext<
    ((open: boolean) => void) | null
  >(null);

  function AlertDialog({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    children: React.ReactNode;
  }) {
    return open ? (
      <AlertDialogState.Provider value={onOpenChange ?? null}>
        <div>{children}</div>
      </AlertDialogState.Provider>
    ) : null;
  }

  function passthrough(tag: string) {
    return function Component({
      children,
      ...props
    }: React.HTMLAttributes<HTMLElement>) {
      return React.createElement(tag, props, children);
    };
  }

  function AlertDialogAction({
    children,
    onClick,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
      <button onClick={onClick} {...props}>
        {children}
      </button>
    );
  }

  function AlertDialogCancel({
    children,
    onClick,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
    const onOpenChange = React.useContext(AlertDialogState);
    return (
      <button
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) {
            onOpenChange?.(false);
          }
        }}
        {...props}
      >
        {children}
      </button>
    );
  }

  return {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent: passthrough("div"),
    AlertDialogDescription: passthrough("p"),
    AlertDialogFooter: passthrough("div"),
    AlertDialogHeader: passthrough("div"),
    AlertDialogTitle: passthrough("h2"),
  };
});

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
    ui_mode: "hubris",
    is_local: false,
    missing_on_disk: false,
    position: 2,
    ...overrides,
  };
}

function makeGitStatusResponse(overrides?: Record<string, unknown>) {
  return {
    source_ref: "main",
    generation: 1,
    unstaged_files: [
      {
        path: "tmp2/bar/bar.txt",
        change_type: "modified",
        insertions: 5,
        deletions: 2,
      },
      {
        path: "tmp2/bar/baz/fox.txt",
        change_type: "untracked",
        insertions: 10,
        deletions: 0,
      },
      {
        path: "tmp2/bar/baz/qux/deep.txt",
        change_type: "modified",
        insertions: 3,
        deletions: 1,
      },
      {
        path: "tmp2/foo.txt",
        change_type: "modified",
        insertions: 0,
        deletions: 0,
      },
    ],
    staged_files: [
      {
        path: "README.md",
        change_type: "added",
        insertions: 20,
        deletions: 0,
      },
      {
        path: "src/main.ts",
        change_type: "modified",
        insertions: 8,
        deletions: 4,
      },
    ],
    ahead_count: 1,
    ahead_commits: [
      { id: "abcdef123456", short_id: "abcdef1", summary: "Ahead commit" },
    ],
    comparison_available: true,
    comparison_error: null,
    ...overrides,
  };
}

function makeMinimalNestedGitStatusResponse() {
  return makeGitStatusResponse({
    unstaged_files: [
      { path: "tmp2/bar/bar.txt", change_type: "modified" },
      { path: "tmp2/foo.txt", change_type: "modified" },
    ],
    staged_files: [{ path: "README.md", change_type: "added" }],
    ahead_count: 0,
    ahead_commits: [],
  });
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
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    localStorage.clear();
    mockGetProjectWorktreeGitStatus.mockReset();
    mockGetProjectWorktreeCommitDetails.mockReset();
    mockStageProjectWorktreePath.mockReset();
    mockUnstageProjectWorktreePath.mockReset();
    mockDiscardProjectWorktreePath.mockReset();
    resetWorktreeFileManagerStoreForTests();
    resetGitStatusStoreForTests();
    resetWorktreeRightSidebarStoreForTests();
    resetWorktreeGitStatusViewStoreForTests();
    resetTabStoreForTests();
    useTabStore.setState({
      openGitDiff: mockOpenGitDiff,
    });
    resetWorktreeStoreForTests();
    mockOpenGitDiff.mockReset();
    mockGetProjectWorktreeGitStatus.mockResolvedValue(makeGitStatusResponse());
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
    mockGetProjectWorktreeGitStatus.mockResolvedValue({
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
    mockGetProjectWorktreeGitStatus.mockResolvedValue({
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

  it("does not warn when a section includes repeated paths", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    mockGetProjectWorktreeGitStatus.mockResolvedValue({
      source_ref: "main",
      generation: 1,
      unstaged_files: [],
      staged_files: [
        { path: "README copy.md", change_type: "modified" },
        { path: "README copy.md", change_type: "modified" },
      ],
      ahead_count: 0,
      ahead_commits: [],
      comparison_available: true,
      comparison_error: null,
    });

    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: "Show list view" }),
    );

    expect(
      (await screen.findAllByText("README copy.md")).length,
    ).toBeGreaterThanOrEqual(2);
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining("same key"),
      expect.anything(),
    );
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
    mockGetProjectWorktreeGitStatus.mockResolvedValue({
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
    mockGetProjectWorktreeGitStatus.mockResolvedValue({
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

    const user = userEvent.setup();
    const commitRow = await screen.findByRole("button", {
      name: "Toggle commit Ahead commit",
    });
    await user.hover(commitRow);
    await user.click(commitRow);
    expect(
      await screen.findByText("main.ts", { selector: "span" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Toggle src/nested" }),
    ).toBeVisible();
    expect(
      screen.getByTestId("commit-marker-connector-content"),
    ).toBeInTheDocument();
  });

  it("opens commit tree files as preview diffs on click", async () => {
    mockGetProjectWorktreeCommitDetails.mockResolvedValueOnce({
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
      files: [{ path: "src/commit-only.ts", change_type: "modified" }],
    });
    renderPanel();

    const user = userEvent.setup();
    const commitRow = await screen.findByRole("button", {
      name: "Toggle commit Ahead commit",
    });
    await user.hover(commitRow);
    await user.click(commitRow);
    const [commitFile] = await screen.findAllByText("commit-only.ts", {
      selector: "span",
    });
    expect(commitFile).toBeTruthy();
    if (!commitFile) {
      throw new Error("Commit diff row not found");
    }
    fireEvent.click(commitFile);

    expect(mockOpenGitDiff).toHaveBeenNthCalledWith(1, {
      worktreeId: "w1",
      path: "src/commit-only.ts",
      scope: "commit",
      originalPath: undefined,
      commitId: "abcdef123456",
      preview: true,
    });
    fireEvent.doubleClick(commitFile);

    expect(mockOpenGitDiff).toHaveBeenNthCalledWith(2, {
      worktreeId: "w1",
      path: "src/commit-only.ts",
      scope: "commit",
      originalPath: undefined,
      commitId: "abcdef123456",
      preview: false,
    });
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
    mockGetProjectWorktreeGitStatus.mockResolvedValue({
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
    mockGetProjectWorktreeGitStatus.mockResolvedValue({
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
    mockGetProjectWorktreeGitStatus.mockResolvedValue({
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
    mockGetProjectWorktreeGitStatus.mockResolvedValue(
      makeMinimalNestedGitStatusResponse(),
    );

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
    mockGetProjectWorktreeGitStatus.mockResolvedValue(
      makeMinimalNestedGitStatusResponse(),
    );

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
    mockGetProjectWorktreeGitStatus.mockResolvedValue(
      makeMinimalNestedGitStatusResponse(),
    );

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

  it("shows per-file diff line stats in list view", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "Unstaged" });
    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));
    // bar.txt has +5 -2
    expect(await screen.findByText("+5")).toBeInTheDocument();
    expect(screen.getByText("-2")).toBeInTheDocument();
    // fox.txt has +10, no deletions (zero hidden)
    expect(screen.getByText("+10")).toBeInTheDocument();
  });

  it("hides stats when both insertions and deletions are zero", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "Unstaged" });
    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));
    // foo.txt has insertions: 0, deletions: 0 — no stats shown
    await screen.findByText("foo.txt");
    expect(screen.queryByText("+0")).not.toBeInTheDocument();
    expect(screen.queryByText("-0")).not.toBeInTheDocument();
  });

  it("shows aggregate stats on section headers", async () => {
    renderPanel();
    // Unstaged aggregate: +5 +10 +3 +0 = +18, -2 -0 -1 -0 = -3
    // Staged aggregate: +20 +8 = +28, -0 -4 = -4
    expect(await screen.findByText("+18")).toBeInTheDocument();
    expect(screen.getByText("-3")).toBeInTheDocument();
    expect(screen.getByText("+28")).toBeInTheDocument();
  });

  it("updates aggregate stats after staging a file", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole("button", { name: "Unstaged" });
    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));

    // Initial: unstaged +18 -3, staged +28 -4
    expect(await screen.findByText("+18")).toBeInTheDocument();
    expect(screen.getByText("+28")).toBeInTheDocument();

    // After staging bar.txt (+5 -2): it moves from unstaged to staged
    mockGetProjectWorktreeGitStatus.mockResolvedValue({
      source_ref: "main",
      generation: 2,
      unstaged_files: [
        {
          path: "tmp2/bar/baz/fox.txt",
          change_type: "untracked",
          insertions: 10,
          deletions: 0,
        },
        {
          path: "tmp2/bar/baz/qux/deep.txt",
          change_type: "modified",
          insertions: 3,
          deletions: 1,
        },
        {
          path: "tmp2/foo.txt",
          change_type: "modified",
          insertions: 0,
          deletions: 0,
        },
      ],
      staged_files: [
        {
          path: "README.md",
          change_type: "added",
          insertions: 20,
          deletions: 0,
        },
        {
          path: "src/main.ts",
          change_type: "modified",
          insertions: 8,
          deletions: 4,
        },
        {
          path: "tmp2/bar/bar.txt",
          change_type: "modified",
          insertions: 5,
          deletions: 2,
        },
      ],
      ahead_count: 1,
      ahead_commits: [
        {
          id: "abcdef123456",
          short_id: "abcdef1",
          summary: "Ahead commit",
        },
      ],
      comparison_available: true,
      comparison_error: null,
    });

    fireEvent.contextMenu(screen.getByText("bar.txt"));
    await user.click(
      await screen.findByRole("menuitem", { name: "Stage bar.txt" }),
    );

    // Unstaged aggregate: +10 +3 +0 = +13, -0 -1 -0 = -1
    // Staged aggregate: +20 +8 +5 = +33, -0 -4 -2 = -6
    await waitFor(() => {
      expect(screen.getByText("+13")).toBeInTheDocument();
    });
    // -1 appears on both the per-file deep.txt row and the unstaged header
    expect(screen.getAllByText("-1")).toHaveLength(2);
    expect(screen.getByText("+33")).toBeInTheDocument();
    expect(screen.getByText("-6")).toBeInTheDocument();
  });

  it("keeps aggregate stats visible when section is collapsed", async () => {
    renderPanel();
    await screen.findByText("+28");
    const stagedHeader = screen.getByRole("button", { name: "Staged" });
    fireEvent.click(stagedHeader);
    // Files hidden but aggregate stats still in header
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
    expect(screen.getByText("+28")).toBeInTheDocument();
  });
});
