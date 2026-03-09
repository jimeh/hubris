import { create } from "zustand";
import {
  applyComputedVars,
  clearTheme,
  computeThemeVars,
  type ComputedThemeVars,
} from "@/lib/theme/convert";
import { builtinThemes } from "@/lib/theme/builtin";
import { getSettings, saveSettings } from "@/lib/api";
import type {
  AppearanceSettings,
  HubrisTheme,
  ThemeListEntry,
} from "@/lib/theme/types";

const DEFAULTS: AppearanceSettings = {
  colorScheme: "auto",
  lightTheme: "hubris-light",
  darkTheme: "hubris-dark",
};

const builtinsById = new Map(
  builtinThemes.map((theme) => [theme.id, theme] as const),
);

type ThemeState = {
  settings: AppearanceSettings;
  activeTheme: HubrisTheme | null;
  version: number;
  prefersLight: boolean;
  init: () => Promise<void>;
  updateSettings: (partial: Partial<AppearanceSettings>) => Promise<void>;
};

function readPrefersLight(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return true;
  }
  return !window.matchMedia("(prefers-color-scheme: dark)").matches;
}

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

function cacheThemeVars(settings: AppearanceSettings): void {
  try {
    const cache: Record<string, ComputedThemeVars> = {};

    if (settings.colorScheme === "auto" || settings.colorScheme === "light") {
      const lightTheme =
        resolveThemeSync(settings.lightTheme) ??
        builtinThemes.find((theme) => theme.id === DEFAULTS.lightTheme)!;
      cache.light = computeThemeVars(lightTheme);
    }

    if (settings.colorScheme === "auto" || settings.colorScheme === "dark") {
      const darkTheme =
        resolveThemeSync(settings.darkTheme) ??
        builtinThemes.find((theme) => theme.id === DEFAULTS.darkTheme)!;
      cache.dark = computeThemeVars(darkTheme);
    }

    localStorage.setItem("hubris-theme-cache", JSON.stringify(cache));
  } catch {
    // localStorage full or unavailable.
  }
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

let mediaListenerBound = false;

function bindMediaListener(): void {
  if (mediaListenerBound || typeof window === "undefined") return;
  mediaListenerBound = true;

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = (event: MediaQueryListEvent) => {
    useThemeStore.setState((state) => {
      const prefersLight = !event.matches;
      const activeTheme = applyActiveTheme(state.settings, prefersLight);
      return {
        prefersLight,
        activeTheme,
        version: state.version + 1,
      };
    });
  };

  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", onChange);
  } else {
    media.addListener(onChange);
  }
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  settings: { ...DEFAULTS },
  activeTheme: null,
  version: 0,
  prefersLight: readPrefersLight(),
  async init() {
    bindMediaListener();
    let settings = { ...DEFAULTS };
    let shouldPersistNormalized = false;

    try {
      const current = await getSettings();
      if (current.appearance) {
        const normalized = normalizeSettings({
          ...DEFAULTS,
          ...current.appearance,
        });
        settings = normalized.settings;
        shouldPersistNormalized = normalized.changed;
      }
    } catch {
      try {
        const cached = localStorage.getItem("hubris-appearance");
        if (cached) {
          settings = normalizeSettings({
            ...DEFAULTS,
            ...JSON.parse(cached),
          }).settings;
        }
      } catch {
        // Keep defaults.
      }
    }

    const prefersLight = get().prefersLight;
    const activeTheme = applyActiveTheme(settings, prefersLight);

    set((state) => ({
      settings,
      activeTheme,
      version: state.version + 1,
    }));

    if (shouldPersistNormalized) {
      try {
        await saveSettings({ appearance: settings });
      } catch {
        // Keep normalized state in memory.
      }
    }
  },
  async updateSettings(partial) {
    const next = normalizeSettings({ ...get().settings, ...partial }).settings;
    const activeTheme = applyActiveTheme(next, get().prefersLight);
    set((state) => ({
      settings: next,
      activeTheme,
      version: state.version + 1,
    }));
    await saveSettings({ appearance: next });
  },
}));

export function resetThemeStoreForTests(): void {
  useThemeStore.setState({
    settings: { ...DEFAULTS },
    activeTheme: null,
    version: 0,
    prefersLight: readPrefersLight(),
  });
}

export function themeEntries(): ThemeListEntry[] {
  return allThemeEntries();
}
