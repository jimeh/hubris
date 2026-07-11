// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMobile } from "@/test/mobile";
import App from "./App";
import { executeCommand } from "@/lib/commands";
import {
  resetAppSidebarStoreForTests,
  useAppSidebarStore,
} from "@/lib/stores/appSidebar";
import { useProjectStore } from "@/lib/stores/projects";
import { resetTabStoreForTests } from "@/lib/stores/tabs";
import {
  resetSidebarWidthStoreForTests,
  useSidebarWidthStore,
} from "@/lib/stores/sidebarWidth";
import {
  resetWorktreeRightSidebarStoreForTests,
  useWorktreeRightSidebarStore,
} from "@/lib/stores/worktreeRightSidebar";
import {
  resetSettingsStoreForTests,
  useSettingsStore,
} from "@/lib/stores/settings";
import { resetHubrisWorkbenchStoreForTests } from "@/lib/stores/hubrisWorkbench";
import { resetVscodeWorkbenchStoreForTests } from "@/lib/stores/vscodeWorkbench";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import { useTabStore } from "@/lib/stores/tabs";
import { normalizedTabState } from "@/test/tabs";

let worktreeViewRenderCount = 0;
const hubrisViewMountCounts: Record<string, number> = {};
const hubrisViewUnmountCounts: Record<string, number> = {};
const vscodePaneMountCounts: Record<string, number> = {};
const vscodePaneUnmountCounts: Record<string, number> = {};

vi.mock("@/components/SidebarResizeHandle", () => ({
  default: () => null,
}));

