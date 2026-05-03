import {
  ArrowLeft,
  ArrowRight,
  Globe,
  History,
  LayoutPanelTop,
  MessageSquare,
  MessageSquarePlus,
  Monitor,
  PanelLeft,
  PanelRight,
  PanelTop,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { ApiStatusError } from "@/lib/api";
import { useAppSidebarStore } from "@/lib/stores/appSidebar";
import { useFileEditorStore } from "@/lib/stores/fileEditorTabs";
import { useGitDiffStore } from "@/lib/stores/gitDiffTabs";
import { useChatStore } from "@/lib/stores/chats";
import { useProjectStore } from "@/lib/stores/projects";
import { useCommandUiStore } from "@/lib/stores/commandUi";
import { useTabStore } from "@/lib/stores/tabs";
import {
  getCurrentWorktreeHistoryItems,
  useWorktreeHistorySwitcherStore,
} from "@/lib/stores/worktreeHistorySwitcher";
import { useWorktreeRightSidebarStore } from "@/lib/stores/worktreeRightSidebar";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import type {
  CommandAvailability,
  CommandContextSnapshot,
  CommandDefinition,
  CommandId,
  CommandResult,
} from "./types";
import { findTabById, findWorktreeById } from "./context";

function defineCommand<TId extends CommandId>(
  definition: CommandDefinition<TId>,
): CommandDefinition<TId> {
  return definition;
}

function enabled(reason?: string): CommandAvailability {
  return { enabled: true, reason };
}

function disabled(reason: string): CommandAvailability {
  return { enabled: false, reason };
}

function success(): CommandResult {
  return { status: "success" };
}

function cancelled(): CommandResult {
  return { status: "cancelled" };
}

function resolveProjectId(
  explicitProjectId: string | undefined,
  fallbackProjectId: string | null,
): string | null {
  return explicitProjectId ?? fallbackProjectId ?? null;
}

function resolveWorktreeId(
  explicitWorktreeId: string | undefined,
  fallbackWorktreeId: string | null,
): string | null {
  return explicitWorktreeId ?? fallbackWorktreeId ?? null;
}

function resolveTabId(
  explicitTabId: string | undefined,
  fallbackTabId: string | null,
): string | null {
  return explicitTabId ?? fallbackTabId ?? null;
}

function isDirtyTab(tabId: string): boolean {
  return (
    !!useFileEditorStore.getState().sessions[tabId]?.dirty ||
    !!useGitDiffStore.getState().sessions[tabId]?.dirty
  );
}

function projectIdForWorktreeId(worktreeId: string): string | null {
  const worktree = Object.values(useWorktreeStore.getState().worktreesByProject)
    .flat()
    .find((candidate) => candidate.id === worktreeId);

  return worktree?.project_id ?? null;
}

function byPosition<T extends { id: string; position?: number }>(
  left: T,
  right: T,
): number {
  return (
    (left.position ?? 0) - (right.position ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

function selectProjectWorktree(
  context: CommandContextSnapshot,
  direction: 1 | -1,
): string | null {
  const selectedProjectId = context.selectedProject?.id;
  if (!selectedProjectId) {
    return null;
  }

  const projects = [...context.projects]
    .sort(byPosition)
    .filter(
      (project) => (context.worktreesByProject[project.id] ?? []).length > 0,
    );
  const currentIndex = projects.findIndex(
    (project) => project.id === selectedProjectId,
  );
  if (projects.length < 2 || currentIndex < 0) {
    return null;
  }

  const nextProject = projects.at(
    (currentIndex + direction + projects.length) % projects.length,
  );
  if (!nextProject) {
    return null;
  }

  const worktrees = [
    ...(context.worktreesByProject[nextProject.id] ?? []),
  ].sort(byPosition);
  return (
    (worktrees.find((worktree) => worktree.is_local) ?? worktrees[0])?.id ??
    null
  );
}

function selectSiblingWorktree(
  context: CommandContextSnapshot,
  direction: 1 | -1,
): string | null {
  if (!context.selectedWorktree) {
    return null;
  }

  const worktrees = [...context.projects]
    .sort(byPosition)
    .flatMap((project) =>
      [...(context.worktreesByProject[project.id] ?? [])].sort(byPosition),
    );
  const currentIndex = worktrees.findIndex(
    (worktree) => worktree.id === context.selectedWorktree?.id,
  );
  if (worktrees.length < 2 || currentIndex < 0) {
    return null;
  }

  return (
    worktrees.at(
      (currentIndex + direction + worktrees.length) % worktrees.length,
    )?.id ?? null
  );
}

async function saveDirtyTab(tabId: string): Promise<boolean> {
  const tab = useTabStore
    .getState()
    .tabs.find((candidate) => candidate.id === tabId);
  if (!tab) {
    return false;
  }

  if (tab.type === "file" || tab.type === "git_diff") {
    const projectId = projectIdForWorktreeId(tab.worktree_id);
    if (!projectId) {
      return false;
    }

    if (tab.type === "file") {
      await useFileEditorStore
        .getState()
        .save(projectId, tab.worktree_id, tab.id);
    } else {
      await useGitDiffStore.getState().save(projectId, tab.worktree_id, tab.id);
    }
  }

  return !isDirtyTab(tabId);
}

/**
 * Stable frontend command registry used by the palette and direct UI triggers.
 */
export const commandRegistry = {
  "app.openCommandPalette": defineCommand({
    async execute() {
      useCommandUiStore.getState().openPalette();
      return cancelled();
    },
    group: "App",
    icon: Search,
    id: "app.openCommandPalette",
    isAvailable: () => enabled(),
    keywords: ["commands", "palette"],
    title: "Open Command Palette",
  }),
  "app.openSettings": defineCommand({
    async execute(_context, args) {
      useCommandUiStore.getState().openDialog({
        type: "settings",
        section: args?.section,
      });
      return cancelled();
    },
    group: "App",
    icon: Settings,
    id: "app.openSettings",
    isAvailable: () => enabled(),
    keywords: ["preferences", "settings"],
    title: "Open Settings",
  }),
  "app.toggleLeftSidebar": defineCommand({
    async execute() {
      return useAppSidebarStore.getState().toggle()
        ? success()
        : { reason: "Sidebar is not ready", status: "unavailable" };
    },
    group: "App",
    icon: PanelLeft,
    id: "app.toggleLeftSidebar",
    isAvailable: () =>
      useAppSidebarStore.getState().controller
        ? enabled()
        : disabled("Sidebar is not ready"),
    keywords: ["primary", "sidebar", "projects"],
    title: "Toggle Left Sidebar",
  }),
  "app.toggleRightSidebar": defineCommand({
    async execute() {
      const rightSidebar = useWorktreeRightSidebarStore.getState();
      if (rightSidebar.isMobileViewport) {
        rightSidebar.setMobileOpen(!rightSidebar.mobileOpen);
      } else {
        rightSidebar.toggleDesktop();
      }
      return success();
    },
    group: "App",
    icon: PanelRight,
    id: "app.toggleRightSidebar",
    isAvailable: () => enabled(),
    keywords: ["file manager", "git", "right", "sidebar"],
    title: "Toggle Right Sidebar",
  }),
  "pane.splitDown": defineCommand({
    async execute(context, args) {
      const worktreeId = resolveWorktreeId(
        args?.worktreeId,
        context.selectedWorktree?.id ?? null,
      );
      const worktree = findWorktreeById(context, worktreeId ?? undefined);
      const paneId = args?.paneId ?? context.focusedPaneId;
      if (!worktree || !paneId) {
        return { reason: "No active pane", status: "unavailable" };
      }

      await useTabStore
        .getState()
        .splitPane(worktree.project_id, worktree.id, paneId, "down");
      return success();
    },
    group: "Panes",
    icon: PanelTop,
    id: "pane.splitDown",
    isAvailable(context, args) {
      const worktreeId = resolveWorktreeId(
        args?.worktreeId,
        context.selectedWorktree?.id ?? null,
      );
      const paneId = args?.paneId ?? context.focusedPaneId;
      return worktreeId && paneId
        ? enabled()
        : disabled("Select a pane to split");
    },
    keywords: ["split", "horizontal", "pane"],
    title: "Split Pane Down",
  }),
  "pane.splitRight": defineCommand({
    async execute(context, args) {
      const worktreeId = resolveWorktreeId(
        args?.worktreeId,
        context.selectedWorktree?.id ?? null,
      );
      const worktree = findWorktreeById(context, worktreeId ?? undefined);
      const paneId = args?.paneId ?? context.focusedPaneId;
      if (!worktree || !paneId) {
        return { reason: "No active pane", status: "unavailable" };
      }

      await useTabStore
        .getState()
        .splitPane(worktree.project_id, worktree.id, paneId, "right");
      return success();
    },
    group: "Panes",
    icon: PanelRight,
    id: "pane.splitRight",
    isAvailable(context, args) {
      const worktreeId = resolveWorktreeId(
        args?.worktreeId,
        context.selectedWorktree?.id ?? null,
      );
      const paneId = args?.paneId ?? context.focusedPaneId;
      return worktreeId && paneId
        ? enabled()
        : disabled("Select a pane to split");
    },
    keywords: ["split", "vertical", "pane"],
    title: "Split Pane Right",
  }),
  "project.add": defineCommand({
    async execute(_context, args) {
      if (!args?.path) {
        useCommandUiStore.getState().openDialog({ type: "add-project" });
        return cancelled();
      }

      await useProjectStore.getState().add(args.path);
      return success();
    },
    group: "Projects",
    icon: Plus,
    id: "project.add",
    isAvailable: () => enabled(),
    keywords: ["project", "repository", "repo", "add"],
    title: "Add Project",
  }),
  "project.remove": defineCommand({
    async execute(context, args) {
      const projectId = resolveProjectId(
        args?.projectId,
        context.selectedProject?.id ?? null,
      );
      if (!projectId) {
        return { reason: "No project selected", status: "unavailable" };
      }

      if (args?.deleteManagedWorktrees === undefined) {
        useCommandUiStore.getState().openDialog({
          projectId,
          type: "remove-project",
        });
        return cancelled();
      }

      try {
        await useProjectStore.getState().remove(projectId, {
          deleteManagedWorktrees: args.deleteManagedWorktrees,
          force: args.force,
        });
        return success();
      } catch (error) {
        if (
          args.deleteManagedWorktrees &&
          !args.force &&
          error instanceof ApiStatusError &&
          error.status === 409
        ) {
          useCommandUiStore.getState().openDialog({
            forceManagedDelete: true,
            projectId,
            type: "remove-project",
          });
          return cancelled();
        }
        throw error;
      }
    },
    group: "Projects",
    icon: Trash2,
    id: "project.remove",
    isAvailable(context, args) {
      const projectId = resolveProjectId(
        args?.projectId,
        context.selectedProject?.id ?? null,
      );
      return projectId ? enabled() : disabled("Select a project first");
    },
    keywords: ["project", "remove", "delete"],
    title: "Remove Project",
  }),
  "project.rename": defineCommand({
    async execute(context, args) {
      const projectId = resolveProjectId(
        args?.projectId,
        context.selectedProject?.id ?? null,
      );
      if (!projectId) {
        return { reason: "No project selected", status: "unavailable" };
      }

      if (!args?.name) {
        useCommandUiStore.getState().openDialog({
          projectId,
          type: "rename-project",
        });
        return cancelled();
      }

      await useProjectStore.getState().rename(projectId, args.name);
      return success();
    },
    group: "Projects",
    icon: Pencil,
    id: "project.rename",
    isAvailable(context, args) {
      const projectId = resolveProjectId(
        args?.projectId,
        context.selectedProject?.id ?? null,
      );
      return projectId ? enabled() : disabled("Select a project first");
    },
    keywords: ["project", "rename"],
    title: "Rename Project",
  }),
  "project.selectNext": defineCommand({
    async execute(context) {
      const worktreeId = selectProjectWorktree(context, 1);
      if (!worktreeId) {
        return { reason: "No next project", status: "unavailable" };
      }

      useWorktreeStore.getState().select(worktreeId);
      return success();
    },
    group: "Projects",
    icon: Search,
    id: "project.selectNext",
    isAvailable(context) {
      return selectProjectWorktree(context, 1)
        ? enabled()
        : disabled("No next project");
    },
    keywords: ["project", "next", "switch"],
    title: "Switch to Next Project",
  }),
  "project.selectPrevious": defineCommand({
    async execute(context) {
      const worktreeId = selectProjectWorktree(context, -1);
      if (!worktreeId) {
        return { reason: "No previous project", status: "unavailable" };
      }

      useWorktreeStore.getState().select(worktreeId);
      return success();
    },
    group: "Projects",
    icon: Search,
    id: "project.selectPrevious",
    isAvailable(context) {
      return selectProjectWorktree(context, -1)
        ? enabled()
        : disabled("No previous project");
    },
    keywords: ["project", "previous", "switch"],
    title: "Switch to Previous Project",
  }),
  "settings.openSection": defineCommand({
    async execute(_context, args) {
      useCommandUiStore.getState().openDialog({
        section: args?.section,
        type: "settings",
      });
      return cancelled();
    },
    group: "Settings",
    icon: Search,
    id: "settings.openSection",
    isAvailable(_context, args) {
      return args?.section ? enabled() : disabled("Choose a settings section");
    },
    keywords: ["settings", "section"],
    title: "Open Settings Section",
  }),
  "tab.close": defineCommand({
    async execute(context, args) {
      const tabId = resolveTabId(args?.tabId, context.activeTab?.id ?? null);
      if (!tabId) {
        return { reason: "No active tab", status: "unavailable" };
      }

      const tab = findTabById(context, tabId);
      if (!tab) {
        return { reason: "Tab not found", status: "unavailable" };
      }

      const dirty =
        (tab.type === "file" || tab.type === "git_diff") && isDirtyTab(tabId);
      if (dirty && !args?.saveBehavior) {
        useCommandUiStore.getState().openDialog({
          tabId,
          type: "close-dirty-tab",
        });
        return cancelled();
      }

      if (dirty && args?.saveBehavior === "save") {
        const saved = await saveDirtyTab(tabId);
        if (!saved) {
          toast.error("Could not save tab before closing");
          return cancelled();
        }
      }

      await useTabStore.getState().close(tabId);
      return success();
    },
    group: "Tabs",
    icon: Trash2,
    id: "tab.close",
    isAvailable(context, args) {
      const tabId = resolveTabId(args?.tabId, context.activeTab?.id ?? null);
      return tabId ? enabled() : disabled("No active tab");
    },
    keywords: ["tab", "close"],
    title: "Close Tab",
  }),
  "tab.focus": defineCommand({
    async execute(context, args) {
      const tabId = resolveTabId(args?.tabId, context.activeTab?.id ?? null);
      if (!tabId) {
        return { reason: "No tab selected", status: "unavailable" };
      }

      useTabStore.getState().activate(tabId);
      return success();
    },
    group: "Tabs",
    icon: Search,
    id: "tab.focus",
    isAvailable(context, args) {
      const tabId = resolveTabId(args?.tabId, context.activeTab?.id ?? null);
      return tabId ? enabled() : disabled("No active tab");
    },
    keywords: ["tab", "focus", "switch"],
    title: "Focus Tab",
  }),
  "tab.newBrowser": defineCommand({
    async execute(context, args) {
      const worktreeId = resolveWorktreeId(
        args?.worktreeId,
        context.selectedWorktree?.id ?? null,
      );
      if (!worktreeId) {
        return { reason: "No worktree selected", status: "unavailable" };
      }

      await useTabStore.getState().openBrowser({
        paneId: args?.paneId ?? context.focusedPaneId ?? undefined,
        url: args?.url,
        worktreeId,
      });
      return success();
    },
    group: "Tabs",
    icon: Globe,
    id: "tab.newBrowser",
    isAvailable(context, args) {
      const worktreeId = resolveWorktreeId(
        args?.worktreeId,
        context.selectedWorktree?.id ?? null,
      );
      return worktreeId ? enabled() : disabled("Select a worktree first");
    },
    keywords: ["browser", "tab", "web"],
    title: "New Browser Tab",
  }),
  "tab.newChat": defineCommand({
    async execute(context, args) {
      const worktreeId = resolveWorktreeId(
        args?.worktreeId,
        context.selectedWorktree?.id ?? null,
      );
      if (!worktreeId) {
        return { reason: "No worktree selected", status: "unavailable" };
      }

      await useTabStore.getState().openAgentChat({
        paneId: args?.paneId ?? context.focusedPaneId ?? undefined,
        worktreeId,
      });
      return success();
    },
    group: "Tabs",
    icon: MessageSquarePlus,
    id: "tab.newChat",
    isAvailable(context, args) {
      const worktreeId = resolveWorktreeId(
        args?.worktreeId,
        context.selectedWorktree?.id ?? null,
      );
      return worktreeId ? enabled() : disabled("Select a worktree first");
    },
    keywords: ["agent", "chat", "codex", "conversation", "tab"],
    title: "New Chat Tab",
  }),
  "tab.newTerminal": defineCommand({
    async execute(context, args) {
      const worktreeId = resolveWorktreeId(
        args?.worktreeId,
        context.selectedWorktree?.id ?? null,
      );
      if (!worktreeId) {
        return { reason: "No worktree selected", status: "unavailable" };
      }

      await useTabStore
        .getState()
        .addTerminal(
          worktreeId,
          args?.paneId ?? context.focusedPaneId ?? undefined,
        );
      return success();
    },
    group: "Tabs",
    icon: SquareTerminal,
    id: "tab.newTerminal",
    isAvailable(context, args) {
      const worktreeId = resolveWorktreeId(
        args?.worktreeId,
        context.selectedWorktree?.id ?? null,
      );
      return worktreeId ? enabled() : disabled("Select a worktree first");
    },
    keywords: ["terminal", "tab", "shell"],
    title: "New Terminal Tab",
  }),
  "tab.openChat": defineCommand({
    async execute(context, args) {
      const conversationId = args?.conversationId;
      if (!conversationId) {
        return { reason: "No chat selected", status: "unavailable" };
      }

      const conversation =
        useChatStore.getState().conversationsById[conversationId] ?? null;
      const worktreeId = resolveWorktreeId(
        args?.worktreeId,
        conversation?.worktreeId ?? context.selectedWorktree?.id ?? null,
      );
      if (
        !conversation ||
        conversation.id !== conversationId ||
        (worktreeId && conversation.worktreeId !== worktreeId)
      ) {
        return { reason: "No chat selected", status: "unavailable" };
      }
      if (!worktreeId) {
        return { reason: "No worktree selected", status: "unavailable" };
      }

      await useTabStore.getState().openAgentChat({
        conversationId,
        paneId: args?.paneId ?? context.focusedPaneId ?? undefined,
        worktreeId,
      });
      return success();
    },
    group: "Tabs",
    icon: MessageSquare,
    id: "tab.openChat",
    isAvailable(context, args) {
      const conversationId = args?.conversationId;
      if (!conversationId) {
        return disabled("No chat selected");
      }

      const conversation =
        useChatStore.getState().conversationsById[conversationId] ?? null;
      if (!conversation) {
        return disabled("Chat not found");
      }

      if (
        context.selectedWorktree &&
        conversation.worktreeId !== context.selectedWorktree.id
      ) {
        return disabled("Chat belongs to another worktree");
      }

      return enabled();
    },
    keywords: ["agent", "chat", "codex", "conversation", "open"],
    title: "Open Chat",
  }),
  "tab.pin": defineCommand({
    async execute(context, args) {
      const tabId = resolveTabId(args?.tabId, context.activeTab?.id ?? null);
      if (!tabId) {
        return { reason: "No active tab", status: "unavailable" };
      }

      await useTabStore.getState().pin(tabId);
      return success();
    },
    group: "Tabs",
    icon: Pin,
    id: "tab.pin",
    isAvailable(context, args) {
      const tabId = resolveTabId(args?.tabId, context.activeTab?.id ?? null);
      const tab = findTabById(context, tabId ?? undefined);
      return tab && tab.preview
        ? enabled()
        : disabled("Only preview tabs can be pinned");
    },
    keywords: ["tab", "pin", "preview"],
    title: "Pin Tab",
  }),
  "tab.renameTerminal": defineCommand({
    async execute(context, args) {
      const tabId = resolveTabId(args?.tabId, context.activeTab?.id ?? null);
      const tab = findTabById(context, tabId ?? undefined);
      if (!tabId || !tab || tab.type !== "terminal") {
        return { reason: "No terminal tab selected", status: "unavailable" };
      }

      if (!args?.name) {
        useCommandUiStore.getState().openDialog({
          tabId,
          type: "rename-terminal-tab",
        });
        return cancelled();
      }

      await useTabStore.getState().setTerminalCustomLabel(tabId, args.name);
      return success();
    },
    group: "Tabs",
    icon: Pencil,
    id: "tab.renameTerminal",
    isAvailable(context, args) {
      const tabId = resolveTabId(args?.tabId, context.activeTab?.id ?? null);
      const tab = findTabById(context, tabId ?? undefined);
      return tab?.type === "terminal"
        ? enabled()
        : disabled("Select a terminal tab");
    },
    keywords: ["terminal", "rename", "tab"],
    title: "Rename Terminal Tab",
  }),
  "tab.resetTerminalName": defineCommand({
    async execute(context, args) {
      const tabId = resolveTabId(args?.tabId, context.activeTab?.id ?? null);
      const tab = findTabById(context, tabId ?? undefined);
      if (!tabId || !tab || tab.type !== "terminal") {
        return { reason: "No terminal tab selected", status: "unavailable" };
      }

      await useTabStore.getState().resetTerminalCustomLabel(tabId);
      return success();
    },
    group: "Tabs",
    icon: LayoutPanelTop,
    id: "tab.resetTerminalName",
    isAvailable(context, args) {
      const tabId = resolveTabId(args?.tabId, context.activeTab?.id ?? null);
      const tab = findTabById(context, tabId ?? undefined);
      return tab?.type === "terminal" && !!tab.customLabel
        ? enabled()
        : disabled("Terminal tab has no custom name");
    },
    keywords: ["terminal", "reset", "name"],
    title: "Reset Terminal Tab Name",
  }),
  "worktree.create": defineCommand({
    async execute(context, args) {
      const projectId = resolveProjectId(
        args?.projectId,
        context.selectedProject?.id ?? null,
      );
      if (!projectId) {
        return { reason: "No project selected", status: "unavailable" };
      }

      if (!args?.branch) {
        useCommandUiStore.getState().openDialog({
          projectId,
          type: "add-worktree",
        });
        return cancelled();
      }

      await useWorktreeStore
        .getState()
        .create(projectId, args.branch, args.startPoint, args.sourceRef);
      return success();
    },
    group: "Worktrees",
    icon: Plus,
    id: "worktree.create",
    isAvailable(context, args) {
      const projectId = resolveProjectId(
        args?.projectId,
        context.selectedProject?.id ?? null,
      );
      return projectId ? enabled() : disabled("Select a project first");
    },
    keywords: ["worktree", "create", "new"],
    title: "New Worktree",
  }),
  "worktree.import": defineCommand({
    async execute(context, args) {
      const projectId = resolveProjectId(
        args?.projectId,
        context.selectedProject?.id ?? null,
      );
      if (!projectId) {
        return { reason: "No project selected", status: "unavailable" };
      }

      if (!args?.path) {
        useCommandUiStore.getState().openDialog({
          projectId,
          type: "add-worktree",
        });
        return cancelled();
      }

      await useWorktreeStore.getState().importWorktree(projectId, args.path);
      return success();
    },
    group: "Worktrees",
    icon: Plus,
    id: "worktree.import",
    isAvailable(context, args) {
      const projectId = resolveProjectId(
        args?.projectId,
        context.selectedProject?.id ?? null,
      );
      return projectId ? enabled() : disabled("Select a project first");
    },
    keywords: ["worktree", "import"],
    title: "Import Worktree",
  }),
  "worktree.navigateBack": defineCommand({
    async execute() {
      useWorktreeStore.getState().navigateBack();
      return success();
    },
    group: "Worktrees",
    icon: ArrowLeft,
    id: "worktree.navigateBack",
    isAvailable() {
      return useWorktreeStore.getState().navigationBackIds.length > 0
        ? enabled()
        : disabled("No previous worktree in history");
    },
    keywords: ["worktree", "back", "history"],
    title: "Go Back in Worktree History",
  }),
  "worktree.navigateForward": defineCommand({
    async execute() {
      useWorktreeStore.getState().navigateForward();
      return success();
    },
    group: "Worktrees",
    icon: ArrowRight,
    id: "worktree.navigateForward",
    isAvailable() {
      return useWorktreeStore.getState().navigationForwardIds.length > 0
        ? enabled()
        : disabled("No next worktree in history");
    },
    keywords: ["worktree", "forward", "history"],
    title: "Go Forward in Worktree History",
  }),
  "worktree.showHistorySwitcher": defineCommand({
    async execute(_context, args) {
      const switcher = useWorktreeHistorySwitcherStore.getState();
      if (switcher.open) {
        switcher.cycle(args?.direction ?? "back");
        return success();
      }

      const started = switcher.start(
        getCurrentWorktreeHistoryItems(),
        args?.direction ?? "back",
      );
      return started ? success() : cancelled();
    },
    group: "Worktrees",
    icon: History,
    id: "worktree.showHistorySwitcher",
    isAvailable() {
      return getCurrentWorktreeHistoryItems().length > 1
        ? enabled()
        : disabled("No recent worktree in history");
    },
    keywords: ["worktree", "history", "recent", "switcher"],
    title: "Show Recent Worktree Switcher",
  }),
  "worktree.remove": defineCommand({
    async execute(context, args) {
      const worktreeId = resolveWorktreeId(
        args?.worktreeId,
        context.selectedWorktree?.id ?? null,
      );
      const worktree = findWorktreeById(context, worktreeId ?? undefined);
      const projectId = resolveProjectId(
        args?.projectId,
        worktree?.project_id ?? context.selectedProject?.id ?? null,
      );
      if (!projectId || !worktreeId) {
        return { reason: "No worktree selected", status: "unavailable" };
      }

      if (args?.untrackOnly === undefined && args?.force === undefined) {
        useCommandUiStore.getState().openDialog({
          projectId,
          type: "remove-worktree",
          worktreeId,
        });
        return cancelled();
      }

      try {
        await useWorktreeStore
          .getState()
          .remove(projectId, worktreeId, args?.force, args?.untrackOnly);
        return success();
      } catch (error) {
        if (
          !args?.force &&
          !args?.untrackOnly &&
          error instanceof ApiStatusError &&
          error.status === 409
        ) {
          useCommandUiStore.getState().openDialog({
            forceDelete: true,
            projectId,
            type: "remove-worktree",
            worktreeId,
          });
          return cancelled();
        }
        throw error;
      }
    },
    group: "Worktrees",
    icon: Trash2,
    id: "worktree.remove",
    isAvailable(context, args) {
      const worktreeId = resolveWorktreeId(
        args?.worktreeId,
        context.selectedWorktree?.id ?? null,
      );
      return worktreeId ? enabled() : disabled("Select a worktree first");
    },
    keywords: ["worktree", "remove", "delete"],
    title: "Remove Worktree",
  }),
  "worktree.rename": defineCommand({
    async execute(context, args) {
      const worktreeId = resolveWorktreeId(
        args?.worktreeId,
        context.selectedWorktree?.id ?? null,
      );
      const worktree = findWorktreeById(context, worktreeId ?? undefined);
      const projectId = resolveProjectId(
        args?.projectId,
        worktree?.project_id ?? context.selectedProject?.id ?? null,
      );
      if (!projectId || !worktreeId) {
        return { reason: "No worktree selected", status: "unavailable" };
      }

      if (!args?.name) {
        useCommandUiStore.getState().openDialog({
          projectId,
          type: "rename-worktree",
          worktreeId,
        });
        return cancelled();
      }

      await useWorktreeStore
        .getState()
        .rename(projectId, worktreeId, args.name);
      return success();
    },
    group: "Worktrees",
    icon: Pencil,
    id: "worktree.rename",
    isAvailable(context, args) {
      const worktreeId = resolveWorktreeId(
        args?.worktreeId,
        context.selectedWorktree?.id ?? null,
      );
      return worktreeId ? enabled() : disabled("Select a worktree first");
    },
    keywords: ["worktree", "rename"],
    title: "Rename Worktree",
  }),
  "worktree.select": defineCommand({
    async execute(context, args) {
      if (!args?.worktreeId) {
        useCommandUiStore.getState().openDialog({ type: "select-worktree" });
        return cancelled();
      }

      const worktreeId = resolveWorktreeId(args.worktreeId, null);
      if (
        !worktreeId ||
        !context.worktrees.some((worktree) => worktree.id === worktreeId)
      ) {
        return { reason: "No worktree selected", status: "unavailable" };
      }

      useWorktreeStore.getState().select(worktreeId);
      return success();
    },
    group: "Worktrees",
    icon: Search,
    id: "worktree.select",
    isAvailable(context, args) {
      if (!args?.worktreeId) {
        return context.worktrees.length > 0
          ? enabled()
          : disabled("No worktree available");
      }

      const worktreeId = resolveWorktreeId(args.worktreeId, null);
      return worktreeId &&
        context.worktrees.some((worktree) => worktree.id === worktreeId)
        ? enabled()
        : disabled("No worktree available");
    },
    keywords: ["worktree", "switch", "select"],
    title: "Switch Worktree",
  }),
  "worktree.selectNext": defineCommand({
    async execute(context) {
      const worktreeId = selectSiblingWorktree(context, 1);
      if (!worktreeId) {
        return { reason: "No next worktree", status: "unavailable" };
      }

      useWorktreeStore.getState().select(worktreeId);
      return success();
    },
    group: "Worktrees",
    icon: Search,
    id: "worktree.selectNext",
    isAvailable(context) {
      return selectSiblingWorktree(context, 1)
        ? enabled()
        : disabled("No next worktree");
    },
    keywords: ["worktree", "next", "switch"],
    title: "Switch to Next Worktree",
  }),
  "worktree.selectPrevious": defineCommand({
    async execute(context) {
      const worktreeId = selectSiblingWorktree(context, -1);
      if (!worktreeId) {
        return { reason: "No previous worktree", status: "unavailable" };
      }

      useWorktreeStore.getState().select(worktreeId);
      return success();
    },
    group: "Worktrees",
    icon: Search,
    id: "worktree.selectPrevious",
    isAvailable(context) {
      return selectSiblingWorktree(context, -1)
        ? enabled()
        : disabled("No previous worktree");
    },
    keywords: ["worktree", "previous", "switch"],
    title: "Switch to Previous Worktree",
  }),
  "worktree.setUiMode": defineCommand({
    async execute(context, args) {
      const worktreeId = resolveWorktreeId(
        args?.worktreeId,
        context.selectedWorktree?.id ?? null,
      );
      const worktree = findWorktreeById(context, worktreeId ?? undefined);
      const projectId = resolveProjectId(
        args?.projectId,
        worktree?.project_id ?? context.selectedProject?.id ?? null,
      );
      const uiMode = args?.uiMode;
      if (!projectId || !worktreeId || !uiMode) {
        return { reason: "No worktree selected", status: "unavailable" };
      }

      const nextUiMode =
        uiMode === "cycle"
          ? worktree?.ui_mode === "hubris"
            ? "vscode"
            : "hubris"
          : uiMode;

      await useWorktreeStore
        .getState()
        .updateUiMode(projectId, worktreeId, nextUiMode);
      return success();
    },
    group: "Worktrees",
    icon: Monitor,
    id: "worktree.setUiMode",
    isAvailable(context, args) {
      const worktreeId = resolveWorktreeId(
        args?.worktreeId,
        context.selectedWorktree?.id ?? null,
      );
      const worktree = findWorktreeById(context, worktreeId ?? undefined);
      if (!worktree || !args?.uiMode) {
        return disabled("Select a worktree first");
      }

      if (args.uiMode === "cycle") {
        return enabled();
      }

      return worktree.ui_mode === args.uiMode
        ? disabled("Worktree is already in that mode")
        : enabled();
    },
    keywords: ["mode", "hubris", "vscode", "worktree"],
    title: "Switch Worktree Mode",
  }),
} satisfies { [K in CommandId]: CommandDefinition<K> };

export function getCommandDefinition<TId extends CommandId>(
  id: TId,
): CommandDefinition<TId> {
  return commandRegistry[id] as CommandDefinition<TId>;
}

export function commandIds(): CommandId[] {
  return Object.keys(commandRegistry) as CommandId[];
}
