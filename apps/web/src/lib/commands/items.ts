import { commandIds, getCommandDefinition } from "./registry";
import type { CommandContextSnapshot, CommandPaletteItem } from "./types";
import { sections } from "@/components/settings-dialog/sections";

const STATIC_PALETTE_COMMANDS = [
  "project.add",
  "worktree.create",
  "tab.newTerminal",
  "tab.newBrowser",
  "pane.splitRight",
  "pane.splitDown",
  "tab.close",
  "app.openSettings",
] as const;

function baseKeywords(id: (typeof STATIC_PALETTE_COMMANDS)[number]) {
  return getCommandDefinition(id).keywords ?? [];
}

export function getCommandPaletteItems(
  context: CommandContextSnapshot,
): CommandPaletteItem[] {
  const items: CommandPaletteItem[] = [];

  for (const id of STATIC_PALETTE_COMMANDS) {
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
      subtitle: project.name,
      title: `New Worktree in ${project.name}`,
    });
  }

  for (const worktree of context.worktrees) {
    if (worktree.id === context.selectedWorktree?.id) {
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
        worktree.name,
        worktree.branch,
      ],
      subtitle: worktree.branch,
      title: `Switch to ${worktree.name}`,
    });
  }

  if (context.selectedWorktree) {
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
          uiMode,
        ],
        subtitle: context.selectedWorktree.name,
        title: `Switch Current Worktree to ${
          uiMode === "hubris" ? "Hubris" : "VS Code"
        }`,
      });
    }
  }

  const selectedWorktreeId = context.selectedWorktree?.id;
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
    .filter(
      (item) =>
        getCommandDefinition(item.id).isAvailable(context, item.args as never)
          .enabled,
    )
    .sort((left, right) => {
      const groupComparison = left.group.localeCompare(right.group);
      if (groupComparison !== 0) {
        return groupComparison;
      }
      return left.title.localeCompare(right.title);
    });
}

export function getRegisteredCommandIds() {
  return commandIds();
}
