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
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorktreeAllFilesPanel from "./WorktreeAllFilesPanel";
import { SidebarProvider } from "@/components/ui/sidebar";
import type { Worktree } from "@/lib/types";

const mockListProjectWorktreeFiles = vi.fn();
const mockGetProjectWorktreeGitStatus = vi.fn();
const mockRenameProjectWorktreeFile = vi.fn();

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

function renderPanel(open = true) {
  function Harness({ isOpen }: { isOpen: boolean }) {
    const [actions, setActions] = useState<ReactNode>(null);

    return (
      <SidebarProvider defaultOpen>
        <div>{actions}</div>
        <div className="h-96">
          <WorktreeAllFilesPanel
            worktree={makeWorktree()}
            open={isOpen}
            onActionsChange={setActions}
          />
        </div>
      </SidebarProvider>
    );
  }

  return render(<Harness isOpen={open} />);
}

describe("WorktreeAllFilesPanel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockListProjectWorktreeFiles.mockReset();
    mockGetProjectWorktreeGitStatus.mockReset();
    mockRenameProjectWorktreeFile.mockReset();
    const { resetWorktreeFileManagerStoreForTests } =
      await import("@/lib/stores/worktreeFileManager");
    resetWorktreeFileManagerStoreForTests();

    mockListProjectWorktreeFiles.mockImplementation(
      async (_projectId: string, _worktreeId: string, path = "") => {
        if (path === "src") {
          return {
            generation: 1,
            path: "src",
            entries: [{ name: "lib.rs", path: "src/lib.rs", kind: "file" }],
          };
        }
        return {
          generation: 1,
          path: "",
          entries: [
            { name: "README.md", path: "README.md", kind: "file" },
            { name: "src", path: "src", kind: "directory" },
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
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("loads root entries and lazily expands directories once", async () => {
    renderPanel();

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
    renderPanel();

    expect(await screen.findByText("src")).toBeInTheDocument();

    fireEvent.contextMenu(getRowButton("src"));

    expect(
      await screen.findByRole("menuitem", { name: "Rename" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("lib.rs")).not.toBeInTheDocument();
  });

  it("renders git-aware decorations for files", async () => {
    renderPanel();

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
    renderPanel();

    expect(screen.queryByText("Explorer")).not.toBeInTheDocument();
    expect(screen.queryByText("/tmp/feature-a")).not.toBeInTheDocument();

    const srcRow = await screen.findByRole("button", { name: "Toggle src" });
    expect(within(srcRow).getByText("src").className).toContain(
      "text-emerald-500",
    );
    expect(srcRow.querySelector(".bg-current.opacity-65")).toBeTruthy();
  });

  it("keeps git text colors on selected changed rows", async () => {
    renderPanel();

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

    renderPanel();

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

    renderPanel();

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

    renderPanel();

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

    renderPanel();

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

    renderPanel();

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

    renderPanel();

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

  it("copies relative and absolute paths from the row action menu", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderPanel();

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
