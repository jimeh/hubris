import { create } from "zustand";
import {
  applyComputedVars,
  clearTheme,
  computeThemeVars,
  type ComputedThemeVars,
} from "@/lib/theme/convert";
import { builtinThemes } from "@/lib/theme/builtin";
import { useSettingsStore } from "@/lib/stores/settings";
import {
  DEFAULT_APPEARANCE_SETTINGS,
  type AppearanceSettings,
  type AppearanceSettingsPatch,
} from "@/lib/settings/types";
import type { HubrisTheme, ThemeListEntry } from "@/lib/theme/types";

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
    colorScheme = DEFAULT_APPEARANCE_SETTINGS.colorScheme;
    changed = true;
  }

  let lightTheme = candidate.lightTheme;
  if (resolveThemeSync(lightTheme)?.type !== "light") {
    lightTheme = DEFAULT_APPEARANCE_SETTINGS.lightTheme;
    changed = true;
  }

  let darkTheme = candidate.darkTheme;
  if (resolveThemeSync(darkTheme)?.type !== "dark") {
    darkTheme = DEFAULT_APPEARANCE_SETTINGS.darkTheme;
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
    resolveThemeSync(
      wantLight
        ? DEFAULT_APPEARANCE_SETTINGS.lightTheme
        : DEFAULT_APPEARANCE_SETTINGS.darkTheme,
    )!
  );
}

function cacheThemeVars(settings: AppearanceSettings): void {
  try {
    const cache: Record<string, ComputedThemeVars> = {};

    if (settings.colorScheme === "auto" || settings.colorScheme === "light") {
      const lightTheme =
        resolveThemeSync(settings.lightTheme) ??
        builtinThemes.find(
          (theme) => theme.id === DEFAULT_APPEARANCE_SETTINGS.lightTheme,
        )!;
      cache.light = computeThemeVars(lightTheme);
    }

    if (settings.colorScheme === "auto" || settings.colorScheme === "dark") {
      const darkTheme =
        resolveThemeSync(settings.darkTheme) ??
        builtinThemes.find(
          (theme) => theme.id === DEFAULT_APPEARANCE_SETTINGS.darkTheme,
        )!;
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

function diffAppearanceSettings(
  current: AppearanceSettings,
  next: AppearanceSettings,
): AppearanceSettingsPatch | null {
  const patch: AppearanceSettingsPatch = {};

  if (current.colorScheme !== next.colorScheme) {
    patch.colorScheme = next.colorScheme;
  }
  if (current.lightTheme !== next.lightTheme) {
    patch.lightTheme = next.lightTheme;
  }
  if (current.darkTheme !== next.darkTheme) {
    patch.darkTheme = next.darkTheme;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function syncAppearanceSettings(
  next: AppearanceSettings,
  allowNormalizationSave: boolean,
): void {
  const normalized = normalizeSettings(next);
  const prefersLight = useThemeStore.getState().prefersLight;
  const activeTheme = applyActiveTheme(normalized.settings, prefersLight);

  useThemeStore.setState((state) => {
    const themeChanged = state.activeTheme?.id !== activeTheme.id;
    if (appearanceEqual(state.settings, normalized.settings) && !themeChanged) {
      return state;
    }

    return {
      settings: normalized.settings,
      activeTheme,
      version: state.version + 1,
    };
  });

  if (
    allowNormalizationSave &&
    normalized.changed &&
    !appearanceEqual(
      useSettingsStore.getState().settings.appearance,
      normalized.settings,
    )
  ) {
    const appearance = diffAppearanceSettings(
      useSettingsStore.getState().settings.appearance,
      normalized.settings,
    );
    if (appearance) {
      void useSettingsStore.getState().patchSettings({
        appearance,
      });
    }
  }
}

let mediaListenerBound = false;
let settingsListenerBound = false;

function bindMediaListener(): void {
  if (mediaListenerBound || typeof window === "undefined") {
    return;
  }
  mediaListenerBound = true;

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = (event: MediaQueryListEvent) => {
    useThemeStore.setState((state) => {
      const prefersLight = !event.matches;
      const activeTheme = applyActiveTheme(state.settings, prefersLight);
      const themeChanged = state.activeTheme?.id !== activeTheme.id;
      if (!themeChanged && state.prefersLight === prefersLight) {
        return state;
      }

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

function bindSettingsListener(): void {
  if (settingsListenerBound) {
    return;
  }
  settingsListenerBound = true;

  let previous = useSettingsStore.getState().settings.appearance;
  useSettingsStore.subscribe((state) => {
    const next = state.settings.appearance;
    if (appearanceEqual(previous, next)) {
      return;
    }

    previous = next;
    syncAppearanceSettings(next, true);
  });
}

export const useThemeStore = create<ThemeState>(() => ({
  settings: { ...DEFAULT_APPEARANCE_SETTINGS },
  activeTheme: null,
  version: 0,
  prefersLight: readPrefersLight(),
  async init() {
    bindMediaListener();
    bindSettingsListener();
    syncAppearanceSettings(
      useSettingsStore.getState().settings.appearance,
      true,
    );
  },
  async updateSettings(partial) {
    await useSettingsStore.getState().patchSettings({
      appearance: partial,
    });
  },
}));

export function resetThemeStoreForTests(): void {
  useThemeStore.setState({
    settings: { ...DEFAULT_APPEARANCE_SETTINGS },
    activeTheme: null,
    version: 0,
    prefersLight: readPrefersLight(),
  });
}

export function themeEntries(): ThemeListEntry[] {
  return allThemeEntries();
}
