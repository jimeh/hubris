import { applyTheme, clearTheme } from '$lib/theme/convert';
import { builtinThemes } from '$lib/theme/builtin';
import type { AppearanceSettings, HubrisTheme } from '$lib/theme/types';
import {
  getSettings,
  saveSettings,
  listUserThemes,
  uploadUserTheme,
  deleteUserTheme,
} from '$lib/api';

const DEFAULTS: AppearanceSettings = {
  colorScheme: 'auto',
  lightTheme: 'catppuccin-latte',
  darkTheme: 'catppuccin-mocha',
};

let settings = $state<AppearanceSettings>({ ...DEFAULTS });
let userThemes = $state<HubrisTheme[]>([]);
let version = $state(0);

let prefersLight = $state(
  !window.matchMedia('(prefers-color-scheme: dark)').matches,
);

// Track OS preference changes
window
  .matchMedia('(prefers-color-scheme: dark)')
  .addEventListener('change', (e) => {
    prefersLight = !e.matches;
    applyActiveTheme();
  });

function allThemes(): HubrisTheme[] {
  return [...builtinThemes, ...userThemes];
}

function resolveTheme(id: string): HubrisTheme | undefined {
  return allThemes().find((t) => t.id === id);
}

function getActiveTheme(): HubrisTheme {
  const wantLight =
    settings.colorScheme === 'light' ||
    (settings.colorScheme === 'auto' && prefersLight);

  const id = wantLight ? settings.lightTheme : settings.darkTheme;

  return (
    resolveTheme(id) ??
    resolveTheme(wantLight ? DEFAULTS.lightTheme : DEFAULTS.darkTheme)!
  );
}

function applyActiveTheme() {
  clearTheme();
  applyTheme(getActiveTheme());
  version++;
}

/** Ensure all settings values are strings (repairs
 *  corrupted data where a string was saved as char[]). */
function sanitizeSettings(
  raw: Partial<AppearanceSettings>,
): Partial<AppearanceSettings> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, any> = { ...raw };
  for (const key of ['colorScheme', 'lightTheme', 'darkTheme']) {
    const v = out[key];
    if (Array.isArray(v)) out[key] = v.join('');
  }
  return out as Partial<AppearanceSettings>;
}

/** Load settings from server + user themes list. */
async function init() {
  try {
    const [s, themes] = await Promise.all([getSettings(), listUserThemes()]);
    if (s.appearance) {
      settings = {
        ...DEFAULTS,
        ...sanitizeSettings(s.appearance),
      };
    }
    userThemes = themes;
  } catch {
    // Server unreachable — try localStorage fallback
    try {
      const cached = localStorage.getItem('hubris-appearance');
      if (cached) {
        settings = {
          ...DEFAULTS,
          ...sanitizeSettings(JSON.parse(cached)),
        };
      }
    } catch {
      // Corrupted cache — stay with defaults
    }
  }
  applyActiveTheme();
}

async function updateSettings(partial: Partial<AppearanceSettings>) {
  settings = { ...settings, ...partial };
  applyActiveTheme();
  await saveSettings({
    appearance: $state.snapshot(settings),
  });
}

async function addUserTheme(theme: HubrisTheme): Promise<void> {
  await uploadUserTheme(theme);
  userThemes = [...userThemes, theme];
}

async function removeUserTheme(id: string): Promise<void> {
  await deleteUserTheme(id);
  userThemes = userThemes.filter((t) => t.id !== id);
  // If active theme was deleted, revert to default
  if (settings.lightTheme === id || settings.darkTheme === id) {
    const updated: Partial<AppearanceSettings> = {};
    if (settings.lightTheme === id) updated.lightTheme = DEFAULTS.lightTheme;
    if (settings.darkTheme === id) updated.darkTheme = DEFAULTS.darkTheme;
    await updateSettings(updated);
  }
}

export function getThemeStore() {
  return {
    get settings() {
      return settings;
    },
    get version() {
      return version;
    },
    get allThemes() {
      return allThemes();
    },
    get activeTheme() {
      return getActiveTheme();
    },
    get isDark() {
      return getActiveTheme().type === 'dark';
    },
    init,
    updateSettings,
    addUserTheme,
    removeUserTheme,
  };
}