vi.mock("@/components/AppSidebar", () => {
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

vi.mock("@/components/WorktreeView", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");

  function MockWorktreeView({
    worktree,
    active,
  }: {
    worktree: { id: string; name: string };
    active: boolean;
  }) {
    // eslint-disable-next-line react-hooks/globals
    worktreeViewRenderCount += 1;

    useEffect(() => {
      hubrisViewMountCounts[worktree.id] =
        (hubrisViewMountCounts[worktree.id] ?? 0) + 1;

      return () => {
        hubrisViewUnmountCounts[worktree.id] =
          (hubrisViewUnmountCounts[worktree.id] ?? 0) + 1;
      };
    }, [worktree.id]);

    return (
      <div
        data-testid={`hubris-view-${worktree.id}`}
        data-active={active ? "true" : "false"}
      >
        Active worktree: {worktree.name}
      </div>
    );
  }

  return { default: MockWorktreeView };
});

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
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    worktreeViewRenderCount = 0;
    for (const key of Object.keys(hubrisViewMountCounts)) {
      delete hubrisViewMountCounts[key];
    }
    for (const key of Object.keys(hubrisViewUnmountCounts)) {
      delete hubrisViewUnmountCounts[key];
    }
    for (const key of Object.keys(vscodePaneMountCounts)) {
      delete vscodePaneMountCounts[key];
    }
    for (const key of Object.keys(vscodePaneUnmountCounts)) {
      delete vscodePaneUnmountCounts[key];
    }
    setMobile(false);

    resetTabStoreForTests();
    resetAppSidebarStoreForTests();
    resetSidebarWidthStoreForTests();
    resetWorktreeRightSidebarStoreForTests();
    resetSettingsStoreForTests();
    resetHubrisWorkbenchStoreForTests();
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
    render(<App />);

    expect(screen.getByTestId("hubris-view-w-local")).toHaveAttribute(
      "data-active",
      "true",
    );

    act(() => {
      useWorktreeStore.getState().select("w-feature");
    });

    expect(screen.getByTestId("hubris-view-w-local")).toHaveAttribute(
      "data-active",
      "false",
    );
    expect(screen.getByTestId("hubris-view-w-feature")).toHaveAttribute(
      "data-active",
      "true",
    );
  }, 10_000);

  it("registers the left sidebar toggle command controller", async () => {
    render(<App />);

    expect(useAppSidebarStore.getState().controller).not.toBeNull();

    let result: unknown;
    await act(async () => {
      result = await executeCommand({
        id: "app.toggleLeftSidebar",
        source: "system",
      });
    });

    expect(result).toEqual({ status: "success" });
    expect(document.cookie).toContain("sidebar_state=false");
  });

  it("updates sidebar width via DOM subscription without rerendering the main pane", async () => {
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
    useWorktreeRightSidebarStore.setState({
      desktopOpen: false,
      mobileOpen: false,
    });

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Show file manager" }));

    expect(useWorktreeRightSidebarStore.getState().mobileOpen).toBe(true);
    expect(useWorktreeRightSidebarStore.getState().desktopOpen).toBe(false);
  });

  it("opens the desktop right sidebar in desktop view", async () => {
    useWorktreeRightSidebarStore.setState({
      desktopOpen: false,
      mobileOpen: false,
    });

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Show file manager" }));

    expect(useWorktreeRightSidebarStore.getState().desktopOpen).toBe(true);
    expect(useWorktreeRightSidebarStore.getState().mobileOpen).toBe(false);
  });

  it("shows a global warning when the settings file is invalid", async () => {
    useSettingsStore.setState({
      status: {
        kind: "invalidFile",
        writesBlocked: true,
        message: "expected a ] while parsing settings.toml",
      },
    });
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
    render(<App />);

    expect(screen.getByRole("button", { name: "Hubris" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "VS Code" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /file manager/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the mode switcher before the title block", async () => {
    render(<App />);

    const modeSwitcher = screen.getByRole("group", { name: "Worktree mode" });
    const projectTitle = screen.getAllByText("Devbox")[0];

    expect(
      modeSwitcher.compareDocumentPosition(projectTitle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("keeps VS Code panes mounted across worktree switches and mode toggles", async () => {
    useWorktreeStore.setState((state) => ({
      worktreesByProject: {
        ...state.worktreesByProject,
        p1: (state.worktreesByProject.p1 ?? []).map((worktree) => ({
          ...worktree,
          ui_mode: "vscode" as const,
        })),
      },
    }));
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

    expect(screen.getByTestId("hubris-view-w-local")).toHaveAttribute(
      "data-active",
      "true",
    );
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

  it("keeps Hubris worktree views mounted across worktree switches", async () => {
    render(<App />);

    expect(screen.getByTestId("hubris-view-w-local")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(hubrisViewMountCounts["w-local"]).toBe(1);

    act(() => {
      useWorktreeStore.getState().select("w-feature");
    });

    expect(screen.getByTestId("hubris-view-w-local")).toHaveAttribute(
      "data-active",
      "false",
    );
    expect(screen.getByTestId("hubris-view-w-feature")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(hubrisViewMountCounts["w-local"]).toBe(1);
    expect(hubrisViewMountCounts["w-feature"]).toBe(1);

    act(() => {
      useWorktreeStore.getState().select("w-local");
    });

    expect(screen.getByTestId("hubris-view-w-local")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByTestId("hubris-view-w-feature")).toHaveAttribute(
      "data-active",
      "false",
    );
    expect(hubrisViewMountCounts["w-local"]).toBe(1);
    expect(hubrisViewUnmountCounts["w-local"] ?? 0).toBe(0);
  });

  it("removes cached Hubris views when the worktree disappears", async () => {
    render(<App />);

    expect(screen.getByTestId("hubris-view-w-local")).toBeInTheDocument();

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

    expect(screen.queryByTestId("hubris-view-w-local")).not.toBeInTheDocument();
    expect(hubrisViewUnmountCounts["w-local"]).toBe(1);
  });

  it("switches the active Hubris tab when the selected worktree changes", async () => {
    useTabStore.setState({
      ...normalizedTabState([
        {
          id: "tab-local",
          label: "local",
          position: 1,
          worktree_id: "w-local",
          pane_id: "pane-local",
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
          pane_id: "pane-feature",
          session_id: "default",
          type: "terminal",
          created_at: 1,
          preview: false,
        },
      ]),
      activeTabId: "tab-local",
      activeTabByWorktree: {
        "w-local": "tab-local",
        "w-feature": "tab-feature",
      },
    });
    render(<App />);
    expect(useTabStore.getState().activeTabId).toBe("tab-local");

    act(() => {
      useWorktreeStore.getState().select("w-feature");
    });

    expect(useTabStore.getState().activeTabId).toBe("tab-feature");
  });

  it("reactivates the remembered tab when tabs load after the selected worktree", async () => {
    useWorktreeStore.setState({ selectedWorktreeId: "w-feature" });
    useTabStore.setState({
      ...normalizedTabState([]),
      activeTabId: null,
      activeTabByWorktree: {
        "w-feature": "tab-feature",
      },
    });

    render(<App />);

    expect(useTabStore.getState().activeTabId).toBeNull();

    act(() => {
      useTabStore.setState((state) => ({
        ...state,
        ...normalizedTabState([
          {
            id: "tab-feature",
            label: "feature",
            position: 1,
            worktree_id: "w-feature",
            pane_id: "pane-feature",
            session_id: "default",
            type: "terminal",
            created_at: 0,
            preview: false,
          },
        ]),
      }));
    });

    expect(useTabStore.getState().activeTabId).toBe("tab-feature");
  });
});
