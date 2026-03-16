import { create } from "zustand";
import {
  applyComputedVars,
  clearTheme,
  computeThemeVars,
  type ComputedThemeVars,
} from "@/lib/theme/convert";
import { builtinThemes } from "@/lib/theme/builtin";
import { getSettings, patchSettings, resetApiStateForTests } from "@/lib/api";
import { getEventClient } from "@/lib/events";
import { DEFAULT_FONT_FAMILY, resolveFont } from "@/lib/terminal/fonts";
import type {
  AppearanceSettings,
  AppearanceSettingsPatch,
  HubrisTheme,
  Settings,
  SettingsPatch,
  SettingsState,
  TerminalSettings,
  TerminalSettingsPatch,
  ThemeListEntry,
  WorktreeSettings,
  WorktreeSettingsPatch,
} from "@/lib/theme/types";

const LS_SETTINGS = "hubris-settings";
const LS_APPEARANCE_LEGACY = "hubris-appearance";
const LS_TERMINAL_LEGACY = "hubris-terminal";

const DEFAULT_SETTINGS: Settings = {
  appearance: {
    colorScheme: "auto",
    lightTheme: "hubris-light",
    darkTheme: "hubris-dark",
  },
  terminal: {
    fontSource: "default",
    systemFontFamily: "",
    bundledFont: "jetbrainsmono-nf",
    fontSize: 14,
  },
  worktree: {
    locationMode: "dataDir",
  },
};

const builtinsById = new Map(
  builtinThemes.map((theme) => [theme.id, theme] as const),
);

type SettingsStoreState = {
  settings: Settings;
  generation: string;
  activeTheme: HubrisTheme | null;
  themeVersion: number;
  terminalVersion: number;
  prefersLight: boolean;
  fontFamily: string;
  updateAppearance: (partial: AppearanceSettingsPatch) => void;
  updateTerminal: (partial: TerminalSettingsPatch) => void;
  updateWorktree: (partial: WorktreeSettingsPatch) => void;
};

let initialized = false;
let eventUnsubscribers: Array<() => void> = [];
let mediaListenerBound = false;
let flushTimer: number | null = null;
let pendingPatch: SettingsPatch = {};
let inFlightPatch: SettingsPatch | null = null;
let fontLoadGeneration = 0;

function allThemeEntries(): ThemeListEntry[] {
  return [...builtinThemes];
}

function resolveThemeSync(id: string): HubrisTheme | undefined {
  return builtinsById.get(id);
}

function readPrefersLight(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return true;
  }
  return !window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function normalizeAppearanceSettings(candidate: unknown): {
  settings: AppearanceSettings;
  changed: boolean;
} {
  const source = (candidate ?? {}) as Partial<AppearanceSettings>;
  let changed = false;

  const colorScheme =
    source.colorScheme === "auto" ||
    source.colorScheme === "light" ||
    source.colorScheme === "dark"
      ? source.colorScheme
      : DEFAULT_SETTINGS.appearance.colorScheme;
  if (colorScheme !== source.colorScheme) {
    changed = true;
  }

  const lightTheme =
    typeof source.lightTheme === "string" &&
    resolveThemeSync(source.lightTheme)?.type === "light"
      ? source.lightTheme
      : DEFAULT_SETTINGS.appearance.lightTheme;
  if (lightTheme !== source.lightTheme) {
    changed = true;
  }

  const darkTheme =
    typeof source.darkTheme === "string" &&
    resolveThemeSync(source.darkTheme)?.type === "dark"
      ? source.darkTheme
      : DEFAULT_SETTINGS.appearance.darkTheme;
  if (darkTheme !== source.darkTheme) {
    changed = true;
  }

  return {
    settings: {
      colorScheme,
      lightTheme,
      darkTheme,
    },
    changed,
  };
}

