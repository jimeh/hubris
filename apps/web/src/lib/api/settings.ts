import type { Settings, SettingsPatch, SettingsState } from "@/lib/theme/types";
import { requestJson } from "./client";

export async function getSettings(): Promise<SettingsState> {
  return (await requestJson("GET", "/api/settings", {})) as SettingsState;
}

export function resetApiStateForTests(): void {
  // No shared API state to reset right now.
}

export async function patchSettings(
  partial: SettingsPatch,
): Promise<SettingsState> {
  return (await requestJson("PATCH", "/api/settings", {
    body: partial,
  })) as SettingsState;
}

export async function replaceSettings(
  settings: Settings,
): Promise<SettingsState> {
  return (await requestJson("PUT", "/api/settings", {
    body: settings,
  })) as SettingsState;
}
