import type { ComputedThemeVars } from "./convert";
import type { SettingsState } from "./types";

type AppearanceSettings = SettingsState["settings"]["appearance"];

type ThemeCache = Partial<Record<"light" | "dark", ComputedThemeVars>>;

const DEFAULT_APPEARANCE: AppearanceSettings = {
  colorScheme: "auto",
  lightTheme: "hubris-light",
  darkTheme: "hubris-dark",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAppearanceSettings(
  rawSettings: string | null,
): AppearanceSettings {
  if (!rawSettings) {
    return DEFAULT_APPEARANCE;
  }

  try {
    const parsed = JSON.parse(rawSettings) as Partial<SettingsState>;
    const appearance = parsed.settings?.appearance;
    if (!appearance) {
      return DEFAULT_APPEARANCE;
    }

    const colorScheme =
      appearance.colorScheme === "light" ||
      appearance.colorScheme === "dark" ||
      appearance.colorScheme === "auto"
        ? appearance.colorScheme
        : DEFAULT_APPEARANCE.colorScheme;
    const lightTheme =
      typeof appearance.lightTheme === "string"
        ? appearance.lightTheme
        : DEFAULT_APPEARANCE.lightTheme;
    const darkTheme =
      typeof appearance.darkTheme === "string"
        ? appearance.darkTheme
        : DEFAULT_APPEARANCE.darkTheme;

    return {
      colorScheme,
      lightTheme,
      darkTheme,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function parseThemeCacheEntry(value: unknown): ComputedThemeVars | null {
  if (!isRecord(value) || typeof value.isDark !== "boolean") {
    return null;
  }

  const { vars } = value;
  if (!isRecord(vars)) {
    return null;
  }

  const normalizedVars = Object.fromEntries(
    Object.entries(vars).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );

  return {
    isDark: value.isDark,
    vars: normalizedVars,
  };
}

function parseThemeCache(rawThemeCache: string | null): ThemeCache {
  if (!rawThemeCache) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawThemeCache) as Record<string, unknown>;
    return {
      light: parseThemeCacheEntry(parsed.light) ?? undefined,
      dark: parseThemeCacheEntry(parsed.dark) ?? undefined,
    };
  } catch {
    return {};
  }
}

export function selectPrepaintTheme(
  rawSettings: string | null,
  rawThemeCache: string | null,
  prefersDark: boolean,
): {
  wantDark: boolean;
  entry: ComputedThemeVars | null;
} {
  const appearance = parseAppearanceSettings(rawSettings);
  const wantDark =
    appearance.colorScheme === "dark" ||
    (appearance.colorScheme !== "light" && prefersDark);
  const cache = parseThemeCache(rawThemeCache);

  return {
    wantDark,
    entry: wantDark ? (cache.dark ?? null) : (cache.light ?? null),
  };
}