function normalizeTerminalSettings(candidate: unknown): {
  settings: TerminalSettings;
  changed: boolean;
} {
  const source = (candidate ?? {}) as Partial<TerminalSettings>;
  let changed = false;

  const fontSource =
    source.fontSource === "default" ||
    source.fontSource === "system" ||
    source.fontSource === "bundled"
      ? source.fontSource
      : DEFAULT_SETTINGS.terminal.fontSource;
  if (fontSource !== source.fontSource) {
    changed = true;
  }

  const systemFontFamily =
    typeof source.systemFontFamily === "string"
      ? source.systemFontFamily
      : DEFAULT_SETTINGS.terminal.systemFontFamily;
  if (systemFontFamily !== source.systemFontFamily) {
    changed = true;
  }

  const bundledFont =
    typeof source.bundledFont === "string" && source.bundledFont
      ? source.bundledFont
      : DEFAULT_SETTINGS.terminal.bundledFont;
  if (bundledFont !== source.bundledFont) {
    changed = true;
  }

  const fontSize = clampFontSize(
    typeof source.fontSize === "number"
      ? source.fontSize
      : DEFAULT_SETTINGS.terminal.fontSize,
  );
  if (fontSize !== source.fontSize) {
    changed = true;
  }

  return {
    settings: {
      fontSource,
      systemFontFamily,
      bundledFont,
      fontSize,
    },
    changed,
  };
}

function normalizeWorktreeSettings(candidate: unknown): {
  settings: WorktreeSettings;
  changed: boolean;
} {
  const source = (candidate ?? {}) as Partial<WorktreeSettings>;
  const locationMode =
    source.locationMode === "dataDir" ||
    source.locationMode === "repoLocalDotHubris"
      ? source.locationMode
      : DEFAULT_SETTINGS.worktree.locationMode;
  return {
    settings: {
      locationMode,
    },
    changed: locationMode !== source.locationMode,
  };
}

function normalizeSettings(candidate: unknown): {
  settings: Settings;
  changed: boolean;
} {
  const source = (candidate ?? {}) as Partial<Settings>;
  const appearance = normalizeAppearanceSettings(source.appearance);
  const terminal = normalizeTerminalSettings(source.terminal);
  const worktree = normalizeWorktreeSettings(source.worktree);

  return {
    settings: {
      appearance: appearance.settings,
      terminal: terminal.settings,
      worktree: worktree.settings,
    },
    changed: appearance.changed || terminal.changed || worktree.changed,
  };
}

function clampFontSize(size: number): number {
  return Math.max(8, Math.min(32, size));
}

function getActiveTheme(
  settings: AppearanceSettings,
  prefersLight: boolean,
): HubrisTheme {
  const wantLight =
    settings.colorScheme === "light" ||
    (settings.colorScheme === "auto" && prefersLight);
  const id = wantLight ? settings.lightTheme : settings.darkTheme;
  return (
    resolveThemeSync(id) ??
    resolveThemeSync(
      wantLight
        ? DEFAULT_SETTINGS.appearance.lightTheme
        : DEFAULT_SETTINGS.appearance.darkTheme,
    )!
  );
}

function cacheThemeVars(settings: AppearanceSettings): void {
  try {
    const cache: Record<string, ComputedThemeVars> = {};

    if (settings.colorScheme === "auto" || settings.colorScheme === "light") {
      cache.light = computeThemeVars(
        resolveThemeSync(settings.lightTheme) ??
          builtinThemes.find(
            (theme) => theme.id === DEFAULT_SETTINGS.appearance.lightTheme,
          )!,
      );
    }

    if (settings.colorScheme === "auto" || settings.colorScheme === "dark") {
      cache.dark = computeThemeVars(
        resolveThemeSync(settings.darkTheme) ??
          builtinThemes.find(
            (theme) => theme.id === DEFAULT_SETTINGS.appearance.darkTheme,
          )!,
      );
    }

    localStorage.setItem("hubris-theme-cache", JSON.stringify(cache));
  } catch {
    // localStorage full or unavailable.
  }
}

function applyActiveTheme(
  settings: AppearanceSettings,
  prefersLight: boolean,
): HubrisTheme {
  clearTheme();
  const theme = getActiveTheme(settings, prefersLight);
  applyComputedVars(computeThemeVars(theme));
  cacheThemeVars(settings);
  return theme;
}

