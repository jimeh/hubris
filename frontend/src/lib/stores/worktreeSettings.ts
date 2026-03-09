import { create } from "zustand";
import { getSettings, saveSettings } from "@/lib/api";
import type { WorktreeSettings } from "@/lib/theme/types";

const DEFAULTS: WorktreeSettings = {
  locationMode: "dataDir",
};

type WorktreeSettingsState = {
  settings: WorktreeSettings;
  init: () => Promise<void>;
  updateSettings: (partial: Partial<WorktreeSettings>) => Promise<void>;
};

export const useWorktreeSettingsStore = create<WorktreeSettingsState>(
  (set, get) => ({
    settings: { ...DEFAULTS },
    async init() {
      try {
        const current = await getSettings();
        if (current.worktree) {
          set({
            settings: {
              ...DEFAULTS,
              ...current.worktree,
            },
          });
        }
      } catch {
        set({ settings: { ...DEFAULTS } });
      }
    },
    async updateSettings(partial) {
      const previous = get().settings;
      const next = {
        ...previous,
        ...partial,
      };
      set({ settings: next });
      try {
        await saveSettings({ worktree: next });
      } catch (error) {
        set({ settings: previous });
        throw error;
      }
    },
  }),
);

export function resetWorktreeSettingsStoreForTests(): void {
  useWorktreeSettingsStore.setState({
    settings: { ...DEFAULTS },
  });
}
