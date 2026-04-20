import { describe, expect, it } from "vitest";
import { buildCommandContextSnapshot } from "./context";
import { getCommandPaletteItems } from "./items";

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

function makeTerminalTab(
  id: string,
  worktreeId: string,
  label: string,
  position: number,
) {
  return {
    id,
    label,
    position,
    worktree_id: worktreeId,
    pane_id: "pane-1",
    session_id: "default",
    type: "terminal" as const,
    created_at: 0,
    preview: false,
  };
}

describe("command palette items", () => {
  it("combines static commands with dynamic state-backed items", () => {
    const project = makeProject("p1", "Devbox");
    const selectedWorktree = makeWorktree("w1", project.id, "local", {
      branch: "main",
      position: 1,
      ui_mode: "hubris",
    });
    const siblingWorktree = makeWorktree("w2", project.id, "feature-a", {
      branch: "feature-a",
      position: 2,
      ui_mode: "vscode",
    });
    const activeTab = makeTerminalTab("t1", selectedWorktree.id, "Shell", 1);
    const secondaryTab = makeTerminalTab("t2", selectedWorktree.id, "Logs", 2);

    const items = getCommandPaletteItems(
      buildCommandContextSnapshot({
        activeTabId: activeTab.id,
        focusedPaneByWorktree: { [selectedWorktree.id]: "pane-1" },
        projects: [project],
        selectedWorktreeId: selectedWorktree.id,
        tabs: [activeTab, secondaryTab],
        worktreesByProject: {
          [project.id]: [selectedWorktree, siblingWorktree],
        },
      }),
    );

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "app.openSettings",
          key: "app.openSettings",
          title: "Open Settings",
        }),
        expect.objectContaining({
          args: { projectId: project.id },
          id: "worktree.create",
          key: `worktree.create:${project.id}`,
          subtitle: project.name,
          title: `New Worktree in ${project.name}`,
        }),
        expect.objectContaining({
          args: { worktreeId: siblingWorktree.id },
          id: "worktree.select",
          key: `worktree.select:${siblingWorktree.id}`,
          subtitle: siblingWorktree.branch,
          title: `Switch to ${siblingWorktree.name}`,
        }),
        expect.objectContaining({
          args: { tabId: secondaryTab.id },
          id: "tab.focus",
          key: `tab.focus:${secondaryTab.id}`,
          subtitle: secondaryTab.type,
          title: `Focus ${secondaryTab.label}`,
        }),
      ]),
    );
  });

  it("filters unavailable commands when required context is missing", () => {
    const project = makeProject("p1", "Devbox");
    const worktree = makeWorktree("w1", project.id, "local");

    const items = getCommandPaletteItems(
      buildCommandContextSnapshot({
        activeTabId: null,
        focusedPaneByWorktree: {},
        projects: [project],
        selectedWorktreeId: null,
        tabs: [],
        worktreesByProject: {
          [project.id]: [worktree],
        },
      }),
    );

    expect(items.some((item) => item.id === "tab.close")).toBe(false);
    expect(items.some((item) => item.id === "tab.newTerminal")).toBe(false);
  });

  it("skips dynamic items that would duplicate the current selection", () => {
    const project = makeProject("p1", "Devbox");
    const selectedWorktree = makeWorktree("w1", project.id, "local", {
      branch: "main",
    });
    const siblingWorktree = makeWorktree("w2", project.id, "feature-a", {
      branch: "feature-a",
    });
    const activeTab = makeTerminalTab("t1", selectedWorktree.id, "Shell", 1);
    const offscreenTab = makeTerminalTab(
      "t2",
      siblingWorktree.id,
      "Elsewhere",
      2,
    );

    const items = getCommandPaletteItems(
      buildCommandContextSnapshot({
        activeTabId: activeTab.id,
        focusedPaneByWorktree: { [selectedWorktree.id]: "pane-1" },
        projects: [project],
        selectedWorktreeId: selectedWorktree.id,
        tabs: [activeTab, offscreenTab],
        worktreesByProject: {
          [project.id]: [selectedWorktree, siblingWorktree],
        },
      }),
    );

    expect(
      items.some(
        (item) => item.key === `worktree.select:${selectedWorktree.id}`,
      ),
    ).toBe(false);
    expect(items.some((item) => item.key === `tab.focus:${activeTab.id}`)).toBe(
      false,
    );
    expect(
      items.some((item) => item.key === `tab.focus:${offscreenTab.id}`),
    ).toBe(false);
  });
});
