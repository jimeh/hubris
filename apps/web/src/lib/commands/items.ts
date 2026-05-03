import { projectForWorktree } from "@/lib/commands/context";
import { commandIds, getCommandDefinition } from "@/lib/commands/registry";
import { useChatStore } from "@/lib/stores/chats";
import type {
  AnyCommandPaletteItem,
  CommandContextSnapshot,
  CommandId,
  CommandPaletteItem,
} from "@/lib/commands/types";
import { sections } from "@/components/settings-dialog/sections";

const STATIC_PALETTE_COMMANDS = [
  "project.add",
  "worktree.create",
  "tab.newTerminal",
  "tab.newBrowser",
  "tab.newChat",
  "pane.splitRight",
  "pane.splitDown",
  "tab.close",
  "worktree.select",
  "app.openSettings",
] as const;

function baseKeywords(id: (typeof STATIC_PALETTE_COMMANDS)[number]) {
  return getCommandDefinition(id).keywords ?? [];
}

function formatProjectScopedWorktreeSubtitle(input: {
  branch?: string;
  projectName: string;
  worktreeName?: string;
}) {
  const parts = [input.projectName];

  if (input.worktreeName) {
    parts.push(input.worktreeName);
  }

  if (input.branch) {
    parts.push(input.branch);
  }

  return parts.join(" • ");
}

function shouldIncludeStaticPaletteCommand(
  id: (typeof STATIC_PALETTE_COMMANDS)[number],
  context: CommandContextSnapshot,
) {
  if (id === "worktree.create" && context.projects.length > 0) {
    return false;
  }

  return true;
}

