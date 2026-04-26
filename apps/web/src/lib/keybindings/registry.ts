import { getCommandDefinition, type CommandId } from "@/lib/commands";
import { defaultKeybindings, type KeybindingDefinition } from "./defaults";
import {
  formatKeybinding,
  getPlatformFlags,
  normalizeKeybinding,
} from "./keys";
import { stableStringifyJson } from "./json";
import {
  evaluateWhenExpression,
  normalizeWhenExpressionWhitespace,
  type KeybindingWhenContext,
} from "./when";

export type UserKeybindingEntry = {
  args?: unknown;
  command?: string | null;
  disabled?: boolean;
  key: string;
  when?: string | null;
};

export type KeybindingConflict = {
  bindings: KeybindingDefinition[];
  key: string;
};

export type KeybindingRegistry = {
  bindings: KeybindingDefinition[];
  conflicts: KeybindingConflict[];
};

const validationContext = {
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

export function buildKeybindingRegistry(
  userKeybindings: UserKeybindingEntry[],
): KeybindingRegistry {
  const normalizedDefaults = defaultKeybindings.map(normalizeDefinition);
  const normalizedUser = userKeybindings
    .map(normalizeUserDefinition)
    .filter((binding): binding is KeybindingDefinition => binding !== null)
    .filter(hasValidWhenExpression);
  const disabledDefaultKeys = new Set(
    normalizedUser
      .filter((binding) => binding.disabled)
      .map((binding) => bindingPrecedenceKey(binding)),
  );
  const bindings = [
    ...normalizedDefaults.filter(
      (binding) => !disabledDefaultKeys.has(bindingPrecedenceKey(binding)),
    ),
    ...normalizedUser.filter((binding) => !binding.disabled && binding.command),
  ].sort(compareKeybindings);

  return {
    bindings,
    conflicts: findConflicts(bindings),
  };
}

function normalizeUserDefinition(
  binding: UserKeybindingEntry,
): KeybindingDefinition | null {
  try {
    return normalizeDefinition({
      args: binding.args as KeybindingDefinition["args"],
      command: isCommandId(binding.command) ? binding.command : undefined,
      disabled: binding.disabled,
      key: binding.key,
      source: "user",
      when: binding.when ?? undefined,
    });
  } catch {
    return null;
  }
}

export function resolveKeybinding(input: {
  context: KeybindingWhenContext;
  key: string;
  registry: KeybindingRegistry;
}): KeybindingDefinition | null {
  const normalizedKey = normalizeKeybinding(input.key);
  const matches = input.registry.bindings.filter((binding) => {
    if (binding.key !== normalizedKey) {
      return false;
    }
    try {
      return evaluateWhenExpression(binding.when, input.context);
    } catch {
      return false;
    }
  });

  if (matches.length === 0) {
    return null;
  }

  if (hasExactActiveConflict(matches)) {
    return null;
  }

  return matches.sort(compareKeybindingSpecificity)[0] ?? null;
}

export function getFirstKeybindingForCommand(
  registry: KeybindingRegistry,
  command: CommandId,
): string | null {
  const binding =
    registry.bindings.find((candidate) => candidate.command === command) ??
    null;
  return binding ? formatKeybinding(binding.key) : null;
}

export function getFirstKeybindingForCommandArgs(
  registry: KeybindingRegistry,
  command: CommandId,
  args: unknown,
): string | null {
  const serializedArgs = stableStringifyJson(args ?? null);
  const binding =
    registry.bindings.find(
      (candidate) =>
        candidate.command === command &&
        stableStringifyJson(candidate.args ?? null) === serializedArgs,
    ) ?? null;
  return binding ? formatKeybinding(binding.key) : null;
}

function normalizeDefinition<TId extends CommandId>(
  binding: Omit<KeybindingDefinition<TId>, "key"> & { key: string },
): KeybindingDefinition<TId> {
  return {
    ...binding,
    key: normalizeKeybinding(binding.key),
    when: binding.when?.trim() || undefined,
  };
}

function hasValidWhenExpression(binding: KeybindingDefinition): boolean {
  try {
    evaluateWhenExpression(binding.when, validationContext);
    return true;
  } catch {
    return false;
  }
}

function compareKeybindings(
  left: KeybindingDefinition,
  right: KeybindingDefinition,
): number {
  return (
    left.key.localeCompare(right.key) ||
    (left.when ?? "").localeCompare(right.when ?? "") ||
    (left.command ?? "").localeCompare(right.command ?? "") ||
    left.source.localeCompare(right.source)
  );
}

function compareKeybindingSpecificity(
  left: KeybindingDefinition,
  right: KeybindingDefinition,
): number {
  const specificity = whenSpecificity(right.when) - whenSpecificity(left.when);
  if (specificity !== 0) {
    return specificity;
  }

  if (left.source !== right.source) {
    return left.source === "user" ? -1 : 1;
  }

  return compareKeybindings(left, right);
}

function whenSpecificity(when: string | undefined): number {
  if (!when?.trim()) {
    return 0;
  }

  let terms = 1;
  let depth = 0;
  let maxDepth = 0;
  let negations = 0;
  for (let index = 0; index < when.length; index += 1) {
    const char = when[index];
    if (char === "'" || char === '"') {
      index = skipString(when, index, char);
      continue;
    }
    if (char === "(") {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === "!") {
      negations += 1;
      continue;
    }
    if (when.startsWith("&&", index) || when.startsWith("||", index)) {
      terms += 1;
      index += 1;
    }
  }

  return terms * 100 + negations * 10 + maxDepth;
}

function skipString(input: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < input.length) {
    if (input[index] === "\\") {
      index += 2;
      continue;
    }
    if (input[index] === quote) {
      return index;
    }
    index += 1;
  }
  return input.length;
}

function bindingPrecedenceKey(
  binding: Pick<KeybindingDefinition, "key" | "when">,
): string {
  return `${binding.key}\u0000${normalizeWhenExpressionWhitespace(binding.when) ?? ""}`;
}

function commandArgsKey(
  binding: Pick<KeybindingDefinition, "args" | "command">,
): string {
  return `${binding.command ?? ""}\u0000${stableStringifyJson(binding.args ?? null)}`;
}

function hasExactActiveConflict(bindings: KeybindingDefinition[]): boolean {
  const groups = new Map<string, Set<string>>();

  for (const binding of bindings) {
    const precedenceKey = bindingPrecedenceKey(binding);
    const signatures = groups.get(precedenceKey) ?? new Set<string>();
    signatures.add(commandArgsKey(binding));
    groups.set(precedenceKey, signatures);
  }

  return [...groups.values()].some((signatures) => signatures.size > 1);
}

function findConflicts(bindings: KeybindingDefinition[]): KeybindingConflict[] {
  const grouped = new Map<string, KeybindingDefinition[]>();
  for (const binding of bindings) {
    const key = bindingPrecedenceKey(binding);
    grouped.set(key, [...(grouped.get(key) ?? []), binding]);
  }

  return [...grouped.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([key, entries]) => ({ bindings: entries, key }));
}

function isCommandId(value: string | null | undefined): value is CommandId {
  if (!value) {
    return false;
  }

  try {
    return getCommandDefinition(value as CommandId).id === value;
  } catch {
    return false;
  }
}
