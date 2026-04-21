// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetBootstrapForTests } from "@/lib/bootstrap";
import { useProjectStore } from "@/lib/stores/projects";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import { useCommandAction } from "./react";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

function makeProject(id: string, name: string) {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    position: 1,
  };
}

function makeWorktree(id: string, projectId: string, name: string) {
  return {
    id,
    project_id: projectId,
    name,
    path: `/tmp/${name}`,
    branch: name,
    source_ref: null,
    ui_mode: "hubris" as const,
    is_local: false,
    missing_on_disk: false,
    position: 1,
  };
}

describe("useCommandAction", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBootstrapForTests();
    vi.restoreAllMocks();

    useProjectStore.setState({
      projects: [
        makeProject("p1", "Alpha"),
        makeProject("p2", "Beta"),
      ],
    });
    useWorktreeStore.setState({
      selectedWorktreeId: null,
      worktreesByProject: {
        p1: [makeWorktree("w1", "p1", "local")],
        p2: [makeWorktree("w2", "p2", "feature")],
      },
    });
  });

  it("keeps run stable for structurally equal args and updates for new args", async () => {
    const createSpy = vi
      .spyOn(useWorktreeStore.getState(), "create")
      .mockResolvedValue(makeWorktree("w3", "p2", "release"));

    const { result, rerender } = renderHook(
      ({ projectId }) =>
        useCommandAction(
          "worktree.create",
          { branch: "release", projectId },
          "button",
        ),
      {
        initialProps: { projectId: "p1" },
      },
    );

    const firstRun = result.current.run;

    rerender({ projectId: "p1" });
    expect(result.current.run).toBe(firstRun);

    rerender({ projectId: "p2" });
    expect(result.current.run).not.toBe(firstRun);

    await result.current.run();

    expect(createSpy).toHaveBeenCalledWith(
      "p2",
      "release",
      undefined,
      undefined,
    );
  });
});
