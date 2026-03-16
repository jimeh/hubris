import type { components } from "@/lib/contracts/rest.generated";

export const UI_THEME_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "quick-input-background",
  "quick-input-foreground",
  "quick-input-border",
  "quick-input-group-foreground",
  "quick-input-focus-background",
  "quick-input-focus-foreground",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
  "tab-bar",
  "tab-active",
  "tab-active-foreground",
  "tab-inactive-foreground",
  "tab-border",
  "tab-active-border",
] as const;

export const TERMINAL_THEME_TOKENS = [
  "terminal-background",
  "terminal-foreground",
  "terminal-cursor",
  "terminal-selection",
  "terminal-ansi-black",
  "terminal-ansi-red",
  "terminal-ansi-green",
  "terminal-ansi-yellow",
  "terminal-ansi-blue",
  "terminal-ansi-magenta",
  "terminal-ansi-cyan",
  "terminal-ansi-white",
  "terminal-ansi-bright-black",
  "terminal-ansi-bright-red",
  "terminal-ansi-bright-green",
  "terminal-ansi-bright-yellow",
  "terminal-ansi-bright-blue",
  "terminal-ansi-bright-magenta",
  "terminal-ansi-bright-cyan",
  "terminal-ansi-bright-white",
] as const;

export const ALL_THEME_TOKENS = [
  ...UI_THEME_TOKENS,
  ...TERMINAL_THEME_TOKENS,
] as const;

export type UiThemeToken = (typeof UI_THEME_TOKENS)[number];
export type TerminalThemeToken = (typeof TERMINAL_THEME_TOKENS)[number];
export type ThemeToken = (typeof ALL_THEME_TOKENS)[number];

export type HubrisThemeTokens = Record<ThemeToken, string>;

/** Native Hubris theme authored in shadcn-style design tokens. */
export interface HubrisTheme {
  /** Unique identifier. Built-in: 'hubris-dark'. */
  id: string;
  /** Display name. */
  name: string;
  /** Dark or light. */
  type: "dark" | "light";
  /** Explicit token values for UI and terminal styling. */
  tokens: HubrisThemeTokens;
  /** True for bundled themes. */
  builtin?: boolean;
}

/** Theme entry shown in the appearance settings selectors. */
export interface ThemeListEntry {
  id: string;
  name: string;
  type: "dark" | "light";
  builtin?: boolean;
}

export type AppearanceSettings = components["schemas"]["AppearanceSettings"];
export type TerminalSettings = components["schemas"]["TerminalSettings"];
export type WorktreeSettings = components["schemas"]["WorktreeSettings"];
export type Settings = components["schemas"]["Settings"];
export type AppearanceSettingsPatch =
  components["schemas"]["AppearanceSettingsPatch"];
export type TerminalSettingsPatch =
  components["schemas"]["TerminalSettingsPatch"];
export type WorktreeSettingsPatch =
  components["schemas"]["WorktreeSettingsPatch"];
export type SettingsPatch = components["schemas"]["SettingsPatch"];
export type SettingsState = components["schemas"]["SettingsState"];
