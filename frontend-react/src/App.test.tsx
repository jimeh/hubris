// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/SidebarResizeHandle", () => ({
  default: () => null,
}));

vi.mock("@/components/AppSidebar", async () => {
  const { useWorktreeStore } = await import("$lib/stores/worktrees");

  function MockSidebar() {
    const worktreesByProject = useWorktreeStore(
      (state) => state.worktreesByProject,
    );
    const select = useWorktreeStore((state) => state.select);

    return (
      <aside>
        {Object.values(worktreesByProject)
          .flat()
          .map((worktree) => (
            <button
              key={worktree.id}
              onClick={() => select(worktree.id)}
              type="button"
            >
              {worktree.name}
            </button>
          ))}
      </aside>
    );
  }

  return { default: MockSidebar };
});

vi.mock("@/components/WorktreeView", () => ({
  default: ({ worktree }: { worktree: { name: string } }) => (
    <div>Active worktree: {worktree.name}</div>
  ),
}));

describe("App", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    localStorage.clear();

    const { useProjectStore } = await import("$lib/stores/projects");
    const { useWorktreeStore } = await import("$lib/stores/worktrees");

    useProjectStore.setState({
      projects: [
        { id: "p1", name: "Devbox", path: "/tmp/devbox", position: 1 },
      ],
      expandedById: { p1: true },
    });
    useWorktreeStore.setState({
      worktreesByProject: {
        p1: [
          {
            id: "w-local",
            project_id: "p1",
            name: "local",
            path: "/tmp/devbox",
            branch: "main",
            is_local: true,
            missing_on_disk: false,
            position: 1,
          },
          {
            id: "w-feature",
            project_id: "p1",
            name: "feature-a",
            path: "/tmp/devbox-feature",
            branch: "feature-a",
            is_local: false,
            missing_on_disk: false,
            position: 2,
          },
        ],
      },
      projectErrors: {},
      selectedWorktreeId: "w-local",
    });
  });

  it("updates the main pane when the selected worktree changes", async () => {
    const { default: App } = await import("./App");

    render(<App />);

    expect(screen.getByText("Active worktree: local")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "feature-a" }));

    expect(screen.getByText("Active worktree: feature-a")).toBeInTheDocument();
  });
});
