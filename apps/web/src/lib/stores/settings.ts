import { create } from "zustand";
import {
  applyComputedVars,
  clearTheme,
  computeThemeVars,
  type ComputedThemeVars,
} from "@/lib/theme/convert";
import { builtinThemes } from "@/lib/theme/builtin";
import {
  getEditorTheme,
  getSettings,
  patchSettings,
  resetApiStateForTests,
  type VscodeThemeJson,
} from "@/lib/api";
import { getEventClient } from "@/lib/events";
import {
  showSettingsInvalidFileToast,
  showSettingsSaveFailedToast,
} from "@/lib/stores/toasts";
import { DEFAULT_FONT_FAMILY, resolveFont } from "@/lib/terminal/fonts";
import type {
  AppearanceSettings,
  AppearanceSettingsPatch,
  ChatSettings,
  ChatSettingsPatch,
  EditorSettings,
  EditorSettingsPatch,
  ExperimentalSettings,
  ExperimentalSettingsPatch,
  HubrisTheme,
  Settings,
  SettingsPatch,
  SettingsState,
  SettingsStatus,
  TerminalSettings,
  TerminalSettingsPatch,
  ThemeListEntry,
  VscodeSettings,
  VscodeSettingsPatch,
  WorktreeSettings,
  WorktreeSettingsPatch,
} from "@/lib/theme/types";

const LS_SETTINGS = "hubris-settings";
const COLOR_SCHEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";
const DEFAULT_INPUT_DEBOUNCE_MS = 250;

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
    smartTabNaming: true,
    escapeSequenceTitles: true,
    sendKeybindingsToShell: false,
    clientScrollbackRows: 10000,
    serverScrollbackBytes: 256 * 1024,
  },
  editor: {
    lightEditorTheme: "hubris-light",
    darkEditorTheme: "hubris-dark",
  },
  worktree: {
    locationMode: "dataDir",
  },
  experimental: {
    chatEnabled: false,
  },
  vscode: {
    runtime: "vscodeCli",
  },
  chat: {
    idleTimeoutMinutes: 60,
    uiStyle: "copilotkit",
    copilotkitThemeMode: "hubris",
  },
};

const DEFAULT_SETTINGS_STATUS: SettingsStatus = {
  kind: "ok",
  writesBlocked: false,
  message: null,
};

const builtinsById = new Map(
  builtinThemes.map((theme) => [theme.id, theme] as const),
);

type SettingsUpdateOptions = {
  debounceKey?: string;
  debounceMs?: number;
};

type DebouncedSave = {
  timer: number;
  patch: SettingsPatch;
  revision: number;
};

type SettingsStoreState = {
  settings: Settings;
  generation: string;
  status: SettingsStatus;
  activeTheme: HubrisTheme | null;
  themeVersion: number;
  terminalVersion: number;
  editorThemeData: VscodeThemeJson | null;
  editorThemeVersion: number;
  prefersLight: boolean;
  fontFamily: string;
  updateAppearance: (partial: AppearanceSettingsPatch) => void;
  updateTerminal: (
    partial: TerminalSettingsPatch,
    options?: SettingsUpdateOptions,
  ) => void;
  updateEditor: (partial: EditorSettingsPatch) => void;
  updateWorktree: (partial: WorktreeSettingsPatch) => void;
  updateExperimental: (partial: ExperimentalSettingsPatch) => void;
  updateVscode: (partial: VscodeSettingsPatch) => void;
  updateChat: (
    partial: ChatSettingsPatch,
    options?: SettingsUpdateOptions,
  ) => void;
};

type CachedSettingsState = Pick<SettingsState, "settings" | "generation">;

let initialized = false;
let eventUnsubscribers: Array<() => void> = [];
let mediaListenerBound = false;
let fontLoadGeneration = 0;
let latestLocalRevision = 0;
const debounceEntries = new Map<string, DebouncedSave>();

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
  return !window.matchMedia(COLOR_SCHEME_MEDIA_QUERY).matches;
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

function clampFontSize(size: number): number {
  return Math.max(8, Math.min(32, size));
}

function clampClientScrollbackRows(rows: number): number {
  if (!Number.isFinite(rows)) {
    return DEFAULT_SETTINGS.terminal.clientScrollbackRows;
  }
  return Math.max(500, Math.min(1_000_000, Math.trunc(rows)));
}

