import type { SectionName } from "@/components/settings-dialog/sections";
import type { JsonValue } from "@/lib/contracts/sse.generated";
import type { CommandId } from "./types";

export type CommandArgField =
  | {
      key: string;
      label: string;
      placeholder?: string;
      required?: boolean;
      type: "string";
    }
  | {
      key: string;
      label: string;
      required?: boolean;
      type: "boolean";
    }
  | {
      key: string;
      label: string;
      options: readonly { label: string; value: string }[];
      placeholder?: string;
      required?: boolean;
      type: "select";
    };

export type CommandArgFieldValues = Record<string, string>;

const settingsSections = [
  "Appearance",
  "Editor",
  "Terminal",
  "Keyboard Shortcuts",
  "VS Code",
  "Worktrees",
] as const satisfies readonly SectionName[];

const settingsSectionOptions = settingsSections.map((section) => ({
  label: section,
  value: section,
}));

const saveBehaviorOptions = [
  { label: "Discard changes", value: "discard" },
  { label: "Save changes", value: "save" },
] as const;

const worktreeModeOptions = [
  { label: "Hubris", value: "hubris" },
  { label: "VS Code", value: "vscode" },
  { label: "Cycle", value: "cycle" },
] as const;

const worktreeHistoryDirectionOptions = [
  { label: "Back", value: "back" },
  { label: "Forward", value: "forward" },
] as const;

const commandArgFields = {
  "app.openSettings": [
    {
      key: "section",
      label: "Section",
      options: settingsSectionOptions,
      type: "select",
    },
  ],
  "pane.splitDown": [
    stringField("paneId", "Pane ID"),
    stringField("projectId", "Project ID"),
    stringField("worktreeId", "Worktree ID"),
  ],
  "pane.splitRight": [
    stringField("paneId", "Pane ID"),
    stringField("projectId", "Project ID"),
    stringField("worktreeId", "Worktree ID"),
  ],
  "project.add": [stringField("path", "Path", "/path/to/repository")],
  "project.remove": [
    stringField("projectId", "Project ID"),
    booleanField("deleteManagedWorktrees", "Delete Managed Worktrees"),
    booleanField("force", "Force"),
  ],
  "project.rename": [
    stringField("projectId", "Project ID"),
    stringField("name", "Name"),
  ],
  "settings.openSection": [
    {
      key: "section",
      label: "Section",
      options: settingsSectionOptions,
      required: true,
      type: "select",
    },
  ],
  "tab.close": [
    stringField("tabId", "Tab ID"),
    {
      key: "saveBehavior",
      label: "Save Behavior",
      options: saveBehaviorOptions,
      type: "select",
    },
  ],
  "tab.focus": [stringField("tabId", "Tab ID")],
  "tab.newBrowser": [
    stringField("paneId", "Pane ID"),
    stringField("url", "URL", "http://localhost:5173"),
    stringField("worktreeId", "Worktree ID"),
  ],
  "tab.newTerminal": [
    stringField("paneId", "Pane ID"),
    stringField("worktreeId", "Worktree ID"),
  ],
  "tab.pin": [stringField("tabId", "Tab ID")],
  "tab.renameTerminal": [
    stringField("tabId", "Tab ID"),
    stringField("name", "Name"),
  ],
  "tab.resetTerminalName": [stringField("tabId", "Tab ID")],
  "worktree.create": [
    stringField("branch", "Branch"),
    stringField("projectId", "Project ID"),
    stringField("sourceRef", "Source Ref"),
    stringField("startPoint", "Start Point"),
  ],
  "worktree.import": [
    stringField("path", "Path", "/path/to/worktree"),
    stringField("projectId", "Project ID"),
  ],
  "worktree.remove": [
    stringField("projectId", "Project ID"),
    booleanField("force", "Force"),
    booleanField("untrackOnly", "Untrack Only"),
    stringField("worktreeId", "Worktree ID"),
  ],
  "worktree.rename": [
    stringField("name", "Name"),
    stringField("projectId", "Project ID"),
    stringField("worktreeId", "Worktree ID"),
  ],
  "worktree.select": [stringField("worktreeId", "Worktree ID")],
  "worktree.showHistorySwitcher": [
    {
      key: "direction",
      label: "Direction",
      options: worktreeHistoryDirectionOptions,
      type: "select",
    },
  ],
  "worktree.setUiMode": [
    stringField("projectId", "Project ID"),
    {
      key: "uiMode",
      label: "UI Mode",
      options: worktreeModeOptions,
      type: "select",
    },
    stringField("worktreeId", "Worktree ID"),
  ],
} satisfies Partial<Record<CommandId, readonly CommandArgField[]>>;

const commandArgFieldsByCommand: Partial<
  Record<CommandId, readonly CommandArgField[]>
> = commandArgFields;

export function commandArgFieldsForCommand(
  command: CommandId,
): readonly CommandArgField[] {
  return commandArgFieldsByCommand[command] ?? [];
}

export function argsToFieldValues(
  args: JsonValue | null | undefined,
  fields: readonly CommandArgField[],
): CommandArgFieldValues {
  if (!isObjectRecord(args)) {
    return {};
  }

  const result: CommandArgFieldValues = {};
  for (const field of fields) {
    const value = args[field.key];
    if (typeof value === "string") {
      result[field.key] = value;
    } else if (typeof value === "boolean") {
      result[field.key] = String(value);
    }
  }
  return result;
}

export function canEditArgsWithFields(
  args: JsonValue | null | undefined,
  fields: readonly CommandArgField[],
): boolean {
  if (args === undefined || args === null) {
    return true;
  }
  if (!isObjectRecord(args)) {
    return false;
  }

  return Object.entries(args).every(([key, value]) => {
    const field = fields.find((candidate) => candidate.key === key);
    if (!field || value === null) {
      return false;
    }
    return field.type === "boolean"
      ? typeof value === "boolean"
      : typeof value === "string";
  });
}

export function fieldValuesToArgs(
  fields: readonly CommandArgField[],
  values: CommandArgFieldValues,
): JsonValue | undefined {
  const result: Record<string, JsonValue> = {};

  for (const field of fields) {
    const value = values[field.key]?.trim() ?? "";
    if (!value) {
      if (field.required) {
        throw new Error(`${field.label} is required.`);
      }
      continue;
    }

    if (field.type === "boolean") {
      result[field.key] = value === "true";
    } else {
      result[field.key] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function stringField(
  key: string,
  label: string,
  placeholder?: string,
): CommandArgField {
  return { key, label, placeholder, type: "string" };
}

function booleanField(key: string, label: string): CommandArgField {
  return { key, label, type: "boolean" };
}

function isObjectRecord(
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
