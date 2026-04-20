// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CommandDialogs from "./CommandDialogs";
import CommandPalette from "./CommandPalette";
import { resetBootstrapForTests } from "@/lib/bootstrap";
import { useCommandUiStore } from "@/lib/stores/commandUi";
import { useProjectStore } from "@/lib/stores/projects";
import { useTabStore } from "@/lib/stores/tabs";
import { useWorktreeStore } from "@/lib/stores/worktrees";

vi.mock("@/components/ui/command", () => ({
  CommandDialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open: boolean;
  }) => (open ? <div>{children}</div> : null),
  CommandEmpty: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
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
  CommandInput: ({
    onValueChange,
    placeholder,
    value,
  }: {
    onValueChange?: (value: string) => void;
    placeholder?: string;
    value?: string;
  }) => (
    <input
      aria-label="Command input"
      placeholder={placeholder}
      value={value}
      onChange={(event) => onValueChange?.(event.currentTarget.value)}
    />
  ),
  CommandItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: (value: string) => void;
  }) => <button onClick={() => onSelect?.("")}>{children}</button>,
  CommandList: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/AddProjectDialog", () => ({
  default: ({ onAdd }: { onAdd: (path: string) => Promise<void> }) => (
    <button onClick={() => void onAdd("/tmp/new-project")}>
      Complete Add Project
    </button>
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

function makeWorktree(
  id: string,
  projectId: string,
  name: string,
  overrides: Partial<{
    branch: string;
    position: number;
    ui_mode: "hubris" | "vscode";
  }> = {},
) {
  return {
    id,
    project_id: projectId,
    name,
    path: `/tmp/${name}`,
    branch: overrides.branch ?? name,
    source_ref: null,
    ui_mode: overrides.ui_mode ?? "hubris",
    is_local: false,
    missing_on_disk: false,
    position: overrides.position ?? 1,
  };
}

describe("CommandPalette", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBootstrapForTests();
    vi.restoreAllMocks();
  });

  it("executes a static command directly from the palette", () => {
    useCommandUiStore.setState({ paletteOpen: true });

    render(<CommandPalette />);

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));

    expect(useCommandUiStore.getState().dialog).toEqual({
      section: undefined,
      type: "settings",
    });
  });

  it("renders and executes dynamic worktree switch items", () => {
    const project = makeProject("p1", "Devbox");
    const local = makeWorktree("w1", project.id, "local", {
      branch: "main",
      position: 1,
    });
    const feature = makeWorktree("w2", project.id, "feature-a", {
      branch: "feature-a",
      position: 2,
    });

    useProjectStore.setState({ projects: [project] });
    useWorktreeStore.setState({
      selectedWorktreeId: local.id,
      worktreesByProject: {
        [project.id]: [local, feature],
      },
    });
    useCommandUiStore.setState({ paletteOpen: true });

    render(<CommandPalette />);

    fireEvent.click(
      screen.getByRole("button", { name: /switch to feature-a/i }),
    );

    expect(useWorktreeStore.getState().selectedWorktreeId).toBe(feature.id);
  });

  it("reuses a dialog to gather missing args before completing a command", async () => {
    const addSpy = vi
      .spyOn(useProjectStore.getState(), "add")
      .mockResolvedValue(makeProject("p1", "Devbox"));

    useCommandUiStore.setState({ paletteOpen: true });

    render(
      <>
        <CommandPalette />
        <CommandDialogs />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: /add project/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Complete Add Project" }),
    );

    await waitFor(() => {
      expect(addSpy).toHaveBeenCalledWith("/tmp/new-project");
    });
  });

  it("does not render unavailable commands in the palette", () => {
    useCommandUiStore.setState({ paletteOpen: true });
    useProjectStore.setState({ projects: [] });
    useWorktreeStore.setState({
      selectedWorktreeId: null,
      worktreesByProject: {},
    });
    useTabStore.setState({
      activeTabId: null,
      focusedPaneByWorktree: {},
      tabs: [],
    });

    render(<CommandPalette />);

    expect(
      screen.queryByRole("button", { name: /new terminal tab/i }),
    ).not.toBeInTheDocument();
  });
});
