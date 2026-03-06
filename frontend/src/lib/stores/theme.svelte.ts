import { SvelteMap } from "svelte/reactivity";
import {
  clearTheme,
  computeThemeVars,
  applyComputedVars,
  type ComputedThemeVars,
} from "$lib/theme/convert";
import { builtinThemes } from "$lib/theme/builtin";
import type {
  AppearanceSettings,
  HubrisTheme,
  ThemeListEntry,
  ThemeMeta,
} from "$lib/theme/types";
import {
  getSettings,
  saveSettings,
  listUserThemes,
  getUserTheme,
  uploadUserTheme,
  deleteUserTheme,
} from "$lib/api";

const DEFAULTS: AppearanceSettings = {
  colorScheme: "auto",
  lightTheme: "catppuccin-latte",
  darkTheme: "catppuccin-mocha",
};

let settings = $state<AppearanceSettings>({ ...DEFAULTS });
let userThemeMetas = $state<ThemeMeta[]>([]);
const userThemeCache = new SvelteMap<string, HubrisTheme>();
let appliedTheme = $state<HubrisTheme | null>(null);
let version = $state(0);

let prefersLight = $state(
  !window.matchMedia("(prefers-color-scheme: dark)").matches,
);

// Track OS preference changes
window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", (e) => {
    prefersLight = !e.matches;
    void applyActiveTheme();
  });

function allThemeEntries(): ThemeListEntry[] {
  return [...builtinThemes, ...userThemeMetas];
}

function resolveThemeSync(id: string): HubrisTheme | undefined {
  const builtin = builtinThemes.find((t) => t.id === id);
  if (builtin) return builtin;
  return userThemeCache.get(id);
}

async function resolveTheme(id: string): Promise<HubrisTheme | undefined> {
  const cached = resolveThemeSync(id);
  if (cached) return cached;
  if (!userThemeMetas.find((m) => m.id === id)) return undefined;
  try {
    const theme = await getUserTheme(id);
    userThemeCache.set(id, theme);
    return theme;
  } catch {
    return undefined;
  }
}

async function getActiveTheme(): Promise<HubrisTheme> {
  const wantLight =
    settings.colorScheme === "light" ||
    (settings.colorScheme === "auto" && prefersLight);

  const id = wantLight ? settings.lightTheme : settings.darkTheme;

  return (
    (await resolveTheme(id)) ??
    (await resolveTheme(wantLight ? DEFAULTS.lightTheme : DEFAULTS.darkTheme))!
  );
}

async function applyActiveTheme() {
  clearTheme();
  const theme = await getActiveTheme();
  applyComputedVars(computeThemeVars(theme));
  appliedTheme = theme;
  version++;
  cacheThemeVars();
}

function cacheThemeVars() {
  try {
    const cache: Record<string, ComputedThemeVars> = {};

    if (settings.colorScheme === "auto" || settings.colorScheme === "light") {
      const lightTheme =
        resolveThemeSync(settings.lightTheme) ??
        builtinThemes.find((t) => t.id === DEFAULTS.lightTheme)!;
      cache.light = computeThemeVars(lightTheme);
    }
    if (settings.colorScheme === "auto" || settings.colorScheme === "dark") {
      const darkTheme =
        resolveThemeSync(settings.darkTheme) ??
        builtinThemes.find((t) => t.id === DEFAULTS.darkTheme)!;
      cache.dark = computeThemeVars(darkTheme);
    }

    localStorage.setItem("hubris-theme-cache", JSON.stringify(cache));
  } catch {
    // localStorage full or unavailable — ignore
  }
}

/** Load settings from server + user themes list. */
async function init() {
  try {
    const [s, metas] = await Promise.all([getSettings(), listUserThemes()]);
    if (s.appearance) {
      settings = { ...DEFAULTS, ...s.appearance };
    }
    userThemeMetas = metas;
  } catch {
    // Server unreachable — try localStorage fallback
    try {
      const cached = localStorage.getItem("hubris-appearance");
      if (cached) {
        settings = { ...DEFAULTS, ...JSON.parse(cached) };
      }
    } catch {
      // Corrupted cache — stay with defaults
    }
  }
  await applyActiveTheme();
}

async function updateSettings(partial: Partial<AppearanceSettings>) {
  settings = { ...settings, ...partial };
  await applyActiveTheme();
  await saveSettings({
    appearance: $state.snapshot(settings),
  });
}

async function addUserTheme(theme: HubrisTheme): Promise<void> {
  await uploadUserTheme(theme);
  userThemeMetas = [
    ...userThemeMetas,
    { id: theme.id, name: theme.name, type: theme.type },
  ];
  userThemeCache.set(theme.id, theme);
}

async function removeUserTheme(id: string): Promise<void> {
  await deleteUserTheme(id);
  userThemeMetas = userThemeMetas.filter((t) => t.id !== id);
  userThemeCache.delete(id);
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
    get allThemes(): ThemeListEntry[] {
      return allThemeEntries();
    },
    get activeTheme() {
      return appliedTheme;
    },
    get isDark() {
      return appliedTheme?.type === "dark";
    },
    init,
    updateSettings,
    addUserTheme,
    removeUserTheme,
  };
}
