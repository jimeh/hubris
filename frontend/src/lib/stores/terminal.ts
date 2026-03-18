import {
  type SettingsUpdateOptions,
  useSettingsStore,
} from "@/lib/stores/settings";
import { useShallow } from "zustand/react/shallow";
import type {
  TerminalSettings,
  TerminalSettingsPatch,
} from "@/lib/theme/types";

type TerminalStoreSlice = {
  settings: TerminalSettings;
  fontFamily: string;
  version: number;
  updateSettings: (
    partial: TerminalSettingsPatch,
    options?: SettingsUpdateOptions,
  ) => void;
};

function updateTerminalSettings(
  partial: TerminalSettingsPatch,
  options?: SettingsUpdateOptions,
): void {
  useSettingsStore.getState().updateTerminal(partial, options);
}

function selectTerminalSlice(
  state: ReturnType<typeof useSettingsStore.getState>,
) {
  return {
    settings: state.settings.terminal,
    fontFamily: state.fontFamily,
    version: state.terminalVersion,
    updateSettings: updateTerminalSettings,
  } satisfies TerminalStoreSlice;
}

export function useTerminalSettings<T>(
  selector: (state: TerminalStoreSlice) => T,
): T {
  const slice = useSettingsStore(useShallow(selectTerminalSlice));
  return selector(slice);
}
