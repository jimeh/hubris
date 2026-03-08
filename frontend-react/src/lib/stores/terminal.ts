import { create } from "zustand";
import { getSettings, saveSettings } from "@/lib/api";
import { DEFAULT_FONT_FAMILY, resolveFont } from "@/lib/terminal/fonts";
import type { TerminalSettings } from "@/lib/theme/types";

function clampFontSize(size: number): number {
  return Math.max(8, Math.min(32, size));
}

const DEFAULTS: TerminalSettings = {
  fontSource: "default",
  systemFontFamily: "",
  bundledFont: "jetbrainsmono-nf",
  fontSize: 14,
};

interface TerminalState {
  settings: TerminalSettings;
  fontFamily: string;
  fontSize: number;
  version: number;

  init: () => Promise<void>;
  updateSettings: (partial: Partial<TerminalSettings>) => Promise<void>;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  settings: { ...DEFAULTS },
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: DEFAULTS.fontSize,
  version: 0,

  async init(): Promise<void> {
    let current = { ...DEFAULTS };
    try {
      const s = await getSettings();
      if (s.terminal) {
        current = { ...DEFAULTS, ...s.terminal };
      }
    } catch {
      // Server unreachable — try localStorage
      try {
        const cached = localStorage.getItem("hubris-terminal");
        if (cached) {
          current = { ...DEFAULTS, ...JSON.parse(cached) };
        }
      } catch {
        // stay with defaults
      }
    }
    current.fontSize = clampFontSize(current.fontSize);
    const fontFamily = await resolveFont(current);
    set({
      settings: current,
      fontFamily,
      fontSize: current.fontSize,
      version: get().version + 1,
    });
  },

  async updateSettings(partial: Partial<TerminalSettings>): Promise<void> {
    if (partial.fontSize !== undefined) {
      partial = {
        ...partial,
        fontSize: clampFontSize(partial.fontSize),
      };
    }

    const prev = { ...get().settings };
    const prevFont = get().fontFamily;

    const nextSettings = { ...prev, ...partial };
    const fontFamily = await resolveFont(nextSettings);
    set({
      settings: nextSettings,
      fontFamily,
      fontSize: nextSettings.fontSize,
      version: get().version + 1,
    });

    try {
      await saveSettings({ terminal: nextSettings });
    } catch (err) {
      // Rollback to previous state on save failure
      set({
        settings: prev,
        fontFamily: prevFont,
        fontSize: prev.fontSize,
        version: get().version + 1,
      });
      throw err;
    }
  },
}));