function compareGeneration(left: string, right: string): number {
  const leftValue = parseGeneration(left);
  const rightValue = parseGeneration(right);
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

function parseGeneration(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function mergeSettingsPatch(
  base: SettingsPatch,
  next: SettingsPatch,
): SettingsPatch {
  const merged: SettingsPatch = {
    appearance: base.appearance ? { ...base.appearance } : undefined,
    terminal: base.terminal ? { ...base.terminal } : undefined,
    worktree: base.worktree ? { ...base.worktree } : undefined,
  };

  if (next.appearance) {
    merged.appearance = {
      ...(merged.appearance ?? {}),
      ...next.appearance,
    };
  }

  if (next.terminal) {
    merged.terminal = {
      ...(merged.terminal ?? {}),
      ...next.terminal,
    };
  }

  if (next.worktree) {
    merged.worktree = {
      ...(merged.worktree ?? {}),
      ...next.worktree,
    };
  }

  return stripEmptyPatch(merged);
}

function stripEmptyPatch(patch: SettingsPatch): SettingsPatch {
  const next: SettingsPatch = {};

  if (patch.appearance && Object.keys(patch.appearance).length > 0) {
    next.appearance = patch.appearance;
  }
  if (patch.terminal && Object.keys(patch.terminal).length > 0) {
    next.terminal = patch.terminal;
  }
  if (patch.worktree && Object.keys(patch.worktree).length > 0) {
    next.worktree = patch.worktree;
  }

  return next;
}

function hasPatch(patch: SettingsPatch | null | undefined): boolean {
  if (!patch) return false;
  return (
    stripEmptyPatch(patch).appearance !== undefined ||
    stripEmptyPatch(patch).terminal !== undefined ||
    stripEmptyPatch(patch).worktree !== undefined
  );
}

function applyPatchToSettings(
  settings: Settings,
  patch: SettingsPatch,
): Settings {
  const next: Settings = {
    appearance: {
      ...settings.appearance,
      ...(patch.appearance ?? {}),
    },
    terminal: {
      ...settings.terminal,
      ...(patch.terminal ?? {}),
    },
    worktree: {
      ...settings.worktree,
      ...(patch.worktree ?? {}),
    },
  };
  return normalizeSettings(next).settings;
}

function cacheCanonicalSettings(state: SettingsState): void {
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(state));
  } catch {
    // localStorage unavailable.
  }
}

function readLegacyCache(): SettingsState | null {
  try {
    const appearance = localStorage.getItem(LS_APPEARANCE_LEGACY);
    const terminal = localStorage.getItem(LS_TERMINAL_LEGACY);
    if (!appearance && !terminal) {
      return null;
    }

    return {
      settings: normalizeSettings({
        appearance: appearance ? JSON.parse(appearance) : undefined,
        terminal: terminal ? JSON.parse(terminal) : undefined,
      }).settings,
      generation: "0",
    };
  } catch {
    return null;
  }
}

function readCachedSettingsState(): SettingsState | null {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (!raw) {
      return readLegacyCache();
    }

    const parsed = JSON.parse(raw) as Partial<SettingsState>;
    return {
      settings: normalizeSettings(parsed.settings).settings,
      generation:
        typeof parsed.generation === "string" ? parsed.generation : "0",
    };
  } catch {
    return readLegacyCache();
  }
}

function scheduleFlush(delay = 250): void {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
  }
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushPendingPatch();
  }, delay);
}

