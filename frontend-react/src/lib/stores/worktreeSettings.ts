import { create } from "zustand";
import { getSettings, saveSettings } from "@/lib/api";
import type { WorktreeSettings } from "@/lib/theme/types";

const DEFAULTS: WorktreeSettings = {
  locationMode: "dataDir",
};

interface WorktreeSettingsState {
  settings: WorktreeSettings;

  init: () => Promise<void>;
  updateSettings: (partial: Partial<WorktreeSettings>) => Promise<void>;
}

export const useWorktreeSettingsStore = create<WorktreeSettingsState>(
  (set, get) => ({
    settings: { ...DEFAULTS },

    async init(): Promise<void> {
      try {
        const current = await getSettings();
        if (current.worktree) {
          set({
            settings: { ...DEFAULTS, ...current.worktree },
          });
        }
      } catch {
        set({ settings: { ...DEFAULTS } });
      }
    },

    async updateSettings(partial: Partial<WorktreeSettings>): Promise<void> {
      const previous = { ...get().settings };
      const next = { ...previous, ...partial };
      set({ settings: next });
      try {
        await saveSettings({ worktree: next });
      } catch (err) {
        set({ settings: previous });
        throw err;
      }
    },
  }),
);
