import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BranchInfo from "@/components/BranchInfo";
import { listProjectWorktreeStartPoints } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  listProjectWorktreeStartPoints: vi.fn(),
}));

describe("BranchInfo", () => {
  beforeEach(() => {
    vi.mocked(listProjectWorktreeStartPoints).mockReset();
    vi.mocked(listProjectWorktreeStartPoints).mockResolvedValue({
      startPoints: [
        {
          value: "refs/heads/main",
          sha: "0123456789abcdef",
          localRef: "main",
          remoteRefs: ["origin/main"],
        },
      ],
      defaultStartPoint: "refs/heads/main",
    });
  });

  it("loads source refs when the picker opens", async () => {
    render(
      <BranchInfo
        projectId="p1"
        worktreeId="w1"
        branch="feature"
        sourceRef={null}
      />,
    );

    expect(listProjectWorktreeStartPoints).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Change target branch" }),
    );

    await waitFor(() => {
      expect(listProjectWorktreeStartPoints).toHaveBeenCalledWith("p1");
    });
    expect(await screen.findByText("main")).toBeInTheDocument();
  });
});
