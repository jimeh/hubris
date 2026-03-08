import { create } from "zustand";
import {
  clearTheme,
  computeThemeVars,
  applyComputedVars,
  type ComputedThemeVars,
} from "@/lib/theme/convert";
import { builtinThemes } from "@/lib/theme/builtin";
import type {
  AppearanceSettings,
  HubrisTheme,
  ThemeListEntry,
} from "@/lib/theme/types";
import { getSettings, saveSettings } from "@/lib/api";

const DEFAULTS: AppearanceSettings = {
  colorScheme: "auto",
  lightTheme: "hubris-light",
  darkTheme: "hubris-dark",
};

const builtinsById = new Map(builtinThemes.map((theme) => [theme.id, theme]));

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

interface ThemeState {
  settings: AppearanceSettings;
  activeTheme: HubrisTheme | null;
  version: number;
  prefersLight: boolean;

  allThemes: ThemeListEntry[];
  isDark: boolean;

  init: () => Promise<void>;
  updateSettings: (partial: Partial<AppearanceSettings>) => Promise<void>;
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
    resolveThemeSync(wantLight ? DEFAULTS.lightTheme : DEFAULTS.darkTheme)!
  );
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

function cacheThemeVars(settings: AppearanceSettings) {
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

export const useThemeStore = create<ThemeState>((set, get) => {
  // Track OS preference changes
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  mql.addEventListener("change", (e) => {
    const prefersLight = !e.matches;
    const { settings } = get();
    const theme = applyActiveTheme(settings, prefersLight);
    set({
      prefersLight,
      activeTheme: theme,
      version: get().version + 1,
    });
  });

  return {
    settings: { ...DEFAULTS },
    activeTheme: null,
    version: 0,
    prefersLight: !mql.matches,

    get allThemes(): ThemeListEntry[] {
      return [...builtinThemes];
    },

    get isDark(): boolean {
      return get().activeTheme?.type === "dark";
    },

    async init(): Promise<void> {
      let shouldPersistNormalized = false;
      let currentSettings = { ...DEFAULTS };
      try {
        const s = await getSettings();
        if (s.appearance) {
          const normalized = normalizeSettings({
            ...DEFAULTS,
            ...s.appearance,
          });
          currentSettings = normalized.settings;
          shouldPersistNormalized = normalized.changed;
        }
      } catch {
        // Server unreachable — try localStorage fallback
        try {
          const cached = localStorage.getItem("hubris-appearance");
          if (cached) {
            currentSettings = normalizeSettings({
              ...DEFAULTS,
              ...JSON.parse(cached),
            }).settings;
          }
        } catch {
          // Corrupted cache — stay with defaults
        }
      }
      const { prefersLight } = get();
      const theme = applyActiveTheme(currentSettings, prefersLight);
      set({
        settings: currentSettings,
        activeTheme: theme,
        version: get().version + 1,
      });
      if (shouldPersistNormalized) {
        try {
          await saveSettings({
            appearance: currentSettings,
          });
        } catch {
          // Settings save failed — keep normalized state in memory
        }
      }
    },

    async updateSettings(partial: Partial<AppearanceSettings>): Promise<void> {
      const { settings, prefersLight } = get();
      const nextSettings = normalizeSettings({
        ...settings,
        ...partial,
      }).settings;
      const theme = applyActiveTheme(nextSettings, prefersLight);
      set({
        settings: nextSettings,
        activeTheme: theme,
        version: get().version + 1,
      });
      await saveSettings({
        appearance: nextSettings,
      });
    },
  };
});
