// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetBootstrapForTests } from "@/lib/bootstrap";
import { useCommandUiStore } from "@/lib/stores/commandUi";
import { useProjectStore } from "@/lib/stores/projects";
import { useTabStore } from "@/lib/stores/tabs";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import { commandIds, getCommandDefinition } from "./registry";
import { executeCommand, getCommandAvailability } from "./runtime";

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

function makeWorktree(
  id: string,
  projectId: string,
  name: string,
  overrides: Partial<{
    branch: string;
    is_local: boolean;
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
    is_local: overrides.is_local ?? false,
    missing_on_disk: false,
    position: overrides.position ?? 1,
  };
}

function makeTerminalTab(id: string, worktreeId: string, paneId = "pane-1") {
  return {
    id,
    label: `Tab ${id}`,
    position: 1,
    worktree_id: worktreeId,
    pane_id: paneId,
    session_id: "default",
    type: "terminal" as const,
    created_at: 0,
    preview: false,
  };
}

function seedContext() {
  const projectOne = makeProject("p1", "Alpha");
  const projectTwo = makeProject("p2", "Beta");
  const worktreeOne = makeWorktree("w1", "p1", "local", {
    is_local: true,
  });
  const worktreeTwo = makeWorktree("w2", "p2", "feature");

  useProjectStore.setState({
    projects: [projectOne, projectTwo],
  });
  useWorktreeStore.setState({
    selectedWorktreeId: worktreeOne.id,
    worktreesByProject: {
      [projectOne.id]: [worktreeOne],
      [projectTwo.id]: [worktreeTwo],
    },
  });
  useTabStore.setState({
    activeTabId: "t1",
    focusedPaneByWorktree: {
      [worktreeOne.id]: "pane-1",
    },
    tabs: [makeTerminalTab("t1", worktreeOne.id)],
  });

  return {
    projectOne,
    projectTwo,
    worktreeOne,
    worktreeTwo,
  };
}

describe("command runtime", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBootstrapForTests();
    vi.restoreAllMocks();
  });

  it("registers stable command ids and palette metadata", () => {
    expect(commandIds()).toEqual(
      expect.arrayContaining([
        "project.add",
        "worktree.create",
        "tab.newTerminal",
        "settings.openSection",
      ]),
    );

    expect(getCommandDefinition("worktree.create")).toMatchObject({
      group: "Worktrees",
      id: "worktree.create",
      title: "New Worktree",
    });
  });

  it("derives availability from the current frontend context", () => {
    expect(getCommandAvailability("tab.newTerminal")).toEqual({
      enabled: false,
      reason: "Select a worktree first",
    });

    seedContext();

    expect(getCommandAvailability("tab.newTerminal")).toEqual({
      enabled: true,
      reason: undefined,
    });
  });

  it("lets explicit args override derived context during execution", async () => {
    const { projectTwo, worktreeTwo } = seedContext();
    const createSpy = vi
      .spyOn(useWorktreeStore.getState(), "create")
      .mockResolvedValue(worktreeTwo);

    const result = await executeCommand({
      args: { branch: "release", projectId: projectTwo.id },
      id: "worktree.create",
      source: "system",
    });

    expect(result).toEqual({ status: "success" });
    expect(createSpy).toHaveBeenCalledWith(
      projectTwo.id,
      "release",
      undefined,
      undefined,
    );
  });

  it("opens a command-owned dialog when required args are missing", async () => {
    const { projectOne } = seedContext();

    const result = await executeCommand({
      args: { projectId: projectOne.id },
      id: "worktree.create",
      source: "button",
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(useCommandUiStore.getState().dialog).toEqual({
      projectId: projectOne.id,
      type: "add-worktree",
    });
  });
});
