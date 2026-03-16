import { useSettingsStore } from "@/lib/stores/settings";
import { useShallow } from "zustand/react/shallow";
import type {
  WorktreeSettings,
  WorktreeSettingsPatch,
} from "@/lib/theme/types";

type WorktreeStoreSlice = {
  settings: WorktreeSettings;
  updateSettings: (partial: WorktreeSettingsPatch) => Promise<void>;
};

async function updateWorktreeSettings(
  partial: WorktreeSettingsPatch,
): Promise<void> {
  useSettingsStore.getState().updateWorktree(partial);
}

function selectWorktreeSlice(
  state: ReturnType<typeof useSettingsStore.getState>,
) {
  return {
    settings: state.settings.worktree,
    updateSettings: updateWorktreeSettings,
  } satisfies WorktreeStoreSlice;
}

export function useWorktreeSettingsStore<T>(
  selector: (state: WorktreeStoreSlice) => T,
): T {
  const slice = useSettingsStore(useShallow(selectWorktreeSlice));
  return selector(slice);
}

export function resetWorktreeSettingsStoreForTests(): void {}
