import { describe, expect, it } from "vitest";
import { buildCommandContextSnapshot } from "@/lib/commands/context";
import { getCommandPaletteItems } from "@/lib/commands/items";

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
          id: "worktree.select",
          key: "worktree.select",
          title: "Switch Worktree",
        }),
        expect.objectContaining({
          id: "tab.newChat",
          key: "tab.newChat",
          title: "New Chat Tab",
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
          searchText: `Switch to ${siblingWorktree.name} ${project.name} ${siblingWorktree.branch}`,
          subtitle: `${project.name} • ${siblingWorktree.branch}`,
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
    expect(items.some((item) => item.key === "worktree.create")).toBe(false);
  });

  it("hides the generic worktree create item when project-scoped items exist", () => {
    const firstProject = makeProject("p1", "Alpha");
    const secondProject = makeProject("p2", "Beta");

    const items = getCommandPaletteItems(
      buildCommandContextSnapshot({
        activeTabId: null,
        focusedPaneByWorktree: {},
        projects: [firstProject, secondProject],
        selectedWorktreeId: null,
        tabs: [],
        worktreesByProject: {},
      }),
    );

    expect(items.some((item) => item.key === "worktree.create")).toBe(false);
    expect(
      items
        .filter((item) => item.id === "worktree.create")
        .map((item) => item.key),
    ).toEqual([
      `worktree.create:${firstProject.id}`,
      `worktree.create:${secondProject.id}`,
    ]);
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
    expect(items.some((item) => item.id === "tab.newChat")).toBe(false);
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

  it("adds project context to duplicate worktree switch items", () => {
    const alpha = makeProject("p1", "Alpha");
    const beta = makeProject("p2", "Beta");
    const selectedWorktree = makeWorktree("w1", alpha.id, ".git/local", {
      branch: "main",
    });
    const alphaSibling = makeWorktree("w2", alpha.id, ".git/local", {
      branch: "release",
    });
    const betaSibling = makeWorktree("w3", beta.id, ".git/local", {
      branch: "develop",
    });

    const items = getCommandPaletteItems(
      buildCommandContextSnapshot({
        activeTabId: null,
        focusedPaneByWorktree: {},
        projects: [alpha, beta],
        selectedWorktreeId: selectedWorktree.id,
        tabs: [],
        worktreesByProject: {
          [alpha.id]: [selectedWorktree, alphaSibling],
          [beta.id]: [betaSibling],
        },
      }),
    );

    const switchItems = items.filter(
      (item) => item.id === "worktree.select" && item.key !== "worktree.select",
    );

    expect(
      switchItems.map((item) => ({
        key: item.key,
        searchText: item.searchText,
        subtitle: item.subtitle,
        title: item.title,
      })),
    ).toEqual([
      {
        key: `worktree.select:${alphaSibling.id}`,
        searchText: "Switch to .git/local Alpha release",
        subtitle: "Alpha • release",
        title: "Switch to .git/local",
      },
      {
        key: `worktree.select:${betaSibling.id}`,
        searchText: "Switch to .git/local Beta develop",
        subtitle: "Beta • develop",
        title: "Switch to .git/local",
      },
    ]);
  });

  it("scopes worktree mode-switch items by project and worktree name", () => {
    const project = makeProject("p1", "Devbox");
    const selectedWorktree = makeWorktree("w1", project.id, ".git/local", {
      branch: "main",
      ui_mode: "hubris",
    });

    const items = getCommandPaletteItems(
      buildCommandContextSnapshot({
        activeTabId: null,
        focusedPaneByWorktree: {},
        projects: [project],
        selectedWorktreeId: selectedWorktree.id,
        tabs: [],
        worktreesByProject: {
          [project.id]: [selectedWorktree],
        },
      }),
    );

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "worktree.setUiMode",
          searchText: "Switch Current Worktree to VS Code Devbox .git/local",
          subtitle: "Devbox • .git/local",
          title: "Switch Current Worktree to VS Code",
        }),
      ]),
    );
  });
});
