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
  "notification-dot",
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

type Schemas = components["schemas"];
type RestSettings = NonNullable<Schemas["Settings"]>;
type RestSettingsPatch = NonNullable<Schemas["SettingsPatch"]>;
type RestSettingsStatus = NonNullable<Schemas["SettingsStatus"]>;

type NullableToOptional<T> = {
  [K in keyof T]?: Exclude<T[K], null | undefined>;
};

type RequiredFields<T> = {
  [K in keyof T]-?: Exclude<T[K], null | undefined>;
};

export type AppearanceSettings = RequiredFields<
  NonNullable<RestSettings["appearance"]>
>;
export type TerminalSettings = RequiredFields<
  NonNullable<RestSettings["terminal"]>
>;
export type EditorSettings = RequiredFields<
  NonNullable<RestSettings["editor"]>
>;
export type WorktreeSettings = RequiredFields<
  NonNullable<RestSettings["worktree"]>
>;
export type Settings = {
  appearance: AppearanceSettings;
  terminal: TerminalSettings;
  editor: EditorSettings;
  worktree: WorktreeSettings;
};
export type SettingsStatusKind = Exclude<
  RestSettingsStatus["kind"],
  null | undefined
>;
export type SettingsStatus = {
  kind: SettingsStatusKind;
  writesBlocked: Exclude<RestSettingsStatus["writesBlocked"], null | undefined>;
  message: Exclude<RestSettingsStatus["message"], undefined>;
};
export type AppearanceSettingsPatch = NullableToOptional<
  NonNullable<RestSettingsPatch["appearance"]>
>;
export type TerminalSettingsPatch = NullableToOptional<
  NonNullable<RestSettingsPatch["terminal"]>
>;
export type EditorSettingsPatch = NullableToOptional<
  NonNullable<RestSettingsPatch["editor"]>
>;
export type WorktreeSettingsPatch = NullableToOptional<
  NonNullable<RestSettingsPatch["worktree"]>
>;
export type SettingsPatch = {
  appearance?: AppearanceSettingsPatch;
  terminal?: TerminalSettingsPatch;
  editor?: EditorSettingsPatch;
  worktree?: WorktreeSettingsPatch;
};
export type SettingsState = {
  settings: Settings;
  generation: NonNullable<Schemas["SettingsState"]>["generation"];
  status: SettingsStatus;
};