function clampServerScrollbackBytes(bytes: number): number {
  if (!Number.isFinite(bytes)) {
    return DEFAULT_SETTINGS.terminal.serverScrollbackBytes;
  }
  return Math.max(10 * 1024, Math.min(16 * 1024 * 1024, Math.trunc(bytes)));
}

function normalizeTerminalSettings(candidate: unknown): {
  settings: TerminalSettings;
  changed: boolean;
} {
  const source = (candidate ?? {}) as Partial<TerminalSettings> & {
    tabLabelMode?: "numbered" | "process" | "title";
  };
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

  const hasLegacyTabLabelMode =
    source.tabLabelMode === "numbered" ||
    source.tabLabelMode === "process" ||
    source.tabLabelMode === "title";

  const smartTabNaming =
    typeof source.smartTabNaming === "boolean"
      ? source.smartTabNaming
      : hasLegacyTabLabelMode
        ? true
        : DEFAULT_SETTINGS.terminal.smartTabNaming;
  if (smartTabNaming !== source.smartTabNaming) {
    changed = true;
  }

  const escapeSequenceTitles =
    typeof source.escapeSequenceTitles === "boolean"
      ? source.escapeSequenceTitles
      : hasLegacyTabLabelMode
        ? true
        : DEFAULT_SETTINGS.terminal.escapeSequenceTitles;
  if (escapeSequenceTitles !== source.escapeSequenceTitles) {
    changed = true;
  }

  const sendKeybindingsToShell =
    typeof source.sendKeybindingsToShell === "boolean"
      ? source.sendKeybindingsToShell
      : DEFAULT_SETTINGS.terminal.sendKeybindingsToShell;
  if (sendKeybindingsToShell !== source.sendKeybindingsToShell) {
    changed = true;
  }

  const clientScrollbackRows = clampClientScrollbackRows(
    typeof source.clientScrollbackRows === "number"
      ? source.clientScrollbackRows
      : DEFAULT_SETTINGS.terminal.clientScrollbackRows,
  );
  if (clientScrollbackRows !== source.clientScrollbackRows) {
    changed = true;
  }

  const serverScrollbackBytes = clampServerScrollbackBytes(
    typeof source.serverScrollbackBytes === "number"
      ? source.serverScrollbackBytes
      : DEFAULT_SETTINGS.terminal.serverScrollbackBytes,
  );
  if (serverScrollbackBytes !== source.serverScrollbackBytes) {
    changed = true;
  }

  return {
    settings: {
      fontSource,
      systemFontFamily,
      bundledFont,
      fontSize,
      smartTabNaming,
      escapeSequenceTitles,
      sendKeybindingsToShell,
      clientScrollbackRows,
      serverScrollbackBytes,
    },
    changed,
  };
}

