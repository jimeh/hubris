import { create } from "zustand";
import { getSettings, saveSettings } from "$lib/api";
import { DEFAULT_FONT_FAMILY, resolveFont } from "$lib/terminal/fonts";
import type { TerminalSettings } from "$lib/theme/types";

const DEFAULTS: TerminalSettings = {
  fontSource: "default",
  systemFontFamily: "",
  bundledFont: "jetbrainsmono-nf",
  fontSize: 14,
};

type TerminalState = {
  settings: TerminalSettings;
  fontFamily: string;
  version: number;
  init: () => Promise<void>;
  updateSettings: (partial: Partial<TerminalSettings>) => Promise<void>;
};

function clampFontSize(size: number): number {
  return Math.max(8, Math.min(32, size));
}

async function resolveSettingsFont(
  settings: TerminalSettings,
): Promise<string> {
  return resolveFont(settings);
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  settings: { ...DEFAULTS },
  fontFamily: DEFAULT_FONT_FAMILY,
  version: 0,
  async init() {
    let settings = { ...DEFAULTS };

    try {
      const current = await getSettings();
      if (current.terminal) {
        settings = {
          ...DEFAULTS,
          ...current.terminal,
        };
      }
    } catch {
      try {
        const cached = localStorage.getItem("hubris-terminal");
        if (cached) {
          settings = {
            ...DEFAULTS,
            ...JSON.parse(cached),
          };
        }
      } catch {
        // Keep defaults.
      }
    }

    settings.fontSize = clampFontSize(settings.fontSize);
    const fontFamily = await resolveSettingsFont(settings);
    set((state) => ({
      settings,
      fontFamily,
      version: state.version + 1,
    }));
  },
  async updateSettings(partial) {
    const previous = get();
    const next: TerminalSettings = {
      ...previous.settings,
      ...partial,
    };
    next.fontSize = clampFontSize(next.fontSize);

    const fontFamily = await resolveSettingsFont(next);
    set((state) => ({
      settings: next,
      fontFamily,
      version: state.version + 1,
    }));

    try {
      await saveSettings({ terminal: next });
    } catch (error) {
      set((state) => ({
        settings: previous.settings,
        fontFamily: previous.fontFamily,
        version: state.version + 1,
      }));
      throw error;
    }
  },
}));

export function resetTerminalStoreForTests(): void {
  useTerminalStore.setState({
    settings: { ...DEFAULTS },
    fontFamily: DEFAULT_FONT_FAMILY,
    version: 0,
  });
}
