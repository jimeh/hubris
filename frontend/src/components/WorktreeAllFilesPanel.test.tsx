// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorktreeAllFilesPanel from "./WorktreeAllFilesPanel";
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
  const trigger = screen.getByRole("button", { name: `Actions for ${name}` });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  await screen.findByRole("menuitem", { name: "Rename" });
}

function getRowButton(name: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${name}(\\s|$)`) });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
    render(<WorktreeAllFilesPanel worktree={makeWorktree()} />);

    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("src")).toBeInTheDocument();
    await waitFor(() => {
      expect(mockListProjectWorktreeFiles).toHaveBeenCalledTimes(2);
    });
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

  it("renders git-aware decorations for files", async () => {
    render(<WorktreeAllFilesPanel worktree={makeWorktree()} />);

    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(
      within(getRowButton("README.md")).getByTestId("file-icon-manifest"),
    ).toHaveAttribute("data-icon-id", "readme");
    expect(screen.getByText("M")).toBeInTheDocument();

    fireEvent.click(getRowButton("src"));

    expect(await screen.findByText("lib.rs")).toBeInTheDocument();
    expect(
      within(getRowButton("lib.rs")).getByTestId("file-icon-manifest"),
    ).toHaveAttribute("data-icon-id", "rust");
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("uses the theme default file icon when no specific match exists", async () => {
    mockListProjectWorktreeFiles.mockResolvedValueOnce({
      generation: 1,
      path: "",
      entries: [{ name: "notes.foo", path: "notes.foo", kind: "file" }],
    });

    render(<WorktreeAllFilesPanel worktree={makeWorktree()} />);

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

    render(<WorktreeAllFilesPanel worktree={makeWorktree()} />);

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

    render(<WorktreeAllFilesPanel worktree={makeWorktree()} />);

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

    render(<WorktreeAllFilesPanel worktree={makeWorktree()} />);

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

    render(<WorktreeAllFilesPanel worktree={makeWorktree()} />);

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

    render(<WorktreeAllFilesPanel worktree={makeWorktree()} />);

    expect(await screen.findByText("README.md")).toBeInTheDocument();
    await openRowActionMenu("README.md");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    const input = screen.getByDisplayValue("README.md");
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
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<WorktreeAllFilesPanel worktree={makeWorktree()} />);

    expect(await screen.findByText("README.md")).toBeInTheDocument();

    await openRowActionMenu("README.md");
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy Relative Path" }),
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("README.md");
    });

    await openRowActionMenu("README.md");
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy Absolute Path" }),
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("/tmp/feature-a/README.md");
    });
  });
});
