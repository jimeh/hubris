export interface AppearanceSettings {
  colorScheme: "auto" | "light" | "dark";
  lightTheme: string;
  darkTheme: string;
}

export interface TerminalSettings {
  fontSource: "default" | "system" | "bundled";
  systemFontFamily: string;
  bundledFont: string;
  fontSize: number;
}

export interface WorktreeSettings {
  locationMode: "dataDir" | "repoLocalDotHubris";
}

export interface Settings {
  appearance: AppearanceSettings;
  terminal: TerminalSettings;
  worktree: WorktreeSettings;
}

export interface AppearanceSettingsPatch {
  colorScheme?: AppearanceSettings["colorScheme"] | null;
  lightTheme?: string | null;
  darkTheme?: string | null;
}

export interface TerminalSettingsPatch {
  fontSource?: TerminalSettings["fontSource"] | null;
  systemFontFamily?: string | null;
  bundledFont?: string | null;
  fontSize?: number | null;
}

export interface WorktreeSettingsPatch {
  locationMode?: WorktreeSettings["locationMode"] | null;
}

export interface SettingsPatch {
  appearance?: AppearanceSettingsPatch;
  terminal?: TerminalSettingsPatch;
  worktree?: WorktreeSettingsPatch;
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  colorScheme: "auto",
  lightTheme: "hubris-light",
  darkTheme: "hubris-dark",
};

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontSource: "default",
  systemFontFamily: "",
  bundledFont: "jetbrainsmono-nf",
  fontSize: 14,
};

export const DEFAULT_WORKTREE_SETTINGS: WorktreeSettings = {
  locationMode: "dataDir",
};

export function defaultSettings(): Settings {
  return {
    appearance: { ...DEFAULT_APPEARANCE_SETTINGS },
    terminal: { ...DEFAULT_TERMINAL_SETTINGS },
    worktree: { ...DEFAULT_WORKTREE_SETTINGS },
  };
}
