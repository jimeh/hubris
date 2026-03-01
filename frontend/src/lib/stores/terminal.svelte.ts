import { getSettings, saveSettings } from '$lib/api';
import { DEFAULT_FONT_FAMILY, resolveFont } from '$lib/terminal/fonts';
import type { TerminalSettings } from '$lib/theme/types';

function clampFontSize(size: number): number {
  return Math.max(8, Math.min(32, size));
}

const DEFAULTS: TerminalSettings = {
  fontSource: 'default',
  systemFontFamily: '',
  bundledFont: 'jetbrainsmono-nf',
  fontSize: 14,
};

let settings = $state<TerminalSettings>({ ...DEFAULTS });
let fontFamily = $state(DEFAULT_FONT_FAMILY);
let version = $state(0);

async function applyFont() {
  fontFamily = await resolveFont(settings);
  version++;
}

async function init() {
  try {
    const s = await getSettings();
    if (s.terminal) {
      settings = { ...DEFAULTS, ...s.terminal };
    }
  } catch {
    // Server unreachable — try localStorage
    try {
      const cached = localStorage.getItem('hubris-terminal');
      if (cached) {
        settings = { ...DEFAULTS, ...JSON.parse(cached) };
      }
    } catch {
      // stay with defaults
    }
  }
  settings.fontSize = clampFontSize(settings.fontSize);
  await applyFont();
}

async function updateSettings(partial: Partial<TerminalSettings>) {
  if (partial.fontSize !== undefined) {
    partial = { ...partial, fontSize: clampFontSize(partial.fontSize) };
  }
  settings = { ...settings, ...partial };
  await applyFont();
  await saveSettings({
    terminal: $state.snapshot(settings),
  });
}

export function getTerminalStore() {
  return {
    get settings() {
      return settings;
    },
    get fontFamily() {
      return fontFamily;
    },
    get fontSize() {
      return settings.fontSize;
    },
    get version() {
      return version;
    },
    init,
    updateSettings,
  };
}
