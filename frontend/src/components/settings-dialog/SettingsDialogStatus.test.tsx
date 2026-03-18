import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resetSettingsStoreForTests,
  useSettingsStore,
} from "@/lib/stores/settings";
import SettingsDialogRoot from "./SettingsDialogRoot";

describe("SettingsDialogRoot invalid settings state", () => {
  beforeEach(() => {
    resetSettingsStoreForTests();
  });

  it("shows the warning and disables controls while writes are blocked", async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({
      status: {
        kind: "invalidFile",
        writesBlocked: true,
        message: "expected a ] while parsing settings.toml",
      },
    });

    render(<SettingsDialogRoot open onOpenChange={() => {}} />);

    expect(screen.getByText("Settings file is invalid")).toBeInTheDocument();
    expect(
      screen.getByText(/expected a \] while parsing settings\.toml/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Light" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.getByRole("button", { name: "Default" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Worktrees" }));
    expect(screen.getByRole("button", { name: "Data Dir" })).toBeDisabled();
  });
});
