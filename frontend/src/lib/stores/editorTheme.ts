import { useSettingsStore } from "@/lib/stores/settings";
import { useShallow } from "zustand/react/shallow";
import type { EditorSettings, EditorSettingsPatch } from "@/lib/theme/types";
import type { VscodeThemeJson } from "@/lib/api";

type EditorThemeSlice = {
  settings: EditorSettings;
  themeData: VscodeThemeJson | null;
  version: number;
  updateSettings: (partial: EditorSettingsPatch) => void;
};

function updateEditorSettings(partial: EditorSettingsPatch): void {
  useSettingsStore.getState().updateEditor(partial);
}

function selectEditorSlice(
  state: ReturnType<typeof useSettingsStore.getState>,
) {
  return {
    settings: state.settings.editor,
    themeData: state.editorThemeData,
    version: state.editorThemeVersion,
    updateSettings: updateEditorSettings,
  } satisfies EditorThemeSlice;
}

export function useEditorThemeSettings<T>(
  selector: (state: EditorThemeSlice) => T,
): T {
  const slice = useSettingsStore(useShallow(selectEditorSlice));
  return selector(slice);
}
