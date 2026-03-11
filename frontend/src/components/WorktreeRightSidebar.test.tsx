// @vitest-environment jsdom
import { useEffect, type ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Worktree } from "@/lib/types";

vi.mock("@/components/WorktreeGitStatusPanel", () => ({
  default: function MockWorktreeGitStatusPanel({
    onActionsChange,
  }: {
    worktree: Worktree;
    onActionsChange?: (actions: ReactNode | null) => void;
  }) {
    useEffect(() => {
      onActionsChange?.(<button type="button">Panel action</button>);
      return () => onActionsChange?.(null);
    }, [onActionsChange]);

    return <div>Git panel body</div>;
  },
}));

function setMobile(matches: boolean): void {
  window.innerWidth = matches ? 640 : 1280;
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation(() => ({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

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

describe("WorktreeRightSidebar", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    localStorage.clear();
    setMobile(false);

    const { resetWorktreeRightSidebarStoreForTests } =
      await import("@/lib/stores/worktreeRightSidebar");
    const { resetWorktreeRightSidebarWidthStoreForTests } =
      await import("@/lib/stores/worktreeRightSidebarWidth");
    resetWorktreeRightSidebarStoreForTests();
    resetWorktreeRightSidebarWidthStoreForTests();
  });

  it("renders the active panel and resize handle on desktop", async () => {
    const { default: WorktreeRightSidebar } =
      await import("./WorktreeRightSidebar");

    render(<WorktreeRightSidebar worktree={makeWorktree()} />);

    expect(screen.getByText("Git panel body")).toBeInTheDocument();
    const panel = document.querySelector<HTMLElement>(
      "[data-worktree-right-sidebar-panel]",
    );
    expect(panel).toHaveClass("h-full");
    const gap = document.querySelector<HTMLElement>(
      "[data-worktree-right-sidebar-gap]",
    );
    expect(gap?.style.width).toBe("var(--worktree-right-sidebar-width, 320px)");
    expect(
      screen.getByRole("button", { name: "Resize right sidebar" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Collapse right sidebar" }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Panel action" }),
      ).toBeInTheDocument();
    });
  });

  it("hides completely when collapsed on desktop", async () => {
    const { useWorktreeRightSidebarStore } =
      await import("@/lib/stores/worktreeRightSidebar");
    useWorktreeRightSidebarStore.setState({
      desktopOpen: false,
      mobileOpen: false,
    });
    const { default: WorktreeRightSidebar } =
      await import("./WorktreeRightSidebar");

    render(<WorktreeRightSidebar worktree={makeWorktree()} />);

    const host = document.querySelector<HTMLElement>(
      "[data-worktree-right-sidebar-wrapper]",
    );
    const gap = document.querySelector<HTMLElement>(
      "[data-worktree-right-sidebar-gap]",
    );
    const panel = document.querySelector<HTMLElement>(
      "[data-worktree-right-sidebar-panel]",
    );
    expect(host).not.toBeNull();
    expect(host?.dataset.state).toBe("closed");
    expect(gap?.style.width).toBe("0px");
    expect(panel).toHaveClass("translate-x-full");
    expect(
      screen.queryByRole("button", { name: "Resize right sidebar" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Git panel body")).toBeInTheDocument();
  });

  it("renders the mobile sheet with the active panel content", async () => {
    setMobile(true);
    const { useWorktreeRightSidebarStore } =
      await import("@/lib/stores/worktreeRightSidebar");
    useWorktreeRightSidebarStore.setState({
      desktopOpen: true,
      mobileOpen: true,
    });
    const { default: WorktreeRightSidebar } =
      await import("./WorktreeRightSidebar");

    render(<WorktreeRightSidebar worktree={makeWorktree()} />);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("Git panel body")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Resize right sidebar" }),
    ).not.toBeInTheDocument();
  });
});
