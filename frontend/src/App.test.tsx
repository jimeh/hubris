// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMobile } from "@/test/mobile";

let worktreeViewRenderCount = 0;
const vscodePaneMountCounts: Record<string, number> = {};
const vscodePaneUnmountCounts: Record<string, number> = {};

vi.mock("@/components/SidebarResizeHandle", () => ({
  default: () => null,
}));

vi.mock("@/components/AppSidebar", async () => {
  const { useWorktreeStore } = await import("@/lib/stores/worktrees");

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

vi.mock("@/components/VscodeWorkbenchPane", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");

  function MockVscodeWorkbenchPane({
    worktree,
    active,
  }: {
    worktree: { id: string; name: string };
    active: boolean;
  }) {
    useEffect(() => {
      vscodePaneMountCounts[worktree.id] =
        (vscodePaneMountCounts[worktree.id] ?? 0) + 1;

      return () => {
        vscodePaneUnmountCounts[worktree.id] =
          (vscodePaneUnmountCounts[worktree.id] ?? 0) + 1;
      };
    }, [worktree.id]);

    return (
      <div
        data-testid={`vscode-pane-${worktree.id}`}
        data-active={active ? "true" : "false"}
      >
        VS Code pane: {worktree.name}
      </div>
    );
  }

  return {
    default: MockVscodeWorkbenchPane,
  };
});

describe("App", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    localStorage.clear();
    worktreeViewRenderCount = 0;
    for (const key of Object.keys(vscodePaneMountCounts)) {
      delete vscodePaneMountCounts[key];
    }
    for (const key of Object.keys(vscodePaneUnmountCounts)) {
      delete vscodePaneUnmountCounts[key];
    }
    setMobile(false);

    const { useProjectStore } = await import("@/lib/stores/projects");
    const { useWorktreeStore } = await import("@/lib/stores/worktrees");
    const { resetTabStoreForTests } = await import("@/lib/stores/tabs");
    const { resetSidebarWidthStoreForTests, useSidebarWidthStore } =
      await import("@/lib/stores/sidebarWidth");
    const { resetWorktreeRightSidebarStoreForTests } =
      await import("@/lib/stores/worktreeRightSidebar");
    const { resetSettingsStoreForTests } =
      await import("@/lib/stores/settings");
    const { resetVscodeWorkbenchStoreForTests } =
      await import("@/lib/stores/vscodeWorkbench");

    resetTabStoreForTests();
    resetSidebarWidthStoreForTests();
    resetWorktreeRightSidebarStoreForTests();
    resetSettingsStoreForTests();
    resetVscodeWorkbenchStoreForTests();

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
            source_ref: null,
            ui_mode: "hubris",
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
            source_ref: null,
            ui_mode: "hubris",
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
    const { useWorktreeStore } = await import("@/lib/stores/worktrees");
    const { default: App } = await import("./App");

    render(<App />);

    expect(screen.getByText("Active worktree: local")).toBeInTheDocument();

    act(() => {
      useWorktreeStore.getState().select("w-feature");
    });

    expect(screen.getByText("Active worktree: feature-a")).toBeInTheDocument();
  }, 10_000);

  it("updates sidebar width via DOM subscription without rerendering the main pane", async () => {
    const { useSidebarWidthStore } = await import("@/lib/stores/sidebarWidth");
    const { default: App } = await import("./App");

    render(<App />);

    const sidebarWrapper = document.querySelector<HTMLElement>(
      "[data-slot='sidebar-wrapper']",
    );

    expect(sidebarWrapper).not.toBeNull();
    expect(sidebarWrapper?.style.getPropertyValue("--sidebar-width")).toBe(
      "256px",
    );
    const initialRenderCount = worktreeViewRenderCount;
    expect(initialRenderCount).toBeGreaterThan(0);

    act(() => {
      useSidebarWidthStore.getState().setWidth(320);
      useSidebarWidthStore.getState().setWidth(360);
      useSidebarWidthStore.getState().setWidth(400);
    });

    expect(sidebarWrapper?.style.getPropertyValue("--sidebar-width")).toBe(
      "400px",
    );
    expect(worktreeViewRenderCount).toBe(initialRenderCount);

    act(() => {
      useSidebarWidthStore.getState().setResizing(true);
    });

    expect(sidebarWrapper).toHaveClass("sidebar-resizing");

    act(() => {
      useSidebarWidthStore.getState().setResizing(false);
    });

    expect(sidebarWrapper).not.toHaveClass("sidebar-resizing");
  });

  it("opens the mobile right sidebar on the first tap in mobile view", async () => {
    setMobile(true);
    const { useWorktreeRightSidebarStore } =
      await import("@/lib/stores/worktreeRightSidebar");
    useWorktreeRightSidebarStore.setState({
      desktopOpen: false,
      mobileOpen: false,
    });
    const { default: App } = await import("./App");

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Show file manager" }));

    expect(useWorktreeRightSidebarStore.getState().mobileOpen).toBe(true);
    expect(useWorktreeRightSidebarStore.getState().desktopOpen).toBe(false);
  });

  it("opens the desktop right sidebar in desktop view", async () => {
    const { useWorktreeRightSidebarStore } =
      await import("@/lib/stores/worktreeRightSidebar");
    useWorktreeRightSidebarStore.setState({
      desktopOpen: false,
      mobileOpen: false,
    });
    const { default: App } = await import("./App");

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Show file manager" }));

    expect(useWorktreeRightSidebarStore.getState().desktopOpen).toBe(true);
    expect(useWorktreeRightSidebarStore.getState().mobileOpen).toBe(false);
  });

  it("shows a global warning when the settings file is invalid", async () => {
    const { useSettingsStore } = await import("@/lib/stores/settings");
    useSettingsStore.setState({
      status: {
        kind: "invalidFile",
        writesBlocked: true,
        message: "expected a ] while parsing settings.toml",
      },
    });
    const { default: App } = await import("./App");

    render(<App />);

    expect(screen.getByText("Settings file is invalid")).toBeInTheDocument();
    expect(
      screen.getByText(/saves are blocked until the file becomes valid again/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/expected a \] while parsing settings\.toml/i),
    ).toBeInTheDocument();
  });

  it("hides the file manager control in vscode mode", async () => {
    const { useWorktreeStore } = await import("@/lib/stores/worktrees");
    useWorktreeStore.setState((state) => ({
      worktreesByProject: {
        ...state.worktreesByProject,
        p1: (state.worktreesByProject.p1 ?? []).map((worktree) =>
          worktree.id === "w-local"
            ? { ...worktree, ui_mode: "vscode" }
            : worktree,
        ),
      },
    }));
    const { default: App } = await import("./App");

    render(<App />);

    expect(screen.getByRole("button", { name: "Hubris" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "VS Code" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /file manager/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps VS Code panes mounted across worktree switches and mode toggles", async () => {
    const { useWorktreeStore } = await import("@/lib/stores/worktrees");
    useWorktreeStore.setState((state) => ({
      worktreesByProject: {
        ...state.worktreesByProject,
        p1: (state.worktreesByProject.p1 ?? []).map((worktree) => ({
          ...worktree,
          ui_mode: "vscode" as const,
        })),
      },
    }));
    const { default: App } = await import("./App");

    render(<App />);

    expect(screen.getByTestId("vscode-pane-w-local")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(vscodePaneMountCounts["w-local"]).toBe(1);

    act(() => {
      useWorktreeStore.getState().select("w-feature");
    });

    expect(screen.getByTestId("vscode-pane-w-local")).toHaveAttribute(
      "data-active",
      "false",
    );
    expect(screen.getByTestId("vscode-pane-w-feature")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(vscodePaneMountCounts["w-local"]).toBe(1);
    expect(vscodePaneMountCounts["w-feature"]).toBe(1);

    act(() => {
      useWorktreeStore.setState((state) => ({
        worktreesByProject: {
          ...state.worktreesByProject,
          p1: (state.worktreesByProject.p1 ?? []).map((worktree) =>
            worktree.id === "w-local"
              ? { ...worktree, ui_mode: "hubris" as const }
              : worktree,
          ),
        },
      }));
      useWorktreeStore.getState().select("w-local");
    });

    expect(screen.getByText("Active worktree: local")).toBeInTheDocument();
    expect(screen.getByTestId("vscode-pane-w-local")).toHaveAttribute(
      "data-active",
      "false",
    );

    act(() => {
      useWorktreeStore.setState((state) => ({
        worktreesByProject: {
          ...state.worktreesByProject,
          p1: (state.worktreesByProject.p1 ?? []).map((worktree) =>
            worktree.id === "w-local"
              ? { ...worktree, ui_mode: "vscode" as const }
              : worktree,
          ),
        },
      }));
    });

    expect(screen.getByTestId("vscode-pane-w-local")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(vscodePaneMountCounts["w-local"]).toBe(1);
    expect(vscodePaneUnmountCounts["w-local"] ?? 0).toBe(0);
  });

  it("removes cached VS Code panes when the worktree disappears", async () => {
    const { useWorktreeStore } = await import("@/lib/stores/worktrees");
    useWorktreeStore.setState((state) => ({
      worktreesByProject: {
        ...state.worktreesByProject,
        p1: (state.worktreesByProject.p1 ?? []).map((worktree) =>
          worktree.id === "w-local"
            ? { ...worktree, ui_mode: "vscode" as const }
            : worktree,
        ),
      },
    }));
    const { default: App } = await import("./App");

    render(<App />);
    expect(screen.getByTestId("vscode-pane-w-local")).toBeInTheDocument();

    act(() => {
      useWorktreeStore.setState((state) => ({
        worktreesByProject: {
          ...state.worktreesByProject,
          p1: (state.worktreesByProject.p1 ?? []).filter(
            (worktree) => worktree.id !== "w-local",
          ),
        },
        selectedWorktreeId: "w-feature",
      }));
    });

    expect(screen.queryByTestId("vscode-pane-w-local")).not.toBeInTheDocument();
    expect(vscodePaneUnmountCounts["w-local"]).toBe(1);
  });

  it("switches the active Hubris tab when the selected worktree changes", async () => {
    const { useTabStore } = await import("@/lib/stores/tabs");
    const { useWorktreeStore } = await import("@/lib/stores/worktrees");
    useTabStore.setState({
      tabs: [
        {
          id: "tab-local",
          label: "local",
          position: 1,
          worktree_id: "w-local",
          session_id: "default",
          type: "terminal",
          created_at: 0,
          preview: false,
        },
        {
          id: "tab-feature",
          label: "feature",
          position: 2,
          worktree_id: "w-feature",
          session_id: "default",
          type: "terminal",
          created_at: 1,
          preview: false,
        },
      ],
      activeTabId: "tab-local",
      activeTabByWorktree: {
        "w-local": "tab-local",
        "w-feature": "tab-feature",
      },
    });
    const { default: App } = await import("./App");

    render(<App />);
    expect(useTabStore.getState().activeTabId).toBe("tab-local");

    act(() => {
      useWorktreeStore.getState().select("w-feature");
    });

    expect(useTabStore.getState().activeTabId).toBe("tab-feature");
  });
});
