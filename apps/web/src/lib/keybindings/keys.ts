export type NormalizedKeybinding = {
  alt: boolean;
  code: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
};

const MODIFIER_ALIASES: Record<
  string,
  keyof Omit<NormalizedKeybinding, "code">
> = {
  alt: "alt",
  cmd: "meta",
  command: "meta",
  control: "ctrl",
  ctrl: "ctrl",
  meta: "meta",
  option: "alt",
  shift: "shift",
};

const KEY_ALIASES: Record<string, string> = {
  " ": "space",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  arrowup: "up",
  esc: "escape",
  return: "enter",
};

const DISPLAY_KEYS: Record<string, string> = {
  down: "Down",
  enter: "Enter",
  escape: "Esc",
  left: "Left",
  right: "Right",
  space: "Space",
  up: "Up",
};

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

function canonicalKey(key: string): string {
  const normalized = key.trim().toLowerCase();
  return KEY_ALIASES[normalized] ?? normalized;
}

export function parseKeybinding(input: string): NormalizedKeybinding {
  const parts = input
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const result: NormalizedKeybinding = {
    alt: false,
    code: "",
    ctrl: false,
    meta: false,
    shift: false,
  };

  for (const part of parts) {
    const lowerPart = part.toLowerCase();
    const modifier =
      lowerPart === "mod"
        ? isMacPlatform()
          ? "meta"
          : "ctrl"
        : MODIFIER_ALIASES[lowerPart];
    if (modifier) {
      result[modifier] = true;
      continue;
    }

    if (result.code) {
      throw new Error(`Keybinding "${input}" has multiple keys`);
    }
    result.code = canonicalKey(part);
  }

  if (!result.code) {
    throw new Error(`Keybinding "${input}" is missing a key`);
  }

  return result;
}

export function normalizeKeybinding(input: string): string {
  const parsed = parseKeybinding(input);
  return serializeKeybinding(parsed);
}

export function serializeKeybinding(input: NormalizedKeybinding): string {
  return [
    input.ctrl ? "ctrl" : null,
    input.meta ? "meta" : null,
    input.alt ? "alt" : null,
    input.shift ? "shift" : null,
    input.code,
  ]
    .filter((part): part is string => !!part)
    .join("+");
}

export function keybindingFromEvent(
  event: Pick<
    KeyboardEvent,
    "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
  >,
): string {
  return serializeKeybinding({
    alt: event.altKey,
    code: canonicalKey(event.key),
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
  });
}

export function formatKeybinding(input: string): string {
  const parsed = parseKeybinding(input);
  const key =
    DISPLAY_KEYS[parsed.code] ??
    (parsed.code.length === 1 ? parsed.code.toUpperCase() : parsed.code);

  if (isMacPlatform()) {
    return [
      parsed.ctrl ? "^" : "",
      parsed.alt ? "⌥" : "",
      parsed.shift ? "⇧" : "",
      parsed.meta ? "⌘" : "",
      key,
    ].join("");
  }

  return [
    parsed.ctrl ? "Ctrl" : null,
    parsed.meta ? "Meta" : null,
    parsed.alt ? "Alt" : null,
    parsed.shift ? "Shift" : null,
    key,
  ]
    .filter((part): part is string => !!part)
    .join("+");
}
