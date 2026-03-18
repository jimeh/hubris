import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  showSettingsInvalidFileToast,
  showSettingsSaveFailedToast,
} from "./toasts";

vi.mock("sonner", () => ({
  toast: {
    warning: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}));

describe("settings toasts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses stable ids for failure notifications", () => {
    showSettingsSaveFailedToast();
    showSettingsInvalidFileToast();

    expect(toast.warning).toHaveBeenCalledWith(
      "Settings failed to save.",
      expect.objectContaining({ id: "settings-save-failed" }),
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Settings can't be saved until settings.toml is fixed.",
      expect.objectContaining({ id: "settings-save-invalid" }),
    );
  });
});
