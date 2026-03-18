// @vitest-environment jsdom
import { useEffect, type ReactNode } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMobile } from "@/test/mobile";
import type { Worktree } from "@/lib/types";

vi.mock("@/components/WorktreeGitStatusPanel", () => ({
  default: function MockWorktreeGitStatusPanel({
    open = true,
    onActionsChange,
  }: {
    worktree: Worktree;
    open?: boolean;
    onActionsChange?: (actions: ReactNode | null) => void;
  }) {
    useEffect(() => {
      if (!open) {
        onActionsChange?.(null);
        return;
      }

      onActionsChange?.(<button type="button">Panel action</button>);
      return () => onActionsChange?.(null);
    }, [onActionsChange, open]);

    return <div>Git panel body {open ? "open" : "closed"}</div>;
  },
}));

vi.mock("@/components/WorktreeAllFilesPanel", () => ({
  default: function MockWorktreeAllFilesPanel({
    open = true,
    onActionsChange,
  }: {
    worktree: Worktree;
    open?: boolean;
    onActionsChange?: (actions: ReactNode | null) => void;
  }) {
    useEffect(() => {
      if (!open) {
        onActionsChange?.(null);
        return;
      }

      onActionsChange?.(<button type="button">Explorer action</button>);
      return () => onActionsChange?.(null);
    }, [onActionsChange, open]);

    return <div>Files panel body {open ? "open" : "closed"}</div>;
  },
}));

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

  it("renders the active tab and resize handle on desktop", async () => {
    const { default: WorktreeRightSidebar } =
      await import("./WorktreeRightSidebar");

    render(<WorktreeRightSidebar worktree={makeWorktree()} />);

    expect(screen.getByText("Files panel body open")).toBeInTheDocument();
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
        screen.getByRole("button", { name: "Explorer action" }),
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
    expect(panel).toHaveAttribute("aria-hidden", "true");
    expect(panel).toHaveAttribute("inert");
    expect(panel).toHaveClass("translate-x-full");
    expect(
      screen.queryByRole("button", { name: "Resize right sidebar" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Files panel body closed")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Explorer action" }),
    ).not.toBeInTheDocument();
  });

  it("renders the mobile sheet with the active tab content", async () => {
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
    expect(
      within(dialog).getByText("Files panel body open"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Hide right sidebar" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Resize right sidebar" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Hide right sidebar" }),
    );

    await waitFor(() => {
      expect(useWorktreeRightSidebarStore.getState().mobileOpen).toBe(false);
    });
  });
});
