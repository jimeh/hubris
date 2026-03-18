import { toast } from "sonner";

const SETTINGS_FAILED_TOAST_ID = "settings-save-failed";
const SETTINGS_INVALID_TOAST_ID = "settings-save-invalid";

export function showSettingsSaveFailedToast(): void {
  toast.warning("Settings failed to save.", {
    id: SETTINGS_FAILED_TOAST_ID,
    description: "Reverted to the latest server state.",
    duration: 5_000,
    className: "border-l-4 border-l-amber-500/70",
  });
}

export function showSettingsInvalidFileToast(): void {
  toast.error("Settings can't be saved until settings.toml is fixed.", {
    id: SETTINGS_INVALID_TOAST_ID,
    description: "Hubris reloaded the current server copy instead.",
    duration: 5_000,
    className: "border-l-4 border-l-amber-500/70",
  });
}
