/** Settings sections shared by commands, stores, and the settings UI. */
export const SETTINGS_SECTION_NAMES = [
  "Appearance",
  "Editor",
  "Terminal",
  "Keyboard Shortcuts",
  "VS Code",
  "Worktrees",
  "Experimental",
] as const;

export type SectionName = (typeof SETTINGS_SECTION_NAMES)[number];
