import type {
  CommandArgsById,
  CommandDefinition,
  CommandId,
} from "@/lib/commands";
import { commandIds, getCommandDefinition } from "@/lib/commands/registry";
import type { JsonValue, KeybindingEntry } from "@/lib/contracts/sse.generated";
import { defaultKeybindings, type KeybindingDefinition } from "./defaults";
import {
  formatKeybinding,
  getPlatformFlags,
  normalizeKeybinding,
  normalizeKeybindingForStorage,
} from "./keys";
import { stableStringifyJson } from "./json";
import { evaluateWhenExpression, type KeybindingWhenContext } from "./when";

const RESERVED_KEYBINDINGS = new Set([
  "ctrl+f5",
  "ctrl+l",
  "ctrl+n",
  "ctrl+r",
  "ctrl+shift+i",
  "ctrl+shift+n",
  "ctrl+shift+r",
  "ctrl+t",
  "ctrl+w",
  "f5",
  "meta+l",
  "meta+n",
  "meta+q",
  "meta+r",
  "meta+shift+i",
  "meta+shift+n",
  "meta+shift+r",
  "meta+t",
  "meta+w",
]);

// Keep this permissive sample in sync with getKeybindingWhenContext().
const VALIDATION_CONTEXT = {
  activeTabPreview: false,
  activeTabType: "terminal",
  browserFocus: false,
  commandPaletteOpen: false,
  dialogOpen: false,
  editorFocus: false,
  focusedPane: true,
  gitStatusFocus: false,
  inputFocus: false,
  ...getPlatformFlags(),
  selectedProject: true,
  selectedWorktree: true,
  terminalFocus: false,
} satisfies KeybindingWhenContext;

export type EditableKeybindingEntry = KeybindingEntry;

export type CommandShortcutBinding = {
  args?: JsonValue | null;
  command: CommandId;
  entryIndex?: number;
  formattedKey: string;
  key: string;
  source: "default" | "user";
  when?: string | null;
};

export type CommandShortcutRow = {
  command: CommandDefinition;
  defaultBindings: CommandShortcutBinding[];
  hasDefaultOverrides: boolean;
  searchText: string;
  userBindings: CommandShortcutBinding[];
};

export type KeybindingConflict = {
  bindings: CommandShortcutBinding[];
  key: string;
  when: string;
};

export type KeybindingValidationResult = {
  conflicts: KeybindingConflict[];
  duplicates: KeybindingConflict[];
  errors: string[];
};

export function buildCommandShortcutRows(
  userKeybindings: EditableKeybindingEntry[],
): CommandShortcutRow[] {
  const defaultsByCommand = groupDefaultBindings();
  const userByCommand = groupUserBindings(userKeybindings);
  const disabledDefaults = collectDisabledDefaultKeys(userKeybindings);

  return commandIds()
    .map((commandId) => {
      const command = getCommandDefinition(commandId);
      const defaultBindings = (defaultsByCommand.get(commandId) ?? []).map(
        (binding) => bindingFromDefault(binding),
      );
      const activeDefaults = defaultBindings.filter(
        (binding) =>
          !disabledDefaults.has(defaultDisableKey(binding.key, binding.when)),
      );
      const userBindings = userByCommand.get(commandId) ?? [];
      const searchText = [
        command.title,
        command.id,
        command.group,
        ...(command.keywords ?? []),
      ]
        .join(" ")
        .toLowerCase();

      return {
        command,
        defaultBindings: activeDefaults,
        hasDefaultOverrides: defaultBindings.length !== activeDefaults.length,
        searchText,
        userBindings,
      } satisfies CommandShortcutRow;
    })
    .sort((left, right) => {
      return (
        left.command.group.localeCompare(right.command.group) ||
        left.command.title.localeCompare(right.command.title) ||
        left.command.id.localeCompare(right.command.id)
      );
    });
}

export function addUserShortcut(input: {
  args?: JsonValue | null;
  command: CommandId;
  key: string;
  keybindings: EditableKeybindingEntry[];
  when?: string | null;
}): EditableKeybindingEntry[] {
  return [
    ...input.keybindings,
    {
      args: input.args ?? undefined,
      command: input.command,
      disabled: false,
      key: normalizeKeybindingForStorage(input.key),
      when: normalizeOptionalWhen(input.when),
    },
  ];
}

