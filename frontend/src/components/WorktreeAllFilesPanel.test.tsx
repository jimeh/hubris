// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorktreeAllFilesPanel from "./WorktreeAllFilesPanel";
import { SidebarProvider } from "@/components/ui/sidebar";
import { resetTabStoreForTests, useTabStore } from "@/lib/stores/tabs";
import {
  resetWorktreeFileManagerStoreForTests,
  useWorktreeFileManagerStore,
} from "@/lib/stores/worktreeFileManager";
import {
  initializeWorktreeRightSidebarStore,
  resetWorktreeRightSidebarStoreForTests,
  useWorktreeRightSidebarStore,
} from "@/lib/stores/worktreeRightSidebar";
import {
  resetWorktreeStoreForTests,
  useWorktreeStore,
} from "@/lib/stores/worktrees";
import { WORKTREE_RIGHT_SIDEBAR_ALL_FILES_TAB } from "@/lib/worktreeRightSidebar";
import type { Worktree } from "@/lib/types";
import { consumeClipboardItems } from "@/test/clipboard";

const mockListProjectWorktreeFiles = vi.fn();
const mockGetProjectWorktreeGitStatus = vi.fn();
const mockRenameProjectWorktreeFile = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/materialIconTheme", () => ({
  resolveMaterialFileIcon: (path: string) => {
    const basename = path.split("/").pop() ?? "file";
    const iconId =
      basename === "README.md"
        ? "readme"
        : basename.endsWith(".rs")
          ? "rust"
          : "file";

    return {
      iconPath: `/icons/${basename}.svg`,
      iconId,
    };
  },
  resolveMaterialFolderIcon: (
    name: string,
    _theme: unknown,
    open: boolean,
  ) => ({
    iconPath: `/icons/${name}.svg`,
    iconId: open ? "folder-open" : "folder-closed",
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

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
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
  SidebarMenuButton: ({
    children,
    type = "button",
    isActive: _isActive,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    isActive?: boolean;
  }) => (
    <button type={type} {...props}>
      {children}
    </button>
  ),
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
    onCloseAutoFocus: _onCloseAutoFocus,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & {
    onCloseAutoFocus?: (event: Event) => void;
  }) {
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

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    listProjectWorktreeFiles: (...args: unknown[]) =>
      mockListProjectWorktreeFiles(...args),
    getProjectWorktreeGitStatus: (...args: unknown[]) =>
      mockGetProjectWorktreeGitStatus(...args),
    renameProjectWorktreeFile: (...args: unknown[]) =>
      mockRenameProjectWorktreeFile(...args),
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
    ui_mode: "hubris",
    is_local: false,
    missing_on_disk: false,
    position: 2,
  };
}

async function openRowActionMenu(name: string): Promise<void> {
  const trigger = getRowButton(name);
  fireEvent.contextMenu(trigger);
  await screen.findByRole("menuitem", { name: "Rename" });
}

