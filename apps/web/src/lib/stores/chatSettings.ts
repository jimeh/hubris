import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "@/lib/stores/settings";
import type { ChatSettings, ChatSettingsPatch } from "@/lib/theme/types";

type ChatSettingsStoreSlice = {
  settings: ChatSettings;
  updateSettings: (
    partial: ChatSettingsPatch,
    options?: { debounceKey?: string; debounceMs?: number },
  ) => void;
};

function updateChatSettings(
  partial: ChatSettingsPatch,
  options?: { debounceKey?: string; debounceMs?: number },
): void {
  useSettingsStore.getState().updateChat(partial, options);
}

function selectChatSettingsSlice(
  state: ReturnType<typeof useSettingsStore.getState>,
) {
  return {
    settings: state.settings.chat,
    updateSettings: updateChatSettings,
  } satisfies ChatSettingsStoreSlice;
}

export function useChatSettings<T>(
  selector: (state: ChatSettingsStoreSlice) => T,
): T {
  const slice = useSettingsStore(useShallow(selectChatSettingsSlice));
  return selector(slice);
}
