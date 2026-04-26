// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorktreeHistorySwitcher from "./WorktreeHistorySwitcher";
import { useProjectStore } from "@/lib/stores/projects";
import { useWorktreeHistorySwitcherStore } from "@/lib/stores/worktreeHistorySwitcher";
import { useWorktreeStore } from "@/lib/stores/worktrees";

vi.mock("@/components/ui/command", () => ({
  CommandDialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open: boolean;
  }) => (open ? <div role="dialog">{children}</div> : null),
  CommandGroup: ({
    children,
    heading,
  }: {
    children: React.ReactNode;
    heading: string;
  }) => (
    <section>
      <h2>{heading}</h2>
      {children}
    </section>
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
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
    branch: name,
    id,
    is_imported: false,
    is_local: false,
    missing_on_disk: false,
    name,
    path: `/tmp/${name}`,
    position: 1,
    project_id: projectId,
    source_ref: null,
    ui_mode: "hubris" as const,
  };
}

describe("WorktreeHistorySwitcher", () => {
  beforeEach(() => {
    useWorktreeHistorySwitcherStore.getState().cancel();
    useProjectStore.setState({
      projects: [makeProject("p1", "Hubris"), makeProject("p2", "Dotfiles")],
    });
    useWorktreeStore.setState({
      worktreesByProject: {
        p1: [makeWorktree("w1", "p1", "main")],
        p2: [makeWorktree("w2", "p2", "feature")],
      },
    });
  });

  it("renders recent worktrees with project and branch context", () => {
    useWorktreeHistorySwitcherStore.getState().start(["w1", "w2"], "back");

    render(<WorktreeHistorySwitcher />);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("Hubris • main")).toBeInTheDocument();
    expect(screen.getByText("feature")).toBeInTheDocument();
    expect(screen.getByText("Dotfiles • feature")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
  });
});
