import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FileBrowser from "@/components/FileBrowser";

const mockListFiles = vi.fn();

vi.mock("$lib/api", () => ({
  listFiles: (...args: unknown[]) => mockListFiles(...args),
}));

describe("FileBrowser", () => {
  beforeEach(() => {
    mockListFiles.mockReset();
    mockListFiles.mockResolvedValue({
      path: "/tmp",
      home_dir: "/Users/test",
      entries: [
        {
          name: "repo",
          path: "/tmp/repo",
          is_dir: true,
          is_git_repo: true,
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
});
