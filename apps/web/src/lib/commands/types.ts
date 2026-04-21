import type { LucideIcon } from "lucide-react";
import type { SectionName } from "@/components/settings-dialog/sections";
import type { Project, Tab, Worktree } from "@/lib/types";

export type CommandId =
  | "app.openSettings"
  | "pane.splitDown"
  | "pane.splitRight"
  | "project.add"
  | "project.remove"
  | "project.rename"
  | "settings.openSection"
  | "tab.close"
  | "tab.focus"
  | "tab.newBrowser"
  | "tab.newTerminal"
  | "tab.pin"
  | "tab.renameTerminal"
  | "tab.resetTerminalName"
  | "worktree.create"
  | "worktree.remove"
  | "worktree.rename"
  | "worktree.select"
  | "worktree.setUiMode";

export type CommandArgsById = {
  "app.openSettings": { section?: SectionName } | undefined;
  "pane.splitDown":
    | { paneId?: string; projectId?: string; worktreeId?: string }
    | undefined;
  "pane.splitRight":
    | { paneId?: string; projectId?: string; worktreeId?: string }
    | undefined;
  "project.add": { path?: string } | undefined;
  "project.remove":
    | { deleteManagedWorktrees?: boolean; force?: boolean; projectId?: string }
    | undefined;
  "project.rename": { name?: string; projectId?: string } | undefined;
  "settings.openSection": { section: SectionName };
  "tab.close":
    | {
        saveBehavior?: "discard" | "save";
        tabId?: string;
      }
    | undefined;
  "tab.focus": { tabId?: string } | undefined;
  "tab.newBrowser":
    | { paneId?: string; url?: string; worktreeId?: string }
    | undefined;
  "tab.newTerminal": { paneId?: string; worktreeId?: string } | undefined;
  "tab.pin": { tabId?: string } | undefined;
  "tab.renameTerminal": { name?: string; tabId?: string } | undefined;
  "tab.resetTerminalName": { tabId?: string } | undefined;
  "worktree.create":
    | {
        branch?: string;
        projectId?: string;
        sourceRef?: string;
        startPoint?: string;
      }
    | undefined;
  "worktree.remove":
    | {
        force?: boolean;
        projectId?: string;
        untrackOnly?: boolean;
        worktreeId?: string;
      }
    | undefined;
  "worktree.rename":
    | {
        name?: string;
        projectId?: string;
        worktreeId?: string;
      }
    | undefined;
  "worktree.select": { worktreeId?: string } | undefined;
  "worktree.setUiMode":
    | {
        projectId?: string;
        uiMode?: Worktree["ui_mode"];
        worktreeId?: string;
      }
    | undefined;
};

export type AnyCommandArgs = CommandArgsById[CommandId];

export type CommandAvailability = {
  enabled: boolean;
  reason?: string;
};

export type CommandResult =
  | { status: "success" }
  | { status: "cancelled" }
  | { status: "unavailable"; reason?: string }
  | { message: string; status: "error" };

export type CommandSource =
  | "button"
  | "command-palette"
  | "context-menu"
  | "dialog"
  | "system"
  | "tab-bar";

export type CommandContextSnapshot = {
  activeTab: Tab | null;
  focusedPaneId: string | null;
  projects: Project[];
  selectedProject: Project | null;
  selectedWorktree: Worktree | null;
  tabs: Tab[];
  worktrees: Worktree[];
  worktreesByProject: Record<string, Worktree[]>;
};

export type CommandDefinition<TId extends CommandId = CommandId> = {
  execute: (
    context: CommandContextSnapshot,
    args: CommandArgsById[TId] | undefined,
    source: CommandSource,
  ) => Promise<CommandResult>;
  group: string;
  icon?: LucideIcon;
  id: TId;
  isAvailable: (
    context: CommandContextSnapshot,
    args: CommandArgsById[TId] | undefined,
  ) => CommandAvailability;
  keywords?: string[];
  title: string;
};

export type CommandPaletteItem = {
  args?: AnyCommandArgs;
  group: string;
  icon?: LucideIcon;
  id: CommandId;
  key: string;
  keywords: string[];
  searchText?: string;
  subtitle?: string;
  title: string;
};
