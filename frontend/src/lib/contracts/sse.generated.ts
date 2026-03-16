// Generated file. Do not edit.

/**
 * Serializable tab metadata. Sent to clients via REST
 * and SSE.
 */
export type TabInfo = {
  id: string;
  session_id: string;
  worktree_id: string;
  label: string;
  type: string;
  position: number;
  created_at: number;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  position: number;
  git_error?: string | null;
};

export type Worktree = {
  id: string;
  project_id: string;
  name: string;
  path: string;
  branch: string;
  source_ref: string | null;
  is_local: boolean;
  missing_on_disk: boolean;
  position: number;
};

export type ColorScheme = "auto" | "light" | "dark";

export type TerminalFontSource = "default" | "system" | "bundled";

export type WorktreeLocationMode = "dataDir" | "repoLocalDotHubris";

export type AppearanceSettings = {
  colorScheme: ColorScheme;
  lightTheme: string;
  darkTheme: string;
};

export type TerminalSettings = {
  fontSource: TerminalFontSource;
  systemFontFamily: string;
  bundledFont: string;
  fontSize: number;
};

export type WorktreeSettings = {
  locationMode: WorktreeLocationMode;
};

export type Settings = {
  appearance: AppearanceSettings;
  terminal: TerminalSettings;
  worktree: WorktreeSettings;
};

export type SettingsState = {
  settings: Settings;
  generation: string;
};

export type EventKind =
  | {
      type: "snapshot";
      data: {
        tabs: Array<TabInfo>;
        projects: Array<Project>;
        worktrees: { [key in string]: Array<Worktree> };
        project_errors: { [key in string]: string };
        settings: Settings;
        settings_generation: string;
      };
    }
  | { type: "tab_created"; data: TabInfo }
  | { type: "tab_closed"; data: { tab_id: string } }
  | { type: "tab_updated"; data: TabInfo }
  | {
      type: "tabs_reordered";
      data: { worktree_id: string; tabs: Array<TabInfo> };
    }
  | { type: "project_added"; data: Project }
  | { type: "project_removed"; data: { project_id: string } }
  | { type: "project_updated"; data: Project }
  | { type: "projects_reordered"; data: Array<Project> }
  | { type: "worktree_created"; data: Worktree }
  | {
      type: "worktree_deleted";
      data: { project_id: string; worktree_id: string };
    }
  | {
      type: "worktrees_reordered";
      data: { project_id: string; worktrees: Array<Worktree> };
    }
  | {
      type: "project_worktrees_updated";
      data: {
        project_id: string;
        worktrees: Array<Worktree>;
        git_error: string | null;
      };
    }
  | { type: "settings_updated"; data: SettingsState };