export function replaceUserShortcut(input: {
  entryIndex: number;
  key: string;
  keybindings: EditableKeybindingEntry[];
}): EditableKeybindingEntry[] {
  return input.keybindings.map((binding, index) =>
    index === input.entryIndex
      ? { ...binding, key: normalizeKeybindingForStorage(input.key) }
      : binding,
  );
}

export function updateUserShortcutAdvanced(input: {
  args: JsonValue | undefined;
  entryIndex: number;
  keybindings: EditableKeybindingEntry[];
  when: string;
}): EditableKeybindingEntry[] {
  if (input.args !== undefined) {
    assertJsonValueWithoutNull(input.args);
  }
  return input.keybindings.map((binding, index) =>
    index === input.entryIndex
      ? {
          ...binding,
          args: input.args,
          when: normalizeOptionalWhen(input.when),
        }
      : binding,
  );
}

export function removeUserShortcut(
  keybindings: EditableKeybindingEntry[],
  entryIndex: number,
): EditableKeybindingEntry[] {
  return keybindings.filter((_, index) => index !== entryIndex);
}

export function disableCommandDefaults(
  keybindings: EditableKeybindingEntry[],
  command: CommandId,
): EditableKeybindingEntry[] {
  const additions = defaultKeybindings
    .filter((binding) => binding.command === command)
    .filter(
      (binding) =>
        !keybindings.some((entry) => disablesDefaultBinding(entry, binding)),
    )
    .map((binding) => ({
      disabled: true,
      key: normalizeKeybindingForStorage(binding.key),
      when: normalizeOptionalWhen(binding.when),
    }));

  return [...keybindings, ...additions];
}

export function resetCommandKeybindings(
  keybindings: EditableKeybindingEntry[],
  command: CommandId,
): EditableKeybindingEntry[] {
  const defaults = defaultKeybindings.filter(
    (binding) => binding.command === command,
  );
  return keybindings.filter((entry) => {
    if (entry.command === command) {
      return false;
    }
    return !defaults.some((binding) => disablesDefaultBinding(entry, binding));
  });
}

export function stringifyArgs(args: JsonValue | null | undefined): string {
  if (args === undefined || args === null) {
    return "";
  }
  return JSON.stringify(args, null, 2);
}

export function parseArgsText(input: string): JsonValue | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as JsonValue;
  assertJsonValueWithoutNull(parsed);
  return parsed;
}

