// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let worktreeViewRenderCount = 0;

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
  default: ({ worktree }: { worktree: { name: string } }) =>
    (() => {
      worktreeViewRenderCount += 1;
      return <div>Active worktree: {worktree.name}</div>;
    })(),
}));

describe("App", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    localStorage.clear();
    worktreeViewRenderCount = 0;

    const { useProjectStore } = await import("$lib/stores/projects");
    const { useWorktreeStore } = await import("$lib/stores/worktrees");
    const { resetSidebarWidthStoreForTests, useSidebarWidthStore } =
      await import("$lib/stores/sidebarWidth");

    resetSidebarWidthStoreForTests();

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
    useSidebarWidthStore.setState({
      width: 256,
      isResizing: false,
    });
  });

  it("updates the main pane when the selected worktree changes", async () => {
    const { default: App } = await import("./App");

    render(<App />);

    expect(screen.getByText("Active worktree: local")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "feature-a" }));

    expect(screen.getByText("Active worktree: feature-a")).toBeInTheDocument();
  });

  it("updates sidebar width via DOM subscription without rerendering the main pane", async () => {
    const { useSidebarWidthStore } = await import("$lib/stores/sidebarWidth");
    const { default: App } = await import("./App");

    render(<App />);

    const sidebarWrapper = document.querySelector<HTMLElement>(
      "[data-slot='sidebar-wrapper']",
    );

    expect(sidebarWrapper).not.toBeNull();
    expect(sidebarWrapper?.style.getPropertyValue("--sidebar-width")).toBe(
      "256px",
    );
    expect(worktreeViewRenderCount).toBe(1);

    act(() => {
      useSidebarWidthStore.getState().setWidth(320);
      useSidebarWidthStore.getState().setWidth(360);
      useSidebarWidthStore.getState().setWidth(400);
    });

    expect(sidebarWrapper?.style.getPropertyValue("--sidebar-width")).toBe(
      "400px",
    );
    expect(worktreeViewRenderCount).toBe(1);

    act(() => {
      useSidebarWidthStore.getState().setResizing(true);
    });

    expect(sidebarWrapper).toHaveClass("sidebar-resizing");

    act(() => {
      useSidebarWidthStore.getState().setResizing(false);
    });

    expect(sidebarWrapper).not.toHaveClass("sidebar-resizing");
  });
});
