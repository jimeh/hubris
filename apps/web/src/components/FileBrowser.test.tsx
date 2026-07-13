import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FileBrowser from "@/components/FileBrowser";

const mockListFiles = vi.fn();

vi.mock("@/lib/api", () => ({
  listFiles: (...args: unknown[]) => mockListFiles(...args),
}));

describe("FileBrowser", () => {
  beforeEach(() => {
    mockListFiles.mockReset();
    mockListFiles.mockResolvedValue({
      path: "/tmp",
      homeDir: "/Users/test",
      entries: [
        {
          name: "repo",
          path: "/tmp/repo",
          is_dir: true,
          isGitRepo: true,
        },
      ],
    });
  });

  it("loads entries and reports double-click selection", async () => {
    const onSelect = vi.fn();
    const onCurrentPathChange = vi.fn();
    render(
      <FileBrowser
        currentPath=""
        onCurrentPathChange={onCurrentPathChange}
        onSelect={onSelect}
      />,
    );

    const repo = await screen.findByRole("option", { name: "repo" });
    expect(repo).toBeInTheDocument();

    fireEvent.dblClick(repo);

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith("/tmp/repo");
    });
    expect(onCurrentPathChange).toHaveBeenCalledWith("/tmp");
  });

  it("refreshes once when show-hidden is toggled", async () => {
    render(
      <FileBrowser
        currentPath=""
        onCurrentPathChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    await screen.findByRole("option", { name: "repo" });
    expect(mockListFiles).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle("Show dotfiles"));

    await waitFor(() => {
      expect(mockListFiles).toHaveBeenCalledTimes(2);
    });
    expect(mockListFiles).toHaveBeenLastCalledWith("/tmp", true);
  });

  it("supports keyboard-based folder selection", async () => {
    const onSelect = vi.fn();
    render(
      <FileBrowser
        currentPath=""
        onCurrentPathChange={vi.fn()}
        onSelect={onSelect}
      />,
    );

    await screen.findByRole("option", { name: "repo" });
    const listbox = await screen.findByRole("listbox");
    listbox.focus();
    fireEvent.keyDown(listbox, { key: "s" });

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith("/tmp");
    });
  });
});