function normalizeEditorSettings(candidate: unknown): {
  settings: EditorSettings;
  changed: boolean;
} {
  const source = (candidate ?? {}) as Partial<EditorSettings>;
  let changed = false;

  const lightEditorTheme =
    typeof source.lightEditorTheme === "string" && source.lightEditorTheme
      ? source.lightEditorTheme
      : DEFAULT_SETTINGS.editor.lightEditorTheme;
  if (lightEditorTheme !== source.lightEditorTheme) {
    changed = true;
  }

  const darkEditorTheme =
    typeof source.darkEditorTheme === "string" && source.darkEditorTheme
      ? source.darkEditorTheme
      : DEFAULT_SETTINGS.editor.darkEditorTheme;
  if (darkEditorTheme !== source.darkEditorTheme) {
    changed = true;
  }

  return {
    settings: { lightEditorTheme, darkEditorTheme },
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

function normalizeExperimentalSettings(candidate: unknown): {
  settings: ExperimentalSettings;
  changed: boolean;
} {
  const source = (candidate ?? {}) as Partial<ExperimentalSettings>;
  const chatEnabled =
    typeof source.chatEnabled === "boolean"
      ? source.chatEnabled
      : DEFAULT_SETTINGS.experimental.chatEnabled;

  return {
    settings: {
      chatEnabled,
    },
    changed: chatEnabled !== source.chatEnabled,
  };
}

function normalizeVscodeSettings(candidate: unknown): {
  settings: VscodeSettings;
  changed: boolean;
} {
  const source = (candidate ?? {}) as Partial<VscodeSettings>;
  const runtime =
    source.runtime === "codeServer" || source.runtime === "vscodeCli"
      ? source.runtime
      : DEFAULT_SETTINGS.vscode.runtime;

  return {
    settings: { runtime },
    changed: runtime !== source.runtime,
  };
}

function clampChatIdleTimeoutMinutes(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_SETTINGS.chat.idleTimeoutMinutes;
  }
  return Math.max(1, Math.min(120, Math.trunc(value)));
}

function normalizeChatSettings(candidate: unknown): {
  settings: ChatSettings;
  changed: boolean;
} {
  const source = (candidate ?? {}) as Partial<ChatSettings>;
  const idleTimeoutMinutes = clampChatIdleTimeoutMinutes(
    typeof source.idleTimeoutMinutes === "number"
      ? source.idleTimeoutMinutes
      : DEFAULT_SETTINGS.chat.idleTimeoutMinutes,
  );
  const uiStyle =
    source.uiStyle === "classic" || source.uiStyle === "copilotkit"
      ? source.uiStyle
      : DEFAULT_SETTINGS.chat.uiStyle;
  const copilotkitThemeMode =
    source.copilotkitThemeMode === "hubris" ||
    source.copilotkitThemeMode === "stock"
      ? source.copilotkitThemeMode
      : DEFAULT_SETTINGS.chat.copilotkitThemeMode;

  return {
    settings: { idleTimeoutMinutes, uiStyle, copilotkitThemeMode },
    changed:
      idleTimeoutMinutes !== source.idleTimeoutMinutes ||
      uiStyle !== source.uiStyle ||
      copilotkitThemeMode !== source.copilotkitThemeMode,
  };
}

function normalizeSettings(candidate: unknown): {
  settings: Settings;
  changed: boolean;
} {
  const source = (candidate ?? {}) as Partial<Settings>;
  const appearance = normalizeAppearanceSettings(source.appearance);
  const terminal = normalizeTerminalSettings(source.terminal);
  const editor = normalizeEditorSettings(source.editor);
  const worktree = normalizeWorktreeSettings(source.worktree);
  const experimental = normalizeExperimentalSettings(source.experimental);
  const vscode = normalizeVscodeSettings(source.vscode);
  const chat = normalizeChatSettings(source.chat);

  return {
    settings: {
      appearance: appearance.settings,
      terminal: terminal.settings,
      editor: editor.settings,
      worktree: worktree.settings,
      experimental: experimental.settings,
      vscode: vscode.settings,
      chat: chat.settings,
    },
    changed:
      appearance.changed ||
      terminal.changed ||
      editor.changed ||
      worktree.changed ||
      experimental.changed ||
      vscode.changed ||
      chat.changed,
  };
}

function normalizeSettingsStatus(candidate: unknown): SettingsStatus {
  const source = (candidate ?? {}) as Partial<SettingsStatus>;
  const kind = source.kind === "invalidFile" ? "invalidFile" : "ok";

  return {
    kind,
    writesBlocked:
      typeof source.writesBlocked === "boolean"
        ? source.writesBlocked
        : kind === "invalidFile",
    message: typeof source.message === "string" ? source.message : null,
  };
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

function syncActiveTheme(
  theme: HubrisTheme,
  settings: AppearanceSettings,
): void {
  clearTheme();
  applyComputedVars(computeThemeVars(theme));
  cacheThemeVars(settings);
}

/**
 * Parses a generation string into a bigint, falling back to `0n` if parsing
 * fails. This is ambiguous with a legitimate `"0"` generation; a future
 * cleanup could instead return `null`/`undefined` or throw so callers can
 * distinguish malformed generations from a real zero value.
 */
function parseGeneration(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function compareGeneration(left: string, right: string): number {
  const leftValue = parseGeneration(left);
  const rightValue = parseGeneration(right);
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

function stripEmptyPatch(patch: SettingsPatch): SettingsPatch {
  const next: SettingsPatch = {};

  if (patch.appearance && Object.keys(patch.appearance).length > 0) {
    next.appearance = patch.appearance;
  }
  if (patch.terminal && Object.keys(patch.terminal).length > 0) {
    next.terminal = patch.terminal;
  }
  if (patch.editor && Object.keys(patch.editor).length > 0) {
    next.editor = patch.editor;
  }
  if (patch.worktree && Object.keys(patch.worktree).length > 0) {
    next.worktree = patch.worktree;
  }
  if (patch.experimental && Object.keys(patch.experimental).length > 0) {
    next.experimental = patch.experimental;
  }
  if (patch.vscode && Object.keys(patch.vscode).length > 0) {
    next.vscode = patch.vscode;
  }
  if (patch.chat && Object.keys(patch.chat).length > 0) {
    next.chat = patch.chat;
  }

  return next;
}

function hasPatch(patch: SettingsPatch | null | undefined): boolean {
  if (!patch) return false;
  const stripped = stripEmptyPatch(patch);
  return (
    stripped.appearance !== undefined ||
    stripped.terminal !== undefined ||
    stripped.editor !== undefined ||
    stripped.worktree !== undefined ||
    stripped.experimental !== undefined ||
    stripped.vscode !== undefined ||
    stripped.chat !== undefined
  );
}

function getErrorStatus(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }
  return null;
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
    editor: {
      ...settings.editor,
      ...(patch.editor ?? {}),
    },
    worktree: {
      ...settings.worktree,
      ...(patch.worktree ?? {}),
    },
    experimental: {
      ...settings.experimental,
      ...(patch.experimental ?? {}),
    },
    vscode: {
      ...settings.vscode,
      ...(patch.vscode ?? {}),
    },
    chat: {
      ...settings.chat,
      ...(patch.chat ?? {}),
    },
  };
  return normalizeSettings(next).settings;
}

function cacheCanonicalSettings(state: SettingsState): void {
  try {
    const cached: CachedSettingsState = {
      settings: normalizeSettings(state.settings).settings,
      generation: state.generation,
    };
    localStorage.setItem(LS_SETTINGS, JSON.stringify(cached));
  } catch {
    // localStorage unavailable.
  }
}

function readCachedSettingsState(): CachedSettingsState | null {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<CachedSettingsState>;
    return {
      settings: normalizeSettings(parsed.settings).settings,
      generation:
        typeof parsed.generation === "string" ? parsed.generation : "0",
    };
  } catch {
    return null;
  }
}

function clearDebounceTimer(key: string): void {
  const entry = debounceEntries.get(key);
  if (!entry) {
    return;
  }
  window.clearTimeout(entry.timer);
  debounceEntries.delete(key);
}

function clearAllDebounceTimers(): void {
  for (const entry of debounceEntries.values()) {
    window.clearTimeout(entry.timer);
  }
  debounceEntries.clear();
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

const LS_EDITOR_THEME_CACHE = "hubris-editor-theme-cache";
let editorThemeFetchGeneration = 0;

function getActiveEditorThemeId(
  appearance: AppearanceSettings,
  editor: EditorSettings,
  prefersLight: boolean,
): string {
  const wantLight =
    appearance.colorScheme === "light" ||
    (appearance.colorScheme === "auto" && prefersLight);
  return wantLight ? editor.lightEditorTheme : editor.darkEditorTheme;
}

function cacheEditorThemeData(id: string, data: VscodeThemeJson): void {
  try {
    localStorage.setItem(LS_EDITOR_THEME_CACHE, JSON.stringify({ id, data }));
  } catch {
    // localStorage full or unavailable.
  }
}

function readCachedEditorThemeData(id: string): VscodeThemeJson | null {
  try {
    const raw = localStorage.getItem(LS_EDITOR_THEME_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      id?: string;
      data?: VscodeThemeJson;
    };
    if (parsed.id === id && parsed.data) {
      return parsed.data;
    }
    return null;
  } catch {
    return null;
  }
}

function fetchEditorThemeData(themeId: string): void {
  editorThemeFetchGeneration += 1;
  const requestId = editorThemeFetchGeneration;

  // Try cache first for instant display.
  const cached = readCachedEditorThemeData(themeId);
  if (cached) {
    useSettingsStore.setState((state) => ({
      editorThemeData: cached,
      editorThemeVersion: state.editorThemeVersion + 1,
    }));
  }

  void getEditorTheme(themeId).then(
    (data) => {
      if (requestId !== editorThemeFetchGeneration) return;
      cacheEditorThemeData(themeId, data);
      useSettingsStore.setState((state) => ({
        editorThemeData: data,
        editorThemeVersion: state.editorThemeVersion + 1,
      }));
    },
    () => {
      // Keep cached/null data on fetch failure.
    },
  );
}

function equalAppearanceSettings(
  left: AppearanceSettings,
  right: AppearanceSettings,
): boolean {
  return (
    left.colorScheme === right.colorScheme &&
    left.lightTheme === right.lightTheme &&
    left.darkTheme === right.darkTheme
  );
}

function equalTerminalSettings(
  left: TerminalSettings,
  right: TerminalSettings,
): boolean {
  return (
    left.fontSource === right.fontSource &&
    left.systemFontFamily === right.systemFontFamily &&
    left.bundledFont === right.bundledFont &&
    left.fontSize === right.fontSize &&
    left.smartTabNaming === right.smartTabNaming &&
    left.escapeSequenceTitles === right.escapeSequenceTitles &&
    left.sendKeybindingsToShell === right.sendKeybindingsToShell &&
    left.clientScrollbackRows === right.clientScrollbackRows &&
    left.serverScrollbackBytes === right.serverScrollbackBytes
  );
}

function equalEditorSettings(
  left: EditorSettings,
  right: EditorSettings,
): boolean {
  return (
    left.lightEditorTheme === right.lightEditorTheme &&
    left.darkEditorTheme === right.darkEditorTheme
  );
}

function equalWorktreeSettings(
  left: WorktreeSettings,
  right: WorktreeSettings,
): boolean {
  return left.locationMode === right.locationMode;
}

function equalExperimentalSettings(
  left: ExperimentalSettings,
  right: ExperimentalSettings,
): boolean {
  return left.chatEnabled === right.chatEnabled;
}

function equalVscodeSettings(
  left: VscodeSettings,
  right: VscodeSettings,
): boolean {
  return left.runtime === right.runtime;
}

function equalChatSettings(left: ChatSettings, right: ChatSettings): boolean {
  return (
    left.idleTimeoutMinutes === right.idleTimeoutMinutes &&
    left.uiStyle === right.uiStyle &&
    left.copilotkitThemeMode === right.copilotkitThemeMode
  );
}

function stabilizeSettingsSections(
  current: Settings,
  next: Settings,
): Settings {
  const appearance = equalAppearanceSettings(
    current.appearance,
    next.appearance,
  )
    ? current.appearance
    : next.appearance;
  const terminal = equalTerminalSettings(current.terminal, next.terminal)
    ? current.terminal
    : next.terminal;
  const editor = equalEditorSettings(current.editor, next.editor)
    ? current.editor
    : next.editor;
  const worktree = equalWorktreeSettings(current.worktree, next.worktree)
    ? current.worktree
    : next.worktree;
  const experimental = equalExperimentalSettings(
    current.experimental,
    next.experimental,
  )
    ? current.experimental
    : next.experimental;
  const vscode = equalVscodeSettings(current.vscode, next.vscode)
    ? current.vscode
    : next.vscode;
  const chat = equalChatSettings(current.chat, next.chat)
    ? current.chat
    : next.chat;

  if (
    appearance === current.appearance &&
    terminal === current.terminal &&
    editor === current.editor &&
    worktree === current.worktree &&
    experimental === current.experimental &&
    vscode === current.vscode &&
    chat === current.chat
  ) {
    return current;
  }

  return {
    appearance,
    terminal,
    editor,
    worktree,
    experimental,
    vscode,
    chat,
  };
}

function commitSettings(
  settings: Settings,
  generation: string,
  status: SettingsStatus,
): void {
  const normalized = normalizeSettings(settings).settings;
  let nextSettings = normalized;
  let nextTheme: HubrisTheme | null = null;
  let prefersLight = true;
  let shouldSyncTheme = false;
  let shouldResolveFont = false;
  let shouldFetchEditorTheme = false;

  useSettingsStore.setState((state) => ({
    settings: (() => {
      nextSettings = stabilizeSettingsSections(state.settings, normalized);
      return nextSettings;
    })(),
    generation,
    status,
    activeTheme: (() => {
      prefersLight = state.prefersLight;
      shouldSyncTheme =
        state.activeTheme === null ||
        nextSettings.appearance !== state.settings.appearance;
      nextTheme = shouldSyncTheme
        ? getActiveTheme(nextSettings.appearance, prefersLight)
        : state.activeTheme;
      shouldResolveFont = nextSettings.terminal !== state.settings.terminal;
      shouldFetchEditorTheme =
        state.editorThemeData === null ||
        nextSettings.editor !== state.settings.editor ||
        nextSettings.appearance !== state.settings.appearance;
      return nextTheme;
    })(),
    themeVersion:
      state.themeVersion +
      (nextSettings.appearance !== state.settings.appearance ? 1 : 0),
    terminalVersion:
      state.terminalVersion +
      (nextSettings.terminal !== state.settings.terminal ? 1 : 0),
  }));

  if (shouldSyncTheme && nextTheme) {
    syncActiveTheme(nextTheme, nextSettings.appearance);
  }
  if (shouldResolveFont) {
    updateResolvedFont(nextSettings.terminal);
  }
  if (shouldFetchEditorTheme) {
    fetchEditorThemeData(
      getActiveEditorThemeId(
        nextSettings.appearance,
        nextSettings.editor,
        prefersLight,
      ),
    );
  }
}

function applyServerState(
  serverState: SettingsState,
  source: "response" | "canonical",
): boolean {
  const current = useSettingsStore.getState();
  const comparison = compareGeneration(
    serverState.generation,
    current.generation,
  );

  if (comparison < 0) {
    return false;
  }
  if (source === "response" && comparison === 0) {
    return false;
  }

  const normalizedSettings = normalizeSettings(serverState.settings).settings;
  const normalizedStatus = normalizeSettingsStatus(serverState.status);

  clearAllDebounceTimers();
  cacheCanonicalSettings({
    settings: normalizedSettings,
    generation: serverState.generation,
    status: normalizedStatus,
  });
  commitSettings(normalizedSettings, serverState.generation, normalizedStatus);
  return true;
}

async function refetchCanonicalState(): Promise<void> {
  try {
    const nextState = await getSettings();
    applyServerState(nextState, "canonical");
  } catch {
    // Keep the current UI state if the fallback read fails too.
  }
}

function sendPatchRequest(patch: SettingsPatch, revision: number): void {
  if (!hasPatch(patch)) {
    return;
  }

  void (async () => {
    try {
      const nextState = await patchSettings(patch);
      applyServerState(nextState, "response");
    } catch (error) {
      if (revision !== latestLocalRevision) {
        return;
      }

      if (getErrorStatus(error) === 409) {
        showSettingsInvalidFileToast();
      } else {
        showSettingsSaveFailedToast();
      }
      await refetchCanonicalState();
    }
  })();
}

function scheduleDebouncedSave(
  patch: SettingsPatch,
  revision: number,
  options: SettingsUpdateOptions,
): void {
  const debounceKey = options.debounceKey;
  if (!debounceKey) {
    return;
  }

  clearDebounceTimer(debounceKey);
  const delay = options.debounceMs ?? DEFAULT_INPUT_DEBOUNCE_MS;
  const timer = window.setTimeout(() => {
    const entry = debounceEntries.get(debounceKey);
    if (!entry) {
      return;
    }
    debounceEntries.delete(debounceKey);
    sendPatchRequest(entry.patch, entry.revision);
  }, delay);

  debounceEntries.set(debounceKey, {
    timer,
    patch,
    revision,
  });
}

function applyOptimisticPatch(
  patch: SettingsPatch,
  options: SettingsUpdateOptions = {},
): void {
  const current = useSettingsStore.getState();
  if (current.status.writesBlocked) {
    return;
  }

  latestLocalRevision += 1;
  const revision = latestLocalRevision;

  commitSettings(
    applyPatchToSettings(current.settings, patch),
    current.generation,
    current.status,
  );

  if (options.debounceKey) {
    scheduleDebouncedSave(patch, revision, options);
    return;
  }

  sendPatchRequest(patch, revision);
}

function handleSystemColorSchemeChange(event: MediaQueryListEvent): void {
  let appearance: AppearanceSettings | null = null;
  let activeTheme: HubrisTheme | null = null;
  let editorSettings: EditorSettings | null = null;
  const prefersLight = !event.matches;
  useSettingsStore.setState((state) => {
    appearance = state.settings.appearance;
    editorSettings = state.settings.editor;
    activeTheme = getActiveTheme(state.settings.appearance, prefersLight);
    return {
      prefersLight,
      activeTheme,
      themeVersion: state.themeVersion + 1,
    };
  });
  if (appearance && activeTheme) {
    syncActiveTheme(activeTheme, appearance);
  }
  if (appearance && editorSettings) {
    fetchEditorThemeData(
      getActiveEditorThemeId(appearance, editorSettings, prefersLight),
    );
  }
}

function bindMediaListener(): void {
  if (mediaListenerBound || typeof window === "undefined") {
    return;
  }
  mediaListenerBound = true;

  const media = window.matchMedia(COLOR_SCHEME_MEDIA_QUERY);

  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", handleSystemColorSchemeChange);
  } else {
    media.addListener(handleSystemColorSchemeChange);
  }
}

export const useSettingsStore = create<SettingsStoreState>(() => ({
  settings: DEFAULT_SETTINGS,
  generation: "0",
  status: DEFAULT_SETTINGS_STATUS,
  activeTheme: null,
  themeVersion: 0,
  terminalVersion: 0,
  editorThemeData: null,
  editorThemeVersion: 0,
  prefersLight: readPrefersLight(),
  fontFamily: DEFAULT_FONT_FAMILY,
  updateAppearance(partial) {
    applyOptimisticPatch({ appearance: partial });
  },
  updateTerminal(partial, options) {
    applyOptimisticPatch({ terminal: partial }, options);
  },
  updateEditor(partial) {
    applyOptimisticPatch({ editor: partial });
  },
  updateWorktree(partial) {
    applyOptimisticPatch({ worktree: partial });
  },
  updateExperimental(partial) {
    applyOptimisticPatch({ experimental: partial });
  },
  updateVscode(partial) {
    applyOptimisticPatch({ vscode: partial });
  },
  updateChat(partial, options) {
    applyOptimisticPatch({ chat: partial }, options);
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
    commitSettings(cached.settings, cached.generation, DEFAULT_SETTINGS_STATUS);
  } else {
    commitSettings(DEFAULT_SETTINGS, "0", DEFAULT_SETTINGS_STATUS);
  }

  const events = getEventClient();
  eventUnsubscribers = [
    events.on("snapshot", (data) => {
      applyServerState(
        {
          settings: data.settings,
          generation: data.settings_generation,
          status: data.settings_status,
        },
        "canonical",
      );
    }),
    events.on("settings_updated", (data) => {
      applyServerState(data, "canonical");
    }),
  ];
}

export function resetSettingsStoreForTests(): void {
  clearAllDebounceTimers();
  fontLoadGeneration = 0;
  latestLocalRevision = 0;
  resetApiStateForTests();

  for (const unsubscribe of eventUnsubscribers) {
    unsubscribe();
  }
  eventUnsubscribers = [];
  initialized = false;

  if (
    mediaListenerBound &&
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
  ) {
    const media = window.matchMedia(COLOR_SCHEME_MEDIA_QUERY);
    if (typeof media.removeEventListener === "function") {
      media.removeEventListener("change", handleSystemColorSchemeChange);
    } else {
      media.removeListener(handleSystemColorSchemeChange);
    }
  }
  mediaListenerBound = false;

  editorThemeFetchGeneration = 0;

  useSettingsStore.setState({
    settings: DEFAULT_SETTINGS,
    generation: "0",
    status: DEFAULT_SETTINGS_STATUS,
    activeTheme: null,
    themeVersion: 0,
    terminalVersion: 0,
    editorThemeData: null,
    editorThemeVersion: 0,
    prefersLight: readPrefersLight(),
    fontFamily: DEFAULT_FONT_FAMILY,
  });
}

export function themeEntries(): ThemeListEntry[] {
  return allThemeEntries();
}

export type { SettingsUpdateOptions };
