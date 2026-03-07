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
} from "$lib/theme/types";
import { getSettings, saveSettings } from "$lib/api";

const DEFAULTS: AppearanceSettings = {
  colorScheme: "auto",
  lightTheme: "hubris-light",
  darkTheme: "hubris-dark",
};

let settings = $state<AppearanceSettings>({ ...DEFAULTS });
const builtinsById = new Map(builtinThemes.map((theme) => [theme.id, theme]));
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
    applyActiveTheme();
  });

function allThemeEntries(): ThemeListEntry[] {
  return [...builtinThemes];
}

function resolveThemeSync(id: string): HubrisTheme | undefined {
  return builtinsById.get(id);
}

function normalizeSettings(candidate: AppearanceSettings): {
  settings: AppearanceSettings;
  changed: boolean;
} {
  let changed = false;
  let colorScheme = candidate.colorScheme;
  if (!["auto", "light", "dark"].includes(colorScheme)) {
    colorScheme = DEFAULTS.colorScheme;
    changed = true;
  }

  let lightTheme = candidate.lightTheme;
  if (resolveThemeSync(lightTheme)?.type !== "light") {
    lightTheme = DEFAULTS.lightTheme;
    changed = true;
  }

  let darkTheme = candidate.darkTheme;
  if (resolveThemeSync(darkTheme)?.type !== "dark") {
    darkTheme = DEFAULTS.darkTheme;
    changed = true;
  }

  return {
    settings: {
      colorScheme: colorScheme as AppearanceSettings["colorScheme"],
      lightTheme,
      darkTheme,
    },
    changed,
  };
}

function getActiveTheme(): HubrisTheme {
  const wantLight =
    settings.colorScheme === "light" ||
    (settings.colorScheme === "auto" && prefersLight);

  const id = wantLight ? settings.lightTheme : settings.darkTheme;

  return (
    resolveThemeSync(id) ??
    resolveThemeSync(wantLight ? DEFAULTS.lightTheme : DEFAULTS.darkTheme)!
  );
}

function applyActiveTheme() {
  clearTheme();
  const theme = getActiveTheme();
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

/** Load settings from server and apply the active built-in theme. */
async function init() {
  let shouldPersistNormalized = false;
  try {
    const s = await getSettings();
    if (s.appearance) {
      const normalized = normalizeSettings({ ...DEFAULTS, ...s.appearance });
      settings = normalized.settings;
      shouldPersistNormalized = normalized.changed;
    }
  } catch {
    // Server unreachable — try localStorage fallback
    try {
      const cached = localStorage.getItem("hubris-appearance");
      if (cached) {
        settings = normalizeSettings({
          ...DEFAULTS,
          ...JSON.parse(cached),
        }).settings;
      }
    } catch {
      // Corrupted cache — stay with defaults
    }
  }
  applyActiveTheme();
  if (shouldPersistNormalized) {
    try {
      await saveSettings({
        appearance: $state.snapshot(settings),
      });
    } catch {
      // Settings save failed — keep normalized state in memory
    }
  }
}

async function updateSettings(partial: Partial<AppearanceSettings>) {
  settings = normalizeSettings({ ...settings, ...partial }).settings;
  applyActiveTheme();
  await saveSettings({
    appearance: $state.snapshot(settings),
  });
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
  };
}
