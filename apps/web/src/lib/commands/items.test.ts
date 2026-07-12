import { beforeEach, describe, expect, it } from "vitest";
import { buildCommandContextSnapshot } from "@/lib/commands/context";
import { getCommandPaletteItems } from "@/lib/commands/items";
import { useChatStore } from "@/lib/stores/chats";
import {
  resetSettingsStoreForTests,
  useSettingsStore,
} from "@/lib/stores/settings";

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
    uiMode: "hubris" | "vscode";
  }> = {},
) {
  return {
    id,
    projectId: projectId,
    name,
    path: `/tmp/${name}`,
    branch: overrides.branch ?? name,
    sourceRef: null,
    uiMode: overrides.uiMode ?? "hubris",
    isLocal: false,
    missingOnDisk: false,
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
    worktreeId: worktreeId,
    paneId: "pane-1",
    sessionId: "default",
    type: "terminal" as const,
    createdAt: 0,
    preview: false,
  };
}

function makeAgentChatTab(
  id: string,
  worktreeId: string,
  label: string,
  position: number,
) {
  return {
    id,
    label,
    position,
    worktreeId: worktreeId,
    paneId: "pane-1",
    sessionId: "default",
    type: "agent_chat" as const,
    createdAt: 0,
    preview: false,
    conversationId: "chat-1",
  };
}

describe("command palette items", () => {
  beforeEach(() => {
    resetSettingsStoreForTests();
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        experimental: {
          ...state.settings.experimental,
          chatEnabled: true,
        },
      },
    }));
    useChatStore.setState({
      conversationsById: {},
    });
  });

  it("combines static commands with dynamic state-backed items", () => {
    const project = makeProject("p1", "Devbox");
    const selectedWorktree = makeWorktree("w1", project.id, "local", {
      branch: "main",
      position: 1,
      uiMode: "hubris",
    });
    const siblingWorktree = makeWorktree("w2", project.id, "feature-a", {
      branch: "feature-a",
      position: 2,
      uiMode: "vscode",
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

  it("hides chat focus items when chat is disabled", () => {
    const project = makeProject("p1", "Devbox");
    const worktree = makeWorktree("w1", project.id, "local");
    const terminalTab = makeTerminalTab("t1", worktree.id, "Shell", 1);
    const chatTab = makeAgentChatTab("chat-tab-1", worktree.id, "Chat", 2);
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        experimental: {
          ...state.settings.experimental,
          chatEnabled: false,
        },
      },
    }));

    const items = getCommandPaletteItems(
      buildCommandContextSnapshot({
        activeTabId: null,
        focusedPaneByWorktree: { [worktree.id]: "pane-1" },
        projects: [project],
        selectedWorktreeId: worktree.id,
        tabs: [terminalTab, chatTab],
        worktreesByProject: {
          [project.id]: [worktree],
        },
      }),
    );

    expect(items.some((item) => item.key === "tab.newChat")).toBe(false);
    expect(items.some((item) => item.key === `tab.focus:${chatTab.id}`)).toBe(
      false,
    );
    expect(
      items.some((item) => item.key === `tab.focus:${terminalTab.id}`),
    ).toBe(true);
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
      uiMode: "hubris",
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

  it("keeps open chat items ordered by recent activity", () => {
    const project = makeProject("p1", "Devbox");
    const otherProject = makeProject("p2", "Other");
    const selectedWorktree = makeWorktree("w1", project.id, "local");
    const otherWorktree = makeWorktree("w2", otherProject.id, "local", {
      branch: selectedWorktree.branch,
    });
    useChatStore.setState({
      conversationsById: {
        old: {
          contextMaxTokens: null,
          contextPercentUsed: null,
          contextUpdatedAt: null,
          contextUsedTokens: null,
          createdAt: 1,
          hasPendingRequestAttention: false,
          id: "old",
          lastActivityAt: 10,
          lastError: null,
          lastMessageAt: null,
          lastReconciliationError: null,
          lastReconciliationState: "not_needed",
          lastRunState: "completed",
          latestPendingRequestId: null,
          latestPendingRequestKind: null,
          latestPendingRequestStatus: null,
          openTabId: null,
          pendingRequestCount: 0,
          projectId: project.id,
          provider: "codex",
          providerThreadId: null,
          revision: 1,
          selectedEffort: null,
          selectedModel: null,
          selectedPermissionMode: null,
          sessionId: "default",
          title: "Older chat",
          updatedAt: 10,
          worktreeId: selectedWorktree.id,
        },
        recent: {
          contextMaxTokens: null,
          contextPercentUsed: null,
          contextUpdatedAt: null,
          contextUsedTokens: null,
          createdAt: 2,
          hasPendingRequestAttention: false,
          id: "recent",
          lastActivityAt: 20,
          lastError: null,
          lastMessageAt: null,
          lastReconciliationError: null,
          lastReconciliationState: "not_needed",
          lastRunState: "completed",
          latestPendingRequestId: null,
          latestPendingRequestKind: null,
          latestPendingRequestStatus: null,
          openTabId: null,
          pendingRequestCount: 0,
          projectId: project.id,
          provider: "codex",
          providerThreadId: null,
          revision: 1,
          selectedEffort: null,
          selectedModel: null,
          selectedPermissionMode: null,
          sessionId: "default",
          title: "Recent chat",
          updatedAt: 20,
          worktreeId: selectedWorktree.id,
        },
        otherProject: {
          contextMaxTokens: null,
          contextPercentUsed: null,
          contextUpdatedAt: null,
          contextUsedTokens: null,
          createdAt: 3,
          hasPendingRequestAttention: false,
          id: "otherProject",
          lastActivityAt: 30,
          lastError: null,
          lastMessageAt: null,
          lastReconciliationError: null,
          lastReconciliationState: "not_needed",
          lastRunState: "completed",
          latestPendingRequestId: null,
          latestPendingRequestKind: null,
          latestPendingRequestStatus: null,
          openTabId: null,
          pendingRequestCount: 0,
          projectId: otherProject.id,
          provider: "codex",
          providerThreadId: null,
          revision: 1,
          selectedEffort: null,
          selectedModel: null,
          selectedPermissionMode: null,
          sessionId: "default",
          branchName: selectedWorktree.branch,
          title: "Other project chat",
          updatedAt: 30,
          worktreeId: otherWorktree.id,
        },
      },
    });

    const items = getCommandPaletteItems(
      buildCommandContextSnapshot({
        activeTabId: null,
        focusedPaneByWorktree: {},
        projects: [project, otherProject],
        selectedWorktreeId: selectedWorktree.id,
        tabs: [],
        worktreesByProject: {
          [project.id]: [selectedWorktree],
          [otherProject.id]: [otherWorktree],
        },
      }),
    ).filter((item) => item.id === "tab.openChat");

    expect(items.map((item) => item.key)).toEqual([
      "tab.openChat:recent",
      "tab.openChat:old",
    ]);
  });
});