function clearFlushTimer(): void {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function updateResolvedFont(settings: TerminalSettings): void {
  fontLoadGeneration += 1;
  const requestId = fontLoadGeneration;
  void resolveFont(settings).then((fontFamily) => {
    if (requestId !== fontLoadGeneration) {
      return;
    }

    useSettingsStore.setState((state) => {
      if (
        state.settings.terminal.fontSource !== settings.fontSource ||
        state.settings.terminal.systemFontFamily !==
          settings.systemFontFamily ||
        state.settings.terminal.bundledFont !== settings.bundledFont
      ) {
        return state;
      }
      if (state.fontFamily === fontFamily) {
        return state;
      }
      return {
        fontFamily,
        terminalVersion: state.terminalVersion + 1,
      };
    });
  });
}

function commitSettings(settings: Settings, generation: string): void {
  const normalized = normalizeSettings(settings).settings;
  const prefersLight = useSettingsStore.getState().prefersLight;
  const nextTheme = applyActiveTheme(normalized.appearance, prefersLight);

  useSettingsStore.setState((state) => ({
    settings: normalized,
    generation,
    activeTheme: nextTheme,
    themeVersion:
      state.themeVersion +
      (state.settings.appearance.colorScheme !==
        normalized.appearance.colorScheme ||
      state.settings.appearance.lightTheme !==
        normalized.appearance.lightTheme ||
      state.settings.appearance.darkTheme !== normalized.appearance.darkTheme
        ? 1
        : 0),
    terminalVersion:
      state.terminalVersion +
      (state.settings.terminal.fontSource !== normalized.terminal.fontSource ||
      state.settings.terminal.systemFontFamily !==
        normalized.terminal.systemFontFamily ||
      state.settings.terminal.bundledFont !== normalized.terminal.bundledFont ||
      state.settings.terminal.fontSize !== normalized.terminal.fontSize
        ? 1
        : 0),
  }));

  updateResolvedFont(normalized.terminal);
}

function applyCanonicalState(
  serverState: SettingsState,
  allowOlder = false,
): void {
  const current = useSettingsStore.getState();
  if (
    !allowOlder &&
    compareGeneration(serverState.generation, current.generation) < 0
  ) {
    return;
  }

  cacheCanonicalSettings(serverState);
  const unsynced = mergeSettingsPatch(inFlightPatch ?? {}, pendingPatch);
  const settings = hasPatch(unsynced)
    ? applyPatchToSettings(serverState.settings, unsynced)
    : serverState.settings;
  commitSettings(settings, serverState.generation);
}

async function flushPendingPatch(): Promise<void> {
  if (inFlightPatch || !hasPatch(pendingPatch)) {
    return;
  }

  const patch = pendingPatch;
  pendingPatch = {};
  inFlightPatch = patch;

  try {
    const nextState = await patchSettings(patch);
    inFlightPatch = null;
    applyCanonicalState(nextState);
  } catch {
    inFlightPatch = null;
    pendingPatch = {};

    try {
      const current = await getSettings();
      applyCanonicalState(current, true);
    } catch {
      // Keep optimistic state if refetch also fails.
    }
  } finally {
    if (hasPatch(pendingPatch)) {
      scheduleFlush(0);
    }
  }
}

function applyLocalPatch(patch: SettingsPatch): void {
  pendingPatch = mergeSettingsPatch(pendingPatch, patch);
  const current = useSettingsStore.getState();
  commitSettings(
    applyPatchToSettings(current.settings, patch),
    current.generation,
  );
  scheduleFlush();
}

function bindMediaListener(): void {
  if (mediaListenerBound || typeof window === "undefined") {
    return;
  }
  mediaListenerBound = true;

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = (event: MediaQueryListEvent) => {
    useSettingsStore.setState((state) => {
      const prefersLight = !event.matches;
      const activeTheme = applyActiveTheme(
        state.settings.appearance,
        prefersLight,
      );
      return {
        prefersLight,
        activeTheme,
        themeVersion: state.themeVersion + 1,
      };
    });
  };

  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", onChange);
  } else {
    media.addListener(onChange);
  }
}

export const useSettingsStore = create<SettingsStoreState>(() => ({
  settings: DEFAULT_SETTINGS,
  generation: "0",
  activeTheme: null,
  themeVersion: 0,
  terminalVersion: 0,
  prefersLight: readPrefersLight(),
  fontFamily: DEFAULT_FONT_FAMILY,
  updateAppearance(partial) {
    applyLocalPatch({ appearance: partial });
  },
  updateTerminal(partial) {
    applyLocalPatch({ terminal: partial });
  },
  updateWorktree(partial) {
    applyLocalPatch({ worktree: partial });
  },
}));

export function initializeSettingsStore(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  bindMediaListener();
  const cached = readCachedSettingsState();
  if (cached) {
    applyCanonicalState(cached, true);
  } else {
    commitSettings(DEFAULT_SETTINGS, "0");
  }

  const events = getEventClient();
  eventUnsubscribers = [
    events.on("snapshot", (data) => {
      applyCanonicalState(
        {
          settings: data.settings,
          generation: data.settings_generation,
        },
        false,
      );
    }),
    events.on("settings_updated", (data) => {
      applyCanonicalState(data, false);
    }),
  ];
}

export function resetSettingsStoreForTests(): void {
  clearFlushTimer();
  pendingPatch = {};
  inFlightPatch = null;
  fontLoadGeneration = 0;
  resetApiStateForTests();

  for (const unsubscribe of eventUnsubscribers) {
    unsubscribe();
  }
  eventUnsubscribers = [];
  initialized = false;

  useSettingsStore.setState({
    settings: DEFAULT_SETTINGS,
    generation: "0",
    activeTheme: null,
    themeVersion: 0,
    terminalVersion: 0,
    prefersLight: readPrefersLight(),
    fontFamily: DEFAULT_FONT_FAMILY,
  });
}

export function themeEntries(): ThemeListEntry[] {
  return allThemeEntries();
}