function getRowButton(name: string): HTMLElement {
  return screen.getByRole("button", {
    name: new RegExp(`^(Toggle )?(?:.+/)?${name}`),
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function renderPanel() {
  const worktree = makeWorktree();

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
    activeTab: WORKTREE_RIGHT_SIDEBAR_ALL_FILES_TAB,
  });
  initializeWorktreeRightSidebarStore();

  let result: ReturnType<typeof render> | undefined;
  await act(async () => {
    result = render(
      <SidebarProvider defaultOpen>
        <div className="h-96">
          <WorktreeAllFilesPanel worktree={worktree} />
        </div>
      </SidebarProvider>,
    );
    await Promise.resolve();
  });

  return result!;
}

describe("WorktreeAllFilesPanel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    mockListProjectWorktreeFiles.mockReset();
    mockGetProjectWorktreeGitStatus.mockReset();
    mockRenameProjectWorktreeFile.mockReset();
    resetTabStoreForTests();
    resetWorktreeFileManagerStoreForTests();
    resetWorktreeRightSidebarStoreForTests();
    resetWorktreeStoreForTests();
    useTabStore.setState({
      openFile: vi.fn().mockResolvedValue({
        id: "file-tab-1",
        session_id: "default",
        worktree_id: "w1",
        label: "README.md",
        type: "file",
        position: 1,
        created_at: 0,
        preview: true,
        path: "README.md",
      }),
    });

    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "src") {
          return {
            generation: 1,
            path: "src",
            entries: [
              {
                name: "lib.rs",
                path: "src/lib.rs",
                kind: "file",
                is_symlink: false,
              },
            ],
          };
        }
        return {
          generation: 1,
          path: "",
          entries: [
            {
              name: "README.md",
              path: "README.md",
              kind: "file",
              is_symlink: false,
            },
            { name: "src", path: "src", kind: "directory", is_symlink: false },
          ],
        };
      },
    );
    mockGetProjectWorktreeGitStatus.mockResolvedValue({
      generation: 1,
      source_ref: "main",
      unstaged_files: [{ path: "README.md", change_type: "modified" }],
      staged_files: [{ path: "src/lib.rs", change_type: "added" }],
      ahead_count: 0,
      ahead_commits: [],
      comparison_available: true,
      comparison_error: null,
    });
    mockRenameProjectWorktreeFile.mockResolvedValue({
      path: "README-renamed.md",
    });
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: {
        write: vi.fn().mockImplementation(async (items: unknown[]) => {
          consumeClipboardItems(items);
        }),
        read: vi.fn().mockResolvedValue([]),
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue(""),
      },
    });
  });

  it("loads root entries and lazily expands directories once", async () => {
    await renderPanel();

    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("src")).toBeInTheDocument();
    await waitFor(() => {
      expect(mockListProjectWorktreeFiles).toHaveBeenCalledTimes(2);
    });
    expect(
      screen.queryByRole("button", { name: "Actions for src" }),
    ).not.toBeInTheDocument();
    expect(
      within(getRowButton("src")).getByTestId("folder-icon-closed"),
    ).toBeVisible();
    expect(
      within(getRowButton("README.md")).getByTestId("file-icon-manifest"),
    ).toHaveAttribute("data-icon-id", "readme");

    fireEvent.click(getRowButton("src"));

    expect(await screen.findByText("lib.rs")).toBeInTheDocument();
    expect(
      within(getRowButton("src")).getByTestId("folder-icon-open"),
    ).toBeVisible();
    expect(
      within(getRowButton("lib.rs")).getByTestId("file-icon-manifest"),
    ).toHaveAttribute("data-icon-id", "rust");
    expect(mockListProjectWorktreeFiles).toHaveBeenCalledTimes(2);

    fireEvent.click(getRowButton("src"));
    fireEvent.click(getRowButton("src"));

    await waitFor(() => {
      expect(screen.getByText("lib.rs")).toBeInTheDocument();
    });
    expect(mockListProjectWorktreeFiles).toHaveBeenCalledTimes(2);
  });

  it("opens the context menu on right click without toggling a directory", async () => {
    await renderPanel();

    expect(await screen.findByText("src")).toBeInTheDocument();

    fireEvent.contextMenu(getRowButton("src"));

    expect(
      await screen.findByRole("menuitem", { name: "Rename" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("lib.rs")).not.toBeInTheDocument();
  });

  it("renders a symlink overlay while keeping the base icon", async () => {
    mockListProjectWorktreeFiles.mockResolvedValue({
      generation: 1,
      path: "",
      entries: [
        {
          name: "README.md",
          path: "README.md",
          kind: "file",
          is_symlink: true,
        },
      ],
    });

    await renderPanel();

    const row = getRowButton("README.md");
    expect(within(row).getByTestId("file-icon-manifest")).toHaveAttribute(
      "data-icon-id",
      "readme",
    );
    expect(within(row).getByTestId("symlink-indicator")).toBeInTheDocument();
  });

  it("renders git-aware decorations for files", async () => {
    await renderPanel();

    const readmeLabel = await screen.findByText("README.md");
    expect(readmeLabel).toBeInTheDocument();
    expect(
      within(getRowButton("README.md")).getByTestId("file-icon-manifest"),
    ).toHaveAttribute("data-icon-id", "readme");
    expect(screen.getByText("M")).toBeInTheDocument();
    expect(readmeLabel.className).toContain("text-amber-500");

    const srcLabel = within(getRowButton("src")).getByText("src");
    expect(srcLabel.className).toContain("text-emerald-500");

    fireEvent.click(getRowButton("src"));

    const libLabel = await screen.findByText("lib.rs");
    expect(
      within(getRowButton("lib.rs")).getByTestId("file-icon-manifest"),
    ).toHaveAttribute("data-icon-id", "rust");
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(libLabel.className).toContain("text-emerald-500");
  });

  it("removes the explorer header box and shows directory status dots", async () => {
    await renderPanel();

    expect(screen.queryByText("Explorer")).not.toBeInTheDocument();
    expect(screen.queryByText("/tmp/feature-a")).not.toBeInTheDocument();

    const srcRow = await screen.findByRole("button", { name: "Toggle src" });
    expect(within(srcRow).getByText("src").className).toContain(
      "text-emerald-500",
    );
    expect(srcRow.querySelector(".bg-current.opacity-65")).toBeTruthy();
  });

  it("uses the most significant descendant change for directory styling", async () => {
    mockGetProjectWorktreeGitStatus.mockResolvedValueOnce({
      generation: 1,
      source_ref: "main",
      unstaged_files: [
        { path: "src/added.txt", change_type: "added" },
        { path: "src/deleted.txt", change_type: "deleted" },
      ],
      staged_files: [],
      ahead_count: 0,
      ahead_commits: [],
      comparison_available: true,
      comparison_error: null,
    });

    await renderPanel();

    const srcRow = await screen.findByRole("button", { name: "Toggle src" });
    expect(within(srcRow).getByText("src").className).toContain(
      "text-rose-500",
    );
    expect(
      srcRow.querySelector(".text-rose-500.bg-current.opacity-65"),
    ).toBeTruthy();
  });

  it("keeps git text colors on selected changed rows", async () => {
    await renderPanel();

    await screen.findByText("README.md");
    const readmeButton = Array.from(
      document.querySelectorAll<HTMLElement>("[data-testid='file-tree-row']"),
    ).find((element) => element.getAttribute("data-path") === "README.md");
    expect(readmeButton).toBeTruthy();
    const targetRow = readmeButton!;
    fireEvent.click(targetRow);

    const readmeLabel = within(targetRow).getByText("README.md");
    expect(targetRow.className).toContain("text-sidebar-accent-foreground");
    expect(readmeLabel.className).toContain("text-amber-500");
  });

  it("uses the theme default file icon when no specific match exists", async () => {
    mockListProjectWorktreeFiles.mockResolvedValueOnce({
      generation: 1,
      path: "",
      entries: [{ name: "notes.foo", path: "notes.foo", kind: "file" }],
    });

    await renderPanel();

    expect(await screen.findByText("notes.foo")).toBeInTheDocument();
    expect(
      within(getRowButton("notes.foo")).getByTestId("file-icon-manifest"),
    ).toHaveAttribute("data-icon-id", "file");
  });

  it("shows the root loading placeholder immediately", async () => {
    const rootListing = createDeferred<{
      generation: number;
      path: string;
      entries: Array<{
        name: string;
        path: string;
        kind: "file" | "directory";
      }>;
    }>();

    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "") {
          return rootListing.promise;
        }
        return { generation: 1, path, entries: [] };
      },
    );

    await renderPanel();

    expect(
      screen.getByTestId("root-directory-loading-list"),
    ).toBeInTheDocument();

    rootListing.resolve({
      generation: 1,
      path: "",
      entries: [{ name: "README.md", path: "README.md", kind: "file" }],
    });

    expect(await screen.findByText("README.md")).toBeInTheDocument();
  });

  it("does not show the nested loading placeholder for fast responses", async () => {
    const noisyListing = createDeferred<{
      generation: number;
      path: string;
      entries: Array<{
        name: string;
        path: string;
        kind: "file" | "directory";
      }>;
    }>();

    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "node_modules") {
          return noisyListing.promise;
        }
        return {
          generation: 1,
          path,
          entries:
            path === ""
              ? [
                  {
                    name: "node_modules",
                    path: "node_modules",
                    kind: "directory",
                  },
                ]
              : [],
        };
      },
    );

    await renderPanel();

    expect(await screen.findByText("node_modules")).toBeInTheDocument();

    vi.useFakeTimers();

    fireEvent.click(getRowButton("node_modules"));
    expect(
      screen.queryByTestId("nested-directory-loading-placeholder"),
    ).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(
      screen.queryByTestId("nested-directory-loading-placeholder"),
    ).toBeNull();

    await act(async () => {
      noisyListing.resolve({
        generation: 1,
        path: "node_modules",
        entries: [
          {
            name: "package.json",
            path: "node_modules/package.json",
            kind: "file",
          },
        ],
      });
      await Promise.resolve();
    });

    vi.useRealTimers();

    expect(await screen.findByText("package.json")).toBeInTheDocument();
    expect(
      screen.queryByTestId("nested-directory-loading-placeholder"),
    ).toBeNull();
  });

  it("shows the nested loading placeholder after the delay for slow responses", async () => {
    const noisyListing = createDeferred<{
      generation: number;
      path: string;
      entries: Array<{
        name: string;
        path: string;
        kind: "file" | "directory";
      }>;
    }>();

    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "node_modules") {
          return noisyListing.promise;
        }
        return {
          generation: 1,
          path,
          entries:
            path === ""
              ? [
                  {
                    name: "node_modules",
                    path: "node_modules",
                    kind: "directory",
                  },
                ]
              : [],
        };
      },
    );

    await renderPanel();

    expect(await screen.findByText("node_modules")).toBeInTheDocument();

    vi.useFakeTimers();
    fireEvent.click(getRowButton("node_modules"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(175);
    });

    expect(
      screen.getByTestId("nested-directory-loading-placeholder"),
    ).toBeInTheDocument();

    await act(async () => {
      noisyListing.resolve({
        generation: 1,
        path: "node_modules",
        entries: [
          {
            name: "package.json",
            path: "node_modules/package.json",
            kind: "file",
          },
        ],
      });
      await Promise.resolve();
    });

    vi.useRealTimers();

    expect(await screen.findByText("package.json")).toBeInTheDocument();
    expect(
      screen.queryByTestId("nested-directory-loading-placeholder"),
    ).toBeNull();
  });

  it("keeps loaded directory contents visible during refresh and only shows a delayed row pulse", async () => {
    const refreshListing = createDeferred<{
      generation: number;
      path: string;
      entries: Array<{
        name: string;
        path: string;
        kind: "file" | "directory";
      }>;
    }>();

    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "src") {
          return {
            generation: 1,
            path: "src",
            entries: [
              { name: "before.txt", path: "src/before.txt", kind: "file" },
            ],
          };
        }
        return {
          generation: 1,
          path: "",
          entries: [{ name: "src", path: "src", kind: "directory" }],
        };
      },
    );

    await renderPanel();
    expect(await screen.findByText("src")).toBeInTheDocument();

    fireEvent.click(getRowButton("src"));
    expect(await screen.findByText("before.txt")).toBeInTheDocument();

    vi.useFakeTimers();
    mockListProjectWorktreeFiles.mockImplementationOnce(
      async () => refreshListing.promise,
    );

    let refreshPromise!: Promise<void>;
    await act(async () => {
      refreshPromise = useWorktreeFileManagerStore
        .getState()
        .loadDirectory("p1", "w1", "src", { force: true });
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
    });

    expect(screen.getByText("before.txt")).toBeInTheDocument();
    expect(
      screen.queryByTestId("nested-directory-loading-placeholder"),
    ).toBeNull();
    expect(
      within(getRowButton("src")).queryByTestId("directory-refresh-pulse"),
    ).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(
      within(getRowButton("src")).getByTestId("directory-refresh-pulse"),
    ).toBeInTheDocument();

    await act(async () => {
      refreshListing.resolve({
        generation: 2,
        path: "src",
        entries: [{ name: "after.txt", path: "src/after.txt", kind: "file" }],
      });
      await refreshPromise;
    });

    vi.useRealTimers();

    expect(await screen.findByText("after.txt")).toBeInTheDocument();
    expect(screen.queryByText("before.txt")).not.toBeInTheDocument();
    expect(
      within(getRowButton("src")).queryByTestId("directory-refresh-pulse"),
    ).toBeNull();
  });

  it("preloads newly visible descendant directories when a folder opens", async () => {
    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "src") {
          return {
            generation: 1,
            path: "src",
            entries: [
              {
                name: "nested",
                path: "src/nested",
                kind: "directory",
              },
              { name: "lib.rs", path: "src/lib.rs", kind: "file" },
            ],
          };
        }
        if (path === "src/nested") {
          return {
            generation: 1,
            path: "src/nested",
            entries: [
              {
                name: "deep.txt",
                path: "src/nested/deep.txt",
                kind: "file",
              },
            ],
          };
        }
        return {
          generation: 1,
          path: "",
          entries: [{ name: "src", path: "src", kind: "directory" }],
        };
      },
    );

    await renderPanel();

    expect(await screen.findByText("src")).toBeInTheDocument();
    await waitFor(() => {
      expect(mockListProjectWorktreeFiles).toHaveBeenCalledWith("p1", "w1", "");
      expect(mockListProjectWorktreeFiles).toHaveBeenCalledWith(
        "p1",
        "w1",
        "src",
      );
    });

    fireEvent.click(getRowButton("src"));

    expect(await screen.findByText("nested")).toBeInTheDocument();
    expect(screen.getByTestId("explorer-tree-branch-src")).toBeInTheDocument();
    await waitFor(() => {
      expect(mockListProjectWorktreeFiles).toHaveBeenCalledWith(
        "p1",
        "w1",
        "src/nested",
      );
    });

    const callCountBeforeOpenNested =
      mockListProjectWorktreeFiles.mock.calls.length;
    fireEvent.click(getRowButton("nested"));

    expect(await screen.findByText("deep.txt")).toBeInTheDocument();
    expect(mockListProjectWorktreeFiles.mock.calls.length).toBe(
      callCountBeforeOpenNested,
    );
  });

  it("renames files from the row action menu", async () => {
    const user = userEvent.setup();
    mockListProjectWorktreeFiles
      .mockResolvedValueOnce({
        generation: 1,
        path: "",
        entries: [{ name: "README.md", path: "README.md", kind: "file" }],
      })
      .mockResolvedValueOnce({
        generation: 2,
        path: "",
        entries: [
          {
            name: "README-renamed.md",
            path: "README-renamed.md",
            kind: "file",
          },
        ],
      });

    await renderPanel();

    expect(await screen.findByText("README.md")).toBeInTheDocument();
    await openRowActionMenu("README.md");
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));

    const input = await screen.findByDisplayValue("README.md");
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "README-renamed.md" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockRenameProjectWorktreeFile).toHaveBeenCalledWith(
        "p1",
        "w1",
        "README.md",
        "README-renamed.md",
      );
    });
    expect(await screen.findByText("README-renamed.md")).toBeInTheDocument();
  });

  it("submits rename only once when enter is followed by blur", async () => {
    const user = userEvent.setup();
    const renameDeferred = createDeferred<{ path: string }>();
    mockRenameProjectWorktreeFile.mockReturnValueOnce(renameDeferred.promise);
    mockListProjectWorktreeFiles
      .mockResolvedValueOnce({
        generation: 1,
        path: "",
        entries: [{ name: "README.md", path: "README.md", kind: "file" }],
      })
      .mockResolvedValueOnce({
        generation: 2,
        path: "",
        entries: [
          {
            name: "README-renamed.md",
            path: "README-renamed.md",
            kind: "file",
          },
        ],
      });

    await renderPanel();

    expect(await screen.findByText("README.md")).toBeInTheDocument();
    await openRowActionMenu("README.md");
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));

    const input = await screen.findByDisplayValue("README.md");
    fireEvent.change(input, { target: { value: "README-renamed.md" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(mockRenameProjectWorktreeFile).toHaveBeenCalledTimes(1);
    });

    renameDeferred.resolve({ path: "README-renamed.md" });

    expect(await screen.findByText("README-renamed.md")).toBeInTheDocument();
  });

  it("copies relative and absolute paths from the row action menu", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: {
        write: vi.fn().mockImplementation(async (items: unknown[]) => {
          consumeClipboardItems(items);
        }),
        read: vi.fn().mockResolvedValue([]),
        writeText,
        readText: vi.fn().mockResolvedValue(""),
      },
    });

    await renderPanel();

    expect(await screen.findByText("README.md")).toBeInTheDocument();

    await openRowActionMenu("README.md");
    await user.click(
      screen.getByRole("menuitem", { name: "Copy Relative Path" }),
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("README.md");
    });

    await openRowActionMenu("README.md");
    await user.click(
      screen.getByRole("menuitem", { name: "Copy Absolute Path" }),
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("/tmp/feature-a/README.md");
    });

    fireEvent.contextMenu(getRowButton("src"));
    await user.click(
      await screen.findByRole("menuitem", { name: "Copy Relative Path" }),
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("src");
    });
  });
});
