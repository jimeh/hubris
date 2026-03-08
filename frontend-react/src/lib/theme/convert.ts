import { ALL_THEME_TOKENS } from "./types";
import type { HubrisTheme } from "./types";

/** All CSS var names we write, for cleanup. */
const ALL_CSS_VARS = ALL_THEME_TOKENS.map((token) => `--${token}`);

/** Pre-computed CSS variable values for a theme. */
export interface ComputedThemeVars {
  isDark: boolean;
  vars: Record<string, string>;
}

/** Compute CSS var values for a theme without applying. */
export function computeThemeVars(theme: HubrisTheme): ComputedThemeVars {
  const vars = Object.fromEntries(
    ALL_THEME_TOKENS.map((token) => [`--${token}`, theme.tokens[token]]),
  );

  return { isDark: theme.type === "dark", vars };
}

/** Apply pre-computed vars to the document. */
export function applyComputedVars(computed: ComputedThemeVars): void {
  const root = document.documentElement;
  root.classList.toggle("dark", computed.isDark);
  for (const [key, value] of Object.entries(computed.vars)) {
    root.style.setProperty(key, value);
  }
}

/**
 * Apply a theme to the document, setting CSS custom
 * properties on <html>.
 */
export function applyTheme(theme: HubrisTheme): void {
  applyComputedVars(computeThemeVars(theme));
}

/**
 * Remove all theme overrides from <html>, reverting to
 * app.css defaults.
 */
export function clearTheme(): void {
  const root = document.documentElement;
  for (const v of ALL_CSS_VARS) {
    root.style.removeProperty(v);
  }
}
