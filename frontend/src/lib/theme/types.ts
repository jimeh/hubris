/**
 * A VS Code color theme file. We only consume `name`,
 * `type`, and `colors` — tokenColors are ignored.
 */
export interface VscodeThemeFile {
  name?: string;
  type?: 'dark' | 'light' | 'hc';
  colors?: Record<string, string>;
  tokenColors?: unknown;
  semanticHighlighting?: unknown;
  semanticTokenColors?: unknown;
}

/**
 * Internal theme representation. Same shape as a VS Code
 * theme, but guaranteed to have name and type.
 */
export interface HubrisTheme {
  /** Unique identifier (slug). Built-in: 'catppuccin-mocha'. */
  id: string;
  /** Display name. */
  name: string;
  /** Dark or light. */
  type: 'dark' | 'light';
  /** VS Code color key → hex value. */
  colors: Record<string, string>;
  /** True for bundled themes. */
  builtin?: boolean;
}

/** Lightweight theme entry from the list endpoint. */
export interface ThemeMeta {
  id: string;
  name: string;
  type: 'dark' | 'light';
}

/** Union type for theme Select dropdowns (builtins + user). */
export interface ThemeListEntry {
  id: string;
  name: string;
  type: 'dark' | 'light';
  builtin?: boolean;
}

/**
 * User's appearance preferences, persisted to the server.
 */
export interface AppearanceSettings {
  /** 'auto' follows OS, otherwise use a fixed theme. */
  colorScheme: 'auto' | 'light' | 'dark';
  /** Theme ID for light mode (used when auto or light). */
  lightTheme: string;
  /** Theme ID for dark mode (used when auto or dark). */
  darkTheme: string;
}
