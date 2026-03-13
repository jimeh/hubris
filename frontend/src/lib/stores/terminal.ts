import { create } from "zustand";
import { useSettingsStore } from "@/lib/stores/settings";
import { DEFAULT_FONT_FAMILY, resolveFont } from "@/lib/terminal/fonts";
import {
  DEFAULT_TERMINAL_SETTINGS,
  type TerminalSettings,
} from "@/lib/settings/types";

const DEFAULTS: TerminalSettings = { ...DEFAULT_TERMINAL_SETTINGS };

type TerminalState = {
  settings: TerminalSettings;
  fontFamily: string;
  version: number;
  init: () => Promise<void>;
  updateSettings: (partial: Partial<TerminalSettings>) => Promise<void>;
};

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

function clampFontSize(size: number): number {
  return Math.max(8, Math.min(32, size));
}

function normalizeSettings(candidate: TerminalSettings): TerminalSettings {
  return {
    ...DEFAULTS,
    ...candidate,
    fontSize: clampFontSize(candidate.fontSize),
  };
}

async function resolveSettingsFont(
  settings: TerminalSettings,
): Promise<string> {
  return resolveFont(settings);
}

let settingsListenerBound = false;
let fontResolutionToken = 0;

function syncTerminalSettings(next: TerminalSettings): void {
  const normalized = normalizeSettings(next);

  useTerminalStore.setState((state) => {
    if (terminalEqual(state.settings, normalized)) {
      return state;
    }

    return {
      settings: normalized,
      version: state.version + 1,
    };
  });

  const token = ++fontResolutionToken;
  void resolveSettingsFont(normalized).then((fontFamily) => {
    if (token !== fontResolutionToken) {
      return;
    }

    useTerminalStore.setState((state) => {
      if (
        state.fontFamily === fontFamily &&
        terminalEqual(state.settings, normalized)
      ) {
        return state;
      }

      return {
        settings: normalized,
        fontFamily,
        version: state.version + 1,
      };
    });
  });
}

function bindSettingsListener(): void {
  if (settingsListenerBound) {
    return;
  }
  settingsListenerBound = true;

  let previous = useSettingsStore.getState().settings.terminal;
  useSettingsStore.subscribe((state) => {
    const next = state.settings.terminal;
    if (terminalEqual(previous, next)) {
      return;
    }

    previous = next;
    syncTerminalSettings(next);
  });
}

export const useTerminalStore = create<TerminalState>(() => ({
  settings: { ...DEFAULTS },
  fontFamily: DEFAULT_FONT_FAMILY,
  version: 0,
  async init() {
    bindSettingsListener();
    syncTerminalSettings(useSettingsStore.getState().settings.terminal);
  },
  async updateSettings(partial) {
    await useSettingsStore.getState().patchSettings({
      terminal: partial,
    });
  },
}));

export function resetTerminalStoreForTests(): void {
  fontResolutionToken = 0;
  useTerminalStore.setState({
    settings: { ...DEFAULTS },
    fontFamily: DEFAULT_FONT_FAMILY,
    version: 0,
  });
}