export function validateKeybindingDraft(
  keybindings: EditableKeybindingEntry[],
): KeybindingValidationResult {
  const errors: string[] = [];
  const activeBindings: CommandShortcutBinding[] = [];
  const disabledDefaults = collectDisabledDefaultKeys(keybindings, errors);

  for (const binding of defaultKeybindings) {
    if (disabledDefaults.has(defaultDisableKey(binding.key, binding.when))) {
      continue;
    }
    try {
      activeBindings.push(bindingFromDefault(binding));
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  keybindings.forEach((binding, entryIndex) => {
    try {
      normalizeKeybinding(binding.key);
      if (binding.when) {
        evaluateWhenExpression(binding.when, VALIDATION_CONTEXT);
      }
      if (binding.args !== undefined && binding.args !== null) {
        assertJsonValueWithoutNull(binding.args);
      }
      if (binding.command && !isCommandId(binding.command)) {
        errors.push(`Unknown command "${binding.command}".`);
      }
      if (!binding.disabled && isCommandId(binding.command)) {
        activeBindings.push(bindingFromUser(binding, entryIndex));
      }
    } catch (error) {
      errors.push(errorMessage(error));
    }
  });

  const groups = groupActiveBindings(activeBindings);
  const conflicts: KeybindingConflict[] = [];
  const duplicates: KeybindingConflict[] = [];

  for (const [key, bindings] of groups) {
    const signatures = new Set(bindings.map(commandArgsKey));
    const [shortcut, when] = key.split("\u0000");
    if (signatures.size > 1) {
      conflicts.push({ bindings, key: shortcut, when });
    } else if (bindings.length > 1) {
      duplicates.push({ bindings, key: shortcut, when });
    }
  }

  return { conflicts, duplicates, errors };
}

export function isReservedKeybinding(key: string): boolean {
  try {
    return RESERVED_KEYBINDINGS.has(normalizeKeybinding(key));
  } catch {
    return false;
  }
}

function groupDefaultBindings() {
  const result = new Map<CommandId, KeybindingDefinition[]>();
  for (const binding of defaultKeybindings) {
    if (!binding.command) {
      continue;
    }
    result.set(binding.command, [
      ...(result.get(binding.command) ?? []),
      binding,
    ]);
  }
  return result;
}

function groupUserBindings(keybindings: EditableKeybindingEntry[]) {
  const result = new Map<CommandId, CommandShortcutBinding[]>();
  keybindings.forEach((binding, entryIndex) => {
    if (binding.disabled || !isCommandId(binding.command)) {
      return;
    }
    let shortcut: CommandShortcutBinding;
    try {
      shortcut = bindingFromUser(binding, entryIndex);
    } catch {
      return;
    }
    result.set(shortcut.command, [
      ...(result.get(shortcut.command) ?? []),
      shortcut,
    ]);
  });
  return result;
}

function bindingFromDefault(
  binding: KeybindingDefinition,
): CommandShortcutBinding {
  if (!binding.command) {
    throw new Error("Default keybinding is missing a command");
  }
  const key = normalizeKeybinding(binding.key);
  return {
    args: (binding.args ?? undefined) as JsonValue | undefined,
    command: binding.command,
    formattedKey: formatKeybinding(key),
    key,
    source: "default",
    when: binding.when,
  };
}

function bindingFromUser(
  binding: EditableKeybindingEntry,
  entryIndex: number,
): CommandShortcutBinding {
  if (!isCommandId(binding.command)) {
    throw new Error(`Unknown command "${binding.command ?? ""}".`);
  }
  const key = normalizeKeybinding(binding.key);
  return {
    args: binding.args,
    command: binding.command,
    entryIndex,
    formattedKey: formatKeybinding(key),
    key,
    source: "user",
    when: binding.when,
  };
}

function groupActiveBindings(bindings: CommandShortcutBinding[]) {
  const result = new Map<string, CommandShortcutBinding[]>();
  for (const binding of bindings) {
    const key = `${binding.key}\u0000${normalizeOptionalWhen(binding.when) ?? ""}`;
    result.set(key, [...(result.get(key) ?? []), binding]);
  }
  return result;
}

function commandArgsKey(binding: CommandShortcutBinding): string {
  return `${binding.command}\u0000${stableStringifyJson(binding.args ?? null)}`;
}

function defaultDisableKey(key: string, when: string | null | undefined) {
  return `${normalizeKeybinding(key)}\u0000${normalizeOptionalWhen(when) ?? ""}`;
}

function disablesDefaultBinding(
  entry: EditableKeybindingEntry,
  binding: KeybindingDefinition,
): boolean {
  if (!entry.disabled) {
    return false;
  }
  try {
    return (
      defaultDisableKey(entry.key, entry.when) ===
      defaultDisableKey(binding.key, binding.when)
    );
  } catch {
    return false;
  }
}

function collectDisabledDefaultKeys(
  keybindings: EditableKeybindingEntry[],
  errors?: string[],
): Set<string> {
  const disabledDefaults = new Set<string>();
  for (const binding of keybindings) {
    if (!binding.disabled) {
      continue;
    }
    try {
      disabledDefaults.add(defaultDisableKey(binding.key, binding.when));
    } catch (error) {
      errors?.push(errorMessage(error));
    }
  }
  return disabledDefaults;
}

function normalizeOptionalWhen(when: string | null | undefined) {
  const normalized = when?.trim();
  return normalized ? normalized : undefined;
}

function isCommandId(value: string | null | undefined): value is CommandId {
  if (!value) {
    return false;
  }
  return (commandIds() as string[]).includes(value);
}

function assertJsonValueWithoutNull(value: JsonValue): void {
  if (value === null) {
    throw new Error("Keybinding args cannot contain null values.");
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonValueWithoutNull(item);
    }
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      assertJsonValueWithoutNull(item);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type CommandShortcutArgs<TId extends CommandId> =
  | CommandArgsById[TId]
  | undefined;
