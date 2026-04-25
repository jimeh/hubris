export type NormalizedKeybinding = {
  alt: boolean;
  code: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
};

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    platform?: string;
  };
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

const CODE_KEY_ALIASES: Record<string, string> = {
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Enter: "enter",
  Equal: "=",
  Escape: "escape",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
  Space: "space",
  Tab: "tab",
};

export function isMacPlatform(): boolean {
  return getPlatformFlags().isMacOS;
}

export function getPlatformFlags() {
  const platform = getNavigatorPlatform();
  return {
    isLinux: /linux|x11/i.test(platform),
    isMacOS: /mac|iphone|ipad|ipod/i.test(platform),
    isWindows: /win/i.test(platform),
  };
}

function getNavigatorPlatform(): string {
  if (typeof navigator === "undefined") {
    return "";
  }
  const navigatorWithUserAgentData = navigator as NavigatorWithUserAgentData;
  return (
    navigatorWithUserAgentData.userAgentData?.platform ??
    navigator.platform ??
    ""
  );
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

export function normalizeKeybindingForStorage(input: string): string {
  const parsed = parseStorageKeybinding(input);
  return serializeStorageKeybinding(parsed);
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
  > &
    Partial<Pick<KeyboardEvent, "code">>,
): string {
  const macPlatform = isMacPlatform();
  return serializeStorageKeybinding({
    alt: event.altKey,
    code: keyCodeFromEvent(event),
    ctrl: macPlatform ? event.ctrlKey : false,
    meta: macPlatform ? false : event.metaKey,
    mod: macPlatform ? event.metaKey : event.ctrlKey,
    shift: event.shiftKey,
  });
}

type StorageKeybinding = NormalizedKeybinding & {
  mod: boolean;
};

function parseStorageKeybinding(input: string): StorageKeybinding {
  const parts = input
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const result: StorageKeybinding = {
    alt: false,
    code: "",
    ctrl: false,
    meta: false,
    mod: false,
    shift: false,
  };

  for (const part of parts) {
    const lowerPart = part.toLowerCase();
    if (lowerPart === "mod") {
      result.mod = true;
      continue;
    }

    const modifier = MODIFIER_ALIASES[lowerPart];
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

function serializeStorageKeybinding(input: StorageKeybinding): string {
  return [
    input.ctrl ? "ctrl" : null,
    isMacPlatform() ? null : input.mod ? "mod" : null,
    input.meta ? (isMacPlatform() ? "cmd" : "meta") : null,
    isMacPlatform() ? (input.mod ? "mod" : null) : null,
    input.alt ? "alt" : null,
    input.shift ? "shift" : null,
    input.code,
  ]
    .filter((part): part is string => !!part)
    .join("+");
}

function keyCodeFromEvent(
  event: Pick<KeyboardEvent, "key"> & Partial<Pick<KeyboardEvent, "code">>,
): string {
  if (event.code) {
    if (/^Key[A-Z]$/.test(event.code)) {
      return event.code.slice(3).toLowerCase();
    }
    if (/^Digit[0-9]$/.test(event.code)) {
      return event.code.slice(5);
    }
    const aliased = CODE_KEY_ALIASES[event.code];
    if (aliased) {
      return aliased;
    }
  }

  return canonicalKey(event.key);
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
