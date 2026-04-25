// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiStatusError } from "@/lib/api";
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

function makeProject(id: string, name: string, position = 1) {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    position,
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
  const projectOne = makeProject("p1", "Alpha", 1);
  const projectTwo = makeProject("p2", "Beta", 2);
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
        "project.selectNext",
        "project.selectPrevious",
        "worktree.create",
        "worktree.import",
        "worktree.navigateBack",
        "worktree.navigateForward",
        "worktree.selectNext",
        "worktree.selectPrevious",
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

  it("routes worktree import through the command runtime", async () => {
    const { projectTwo, worktreeTwo } = seedContext();
    const importSpy = vi
      .spyOn(useWorktreeStore.getState(), "importWorktree")
      .mockResolvedValue(worktreeTwo);

    const result = await executeCommand({
      args: { path: "/tmp/imported", projectId: projectTwo.id },
      id: "worktree.import",
      source: "system",
    });

    expect(result).toEqual({ status: "success" });
    expect(importSpy).toHaveBeenCalledWith(projectTwo.id, "/tmp/imported");
  });

  it("switches to the next and previous project local worktree", async () => {
    const { projectTwo, worktreeOne, worktreeTwo } = seedContext();
    const projectTwoLocal = makeWorktree("w2-local", projectTwo.id, "local", {
      is_local: true,
      position: 1,
    });
    useWorktreeStore.setState({
      worktreesByProject: {
        p1: [worktreeOne],
        p2: [
          projectTwoLocal,
          {
            ...worktreeTwo,
            position: 2,
          },
        ],
      },
    });

    await expect(
      executeCommand({ id: "project.selectNext", source: "system" }),
    ).resolves.toEqual({ status: "success" });
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe(
      projectTwoLocal.id,
    );

    await expect(
      executeCommand({ id: "project.selectPrevious", source: "system" }),
    ).resolves.toEqual({ status: "success" });
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe(worktreeOne.id);
  });

  it("switches to worktrees across projects in sidebar order", async () => {
    const { projectOne, projectTwo, worktreeOne, worktreeTwo } = seedContext();
    const feature = makeWorktree("w1-feature", projectOne.id, "feature", {
      position: 2,
    });
    const release = makeWorktree("w1-release", projectOne.id, "release", {
      position: 3,
    });
    useWorktreeStore.setState({
      selectedWorktreeId: worktreeOne.id,
      worktreesByProject: {
        [projectOne.id]: [worktreeOne, feature, release],
        [projectTwo.id]: [worktreeTwo],
      },
    });

    await expect(
      executeCommand({ id: "worktree.selectPrevious", source: "system" }),
    ).resolves.toEqual({ status: "success" });
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe(worktreeTwo.id);

    await expect(
      executeCommand({ id: "worktree.selectNext", source: "system" }),
    ).resolves.toEqual({ status: "success" });
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe(worktreeOne.id);

    await expect(
      executeCommand({ id: "worktree.selectNext", source: "system" }),
    ).resolves.toEqual({ status: "success" });
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe(feature.id);
  });

  it("opens the worktree picker when switching without a target", async () => {
    seedContext();

    await expect(
      executeCommand({ id: "worktree.select", source: "system" }),
    ).resolves.toEqual({ status: "cancelled" });
    expect(useCommandUiStore.getState().dialog).toEqual({
      type: "select-worktree",
    });
  });

  it("navigates worktree history through commands", async () => {
    const { worktreeOne, worktreeTwo } = seedContext();
    useWorktreeStore.setState({
      navigationBackIds: [worktreeTwo.id],
      navigationForwardIds: [],
      selectedWorktreeId: worktreeOne.id,
    });

    expect(getCommandAvailability("worktree.navigateBack")).toEqual({
      enabled: true,
      reason: undefined,
    });

    await expect(
      executeCommand({ id: "worktree.navigateBack", source: "system" }),
    ).resolves.toEqual({ status: "success" });
    expect(useWorktreeStore.getState()).toMatchObject({
      navigationBackIds: [],
      navigationForwardIds: [worktreeOne.id],
      selectedWorktreeId: worktreeTwo.id,
    });
  });

  it("cycles the current worktree UI mode", async () => {
    const { projectOne, worktreeOne } = seedContext();
    const updateSpy = vi
      .spyOn(useWorktreeStore.getState(), "updateUiMode")
      .mockResolvedValue(undefined);

    expect(
      getCommandAvailability("worktree.setUiMode", { uiMode: "cycle" }),
    ).toEqual({
      enabled: true,
      reason: undefined,
    });

    await expect(
      executeCommand({
        args: { uiMode: "cycle" },
        id: "worktree.setUiMode",
        source: "keyboard-shortcut",
      }),
    ).resolves.toEqual({ status: "success" });

    expect(updateSpy).toHaveBeenCalledWith(
      projectOne.id,
      worktreeOne.id,
      "vscode",
    );
  });

  it("cycles VS Code worktrees back to Hubris mode", async () => {
    const { projectOne, worktreeOne } = seedContext();
    useWorktreeStore.setState({
      selectedWorktreeId: worktreeOne.id,
      worktreesByProject: {
        [projectOne.id]: [{ ...worktreeOne, ui_mode: "vscode" }],
      },
    });
    const updateSpy = vi
      .spyOn(useWorktreeStore.getState(), "updateUiMode")
      .mockResolvedValue(undefined);

    await expect(
      executeCommand({
        args: { uiMode: "cycle" },
        id: "worktree.setUiMode",
        source: "keyboard-shortcut",
      }),
    ).resolves.toEqual({ status: "success" });

    expect(updateSpy).toHaveBeenCalledWith(
      projectOne.id,
      worktreeOne.id,
      "hubris",
    );
  });

  it("reopens project removal in force mode on 409 conflicts", async () => {
    const { projectOne } = seedContext();
    vi.spyOn(useProjectStore.getState(), "remove").mockRejectedValue(
      new ApiStatusError(409),
    );

    const result = await executeCommand({
      args: {
        deleteManagedWorktrees: true,
        projectId: projectOne.id,
      },
      id: "project.remove",
      source: "button",
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(useCommandUiStore.getState().dialog).toEqual({
      forceManagedDelete: true,
      projectId: projectOne.id,
      type: "remove-project",
    });
  });

  it("reopens worktree removal in force mode on 409 conflicts", async () => {
    const { projectOne, worktreeOne } = seedContext();
    vi.spyOn(useWorktreeStore.getState(), "remove").mockRejectedValue(
      new ApiStatusError(409),
    );

    const result = await executeCommand({
      args: {
        force: false,
        projectId: projectOne.id,
        worktreeId: worktreeOne.id,
      },
      id: "worktree.remove",
      source: "button",
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(useCommandUiStore.getState().dialog).toEqual({
      forceDelete: true,
      projectId: projectOne.id,
      type: "remove-worktree",
      worktreeId: worktreeOne.id,
    });
  });
});
