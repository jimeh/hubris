import { themeEntries, useSettingsStore } from "@/lib/stores/settings";
import { useShallow } from "zustand/react/shallow";
import type {
  AppearanceSettings,
  AppearanceSettingsPatch,
  HubrisTheme,
  ThemeListEntry,
} from "@/lib/theme/types";

type ThemeStoreSlice = {
  settings: AppearanceSettings;
  activeTheme: HubrisTheme | null;
  version: number;
  prefersLight: boolean;
  updateSettings: (partial: AppearanceSettingsPatch) => void;
};

function updateThemeSettings(partial: AppearanceSettingsPatch): void {
  useSettingsStore.getState().updateAppearance(partial);
}

function selectThemeSlice(state: ReturnType<typeof useSettingsStore.getState>) {
  return {
    settings: state.settings.appearance,
    activeTheme: state.activeTheme,
    version: state.themeVersion,
    prefersLight: state.prefersLight,
    updateSettings: updateThemeSettings,
  } satisfies ThemeStoreSlice;
}

export function useThemeSettings<T>(
  selector: (state: ThemeStoreSlice) => T,
): T {
  const slice = useSettingsStore(useShallow(selectThemeSlice));
  return selector(slice);
}

export { themeEntries };
export type { ThemeListEntry };