export function getCommandPaletteItems(
  context: CommandContextSnapshot,
): AnyCommandPaletteItem[] {
  const items: AnyCommandPaletteItem[] = [];

  for (const id of STATIC_PALETTE_COMMANDS) {
    if (!shouldIncludeStaticPaletteCommand(id, context)) {
      continue;
    }

    const definition = getCommandDefinition(id);
    const availability = definition.isAvailable(context, undefined);
    if (!availability.enabled) {
      continue;
    }

    items.push({
      group: definition.group,
      icon: definition.icon,
      id,
      key: id,
      keywords: baseKeywords(id),
      title: definition.title,
    });
  }

  for (const project of context.projects) {
    items.push({
      args: { projectId: project.id },
      group: "Worktrees",
      icon: getCommandDefinition("worktree.create").icon,
      id: "worktree.create",
      key: `worktree.create:${project.id}`,
      keywords: [
        ...(getCommandDefinition("worktree.create").keywords ?? []),
        project.name,
      ],
      searchText: `New Worktree in ${project.name}`,
      subtitle: project.name,
      title: `New Worktree in ${project.name}`,
    });
  }

  for (const worktree of context.worktrees) {
    if (worktree.id === context.selectedWorktree?.id) {
      continue;
    }

    const project = projectForWorktree(context, worktree.id);
    if (!project) {
      continue;
    }

    items.push({
      args: { worktreeId: worktree.id },
      group: "Worktrees",
      icon: getCommandDefinition("worktree.select").icon,
      id: "worktree.select",
      key: `worktree.select:${worktree.id}`,
      keywords: [
        ...(getCommandDefinition("worktree.select").keywords ?? []),
        project.name,
        worktree.name,
        worktree.branch,
      ],
      searchText: `Switch to ${worktree.name} ${project.name} ${worktree.branch}`,
      subtitle: formatProjectScopedWorktreeSubtitle({
        branch: worktree.branch,
        projectName: project.name,
      }),
      title: `Switch to ${worktree.name}`,
    });
  }

  if (context.selectedWorktree) {
    const project = projectForWorktree(context, context.selectedWorktree.id);

    for (const uiMode of ["hubris", "vscode"] as const) {
      if (context.selectedWorktree.ui_mode === uiMode) {
        continue;
      }

      items.push({
        args: {
          projectId: context.selectedWorktree.project_id,
          uiMode,
          worktreeId: context.selectedWorktree.id,
        },
        group: "Worktrees",
        icon: getCommandDefinition("worktree.setUiMode").icon,
        id: "worktree.setUiMode",
        key: `worktree.setUiMode:${uiMode}`,
        keywords: [
          ...(getCommandDefinition("worktree.setUiMode").keywords ?? []),
          project?.name ?? "",
          context.selectedWorktree.name,
          uiMode,
        ],
        searchText: `Switch Current Worktree to ${
          uiMode === "hubris" ? "Hubris" : "VS Code"
        } ${project?.name ?? ""} ${context.selectedWorktree.name}`,
        subtitle: project
          ? formatProjectScopedWorktreeSubtitle({
              projectName: project.name,
              worktreeName: context.selectedWorktree.name,
            })
          : context.selectedWorktree.name,
        title: `Switch Current Worktree to ${
          uiMode === "hubris" ? "Hubris" : "VS Code"
        }`,
      });
    }
  }

  const selectedWorktreeId = context.selectedWorktree?.id;
  const selectedBranch = context.selectedWorktree?.branch;
  const conversations = Object.values(useChatStore.getState().conversationsById)
    .filter(
      (conversation) =>
        conversation.archivedAt == null &&
        (conversation.branchName && selectedBranch
          ? conversation.branchName === selectedBranch
          : conversation.worktreeId === selectedWorktreeId) &&
        !context.tabs.some(
          (tab) =>
            tab.type === "agent_chat" &&
            tab.conversation_id === conversation.id,
        ),
    )
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt);

  for (const conversation of conversations) {
    items.push({
      args: {
        conversationId: conversation.id,
        worktreeId: selectedWorktreeId ?? conversation.worktreeId,
      },
      group: "Tabs",
      icon: getCommandDefinition("tab.openChat").icon,
      id: "tab.openChat",
      key: `tab.openChat:${conversation.id}`,
      keywords: [
        ...(getCommandDefinition("tab.openChat").keywords ?? []),
        conversation.title,
      ],
      sortPriority: -conversation.lastActivityAt,
      subtitle: "Chat",
      title: `Open ${conversation.title}`,
    });
  }

  for (const tab of context.tabs) {
    if (selectedWorktreeId && tab.worktree_id !== selectedWorktreeId) {
      continue;
    }
    if (tab.id === context.activeTab?.id) {
      continue;
    }

    items.push({
      args: { tabId: tab.id },
      group: "Tabs",
      icon: getCommandDefinition("tab.focus").icon,
      id: "tab.focus",
      key: `tab.focus:${tab.id}`,
      keywords: [
        ...(getCommandDefinition("tab.focus").keywords ?? []),
        tab.label,
      ],
      subtitle: tab.type,
      title: `Focus ${tab.label}`,
    });
  }

  for (const section of sections) {
    items.push({
      args: { section: section.name },
      group: "Settings",
      icon: section.icon,
      id: "settings.openSection",
      key: `settings.openSection:${section.name}`,
      keywords: [
        ...(getCommandDefinition("settings.openSection").keywords ?? []),
        section.name,
      ],
      subtitle: "Settings",
      title: `Open ${section.name} Settings`,
    });
  }

  return items
    .filter((item) => isPaletteItemAvailable(context, item))
    .sort((left, right) => {
      const groupComparison = left.group.localeCompare(right.group);
      if (groupComparison !== 0) {
        return groupComparison;
      }
      if (left.id === "tab.openChat" && right.id === "tab.openChat") {
        const priorityComparison =
          (left.sortPriority ?? 0) - (right.sortPriority ?? 0);
        if (priorityComparison !== 0) {
          return priorityComparison;
        }
      }
      const titleComparison = left.title.localeCompare(right.title);
      if (titleComparison !== 0) {
        return titleComparison;
      }

      const subtitleComparison = (left.subtitle ?? "").localeCompare(
        right.subtitle ?? "",
      );
      if (subtitleComparison !== 0) {
        return subtitleComparison;
      }

      return left.key.localeCompare(right.key);
    });
}

function isPaletteItemAvailable<TId extends CommandId>(
  context: CommandContextSnapshot,
  item: CommandPaletteItem<TId>,
) {
  return getCommandDefinition(item.id).isAvailable(context, item.args).enabled;
}

export function getRegisteredCommandIds() {
  return commandIds();
}
