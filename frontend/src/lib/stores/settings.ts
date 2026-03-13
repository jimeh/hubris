import { create } from "zustand";
import { getSettings, saveSettings } from "@/lib/api";
import { getEventClient } from "@/lib/events";
import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_TERMINAL_SETTINGS,
  DEFAULT_WORKTREE_SETTINGS,
  defaultSettings,
  type AppearanceSettings,
  type Settings,
  type SettingsPatch,
  type TerminalSettings,
} from "@/lib/settings/types";

type SettingsState = {
  settings: Settings;
  hasServerState: boolean;
  init: () => Promise<void>;
  patchSettings: (patch: SettingsPatch) => Promise<Settings>;
};

function appearanceEqual(
  left: AppearanceSettings,
  right: AppearanceSettings,
): boolean {
  return (
    left.colorScheme === right.colorScheme &&
    left.lightTheme === right.lightTheme &&
    left.darkTheme === right.darkTheme
  );
}

function terminalEqual(
  left: TerminalSettings,
  right: TerminalSettings,
): boolean {
  return (
    left.fontSource === right.fontSource &&
    left.systemFontFamily === right.systemFontFamily &&
    left.bundledFont === right.bundledFont &&
    left.fontSize === right.fontSize
  );
}

function settingsEqual(left: Settings, right: Settings): boolean {
  return (
    appearanceEqual(left.appearance, right.appearance) &&
    terminalEqual(left.terminal, right.terminal) &&
    left.worktree.locationMode === right.worktree.locationMode
  );
}

function materializeSettings(candidate?: Partial<Settings>): Settings {
  return {
    appearance: {
      ...DEFAULT_APPEARANCE_SETTINGS,
      ...candidate?.appearance,
    },
    terminal: {
      ...DEFAULT_TERMINAL_SETTINGS,
      ...candidate?.terminal,
    },
    worktree: {
      ...DEFAULT_WORKTREE_SETTINGS,
      ...candidate?.worktree,
    },
  };
}

function cacheSettings(settings: Settings): void {
  try {
    localStorage.setItem(
      "hubris-appearance",
      JSON.stringify(settings.appearance),
    );
    localStorage.setItem("hubris-terminal", JSON.stringify(settings.terminal));
  } catch {
    // localStorage unavailable
  }
}

function loadFallbackSettings(): Settings {
  const fallback = defaultSettings();

  try {
    const raw = localStorage.getItem("hubris-appearance");
    if (raw) {
      fallback.appearance = {
        ...fallback.appearance,
        ...JSON.parse(raw),
      };
    }
  } catch {
    // Ignore invalid local cache.
  }

  try {
    const raw = localStorage.getItem("hubris-terminal");
    if (raw) {
      fallback.terminal = {
        ...fallback.terminal,
        ...JSON.parse(raw),
      };
    }
  } catch {
    // Ignore invalid local cache.
  }

  return fallback;
}

function applyPatch(current: Settings, patch: SettingsPatch): Settings {
  return {
    appearance: {
      ...current.appearance,
      ...(patch.appearance?.colorScheme === null
        ? { colorScheme: DEFAULT_APPEARANCE_SETTINGS.colorScheme }
        : {}),
      ...(patch.appearance?.lightTheme === null
        ? { lightTheme: DEFAULT_APPEARANCE_SETTINGS.lightTheme }
        : {}),
      ...(patch.appearance?.darkTheme === null
        ? { darkTheme: DEFAULT_APPEARANCE_SETTINGS.darkTheme }
        : {}),
      ...(patch.appearance
        ? Object.fromEntries(
            Object.entries(patch.appearance).filter(
              ([, value]) => value !== null && value !== undefined,
            ),
          )
        : {}),
    },
    terminal: {
      ...current.terminal,
      ...(patch.terminal?.fontSource === null
        ? { fontSource: DEFAULT_TERMINAL_SETTINGS.fontSource }
        : {}),
      ...(patch.terminal?.systemFontFamily === null
        ? { systemFontFamily: DEFAULT_TERMINAL_SETTINGS.systemFontFamily }
        : {}),
      ...(patch.terminal?.bundledFont === null
        ? { bundledFont: DEFAULT_TERMINAL_SETTINGS.bundledFont }
        : {}),
      ...(patch.terminal?.fontSize === null
        ? { fontSize: DEFAULT_TERMINAL_SETTINGS.fontSize }
        : {}),
      ...(patch.terminal
        ? Object.fromEntries(
            Object.entries(patch.terminal).filter(
              ([, value]) => value !== null && value !== undefined,
            ),
          )
        : {}),
    },
    worktree: {
      ...current.worktree,
      ...(patch.worktree?.locationMode === null
        ? { locationMode: DEFAULT_WORKTREE_SETTINGS.locationMode }
        : {}),
      ...(patch.worktree
        ? Object.fromEntries(
            Object.entries(patch.worktree).filter(
              ([, value]) => value !== null && value !== undefined,
            ),
          )
        : {}),
    },
  };
}

function commitSettings(next: Settings, hasServerState: boolean): void {
  const materialized = materializeSettings(next);
  if (hasServerState) {
    cacheSettings(materialized);
  }

  useSettingsStore.setState((state) => {
    const nextHasServerState = state.hasServerState || hasServerState;
    if (
      settingsEqual(state.settings, materialized) &&
      state.hasServerState === nextHasServerState
    ) {
      return state;
    }

    return {
      settings: materialized,
      hasServerState: nextHasServerState,
    };
  });
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: defaultSettings(),
  hasServerState: false,
  async init() {
    try {
      const settings = materializeSettings(await getSettings());
      if (!get().hasServerState) {
        commitSettings(settings, true);
      }
    } catch {
      if (!get().hasServerState) {
        commitSettings(loadFallbackSettings(), false);
      }
    }
  },
  async patchSettings(patch) {
    const previous = get().settings;
    const optimistic = applyPatch(previous, patch);
    if (settingsEqual(previous, optimistic)) {
      return previous;
    }

    set({ settings: optimistic });

    try {
      const saved = materializeSettings(await saveSettings(patch));
      commitSettings(saved, true);
      return saved;
    } catch (error) {
      set((state) =>
        settingsEqual(state.settings, optimistic)
          ? { settings: previous }
          : state,
      );
      throw error;
    }
  },
}));

let initialized = false;
let eventUnsubscribers: Array<() => void> = [];

export function initializeSettingsStore(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  const events = getEventClient();
  eventUnsubscribers = [
    events.on("snapshot", (data) => {
      commitSettings(
        materializeSettings(data.settings as Partial<Settings>),
        true,
      );
    }),
    events.on("settings_updated", (settings) => {
      commitSettings(materializeSettings(settings as Partial<Settings>), true);
    }),
  ];
}

export function resetSettingsStoreForTests(): void {
  for (const unsubscribe of eventUnsubscribers) {
    unsubscribe();
  }
  eventUnsubscribers = [];
  initialized = false;
  useSettingsStore.setState({
    settings: defaultSettings(),
    hasServerState: false,
  });
}
