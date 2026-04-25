import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSettingsStoreForTests } from "@/lib/stores/settings";
import SettingsDialogRoot from "./SettingsDialogRoot";

vi.mock("./AppearanceSettings", () => ({
  default: () => <div>Appearance section</div>,
}));

vi.mock("./TerminalSettings", () => ({
  default: () => <div>Terminal section</div>,
}));

vi.mock("./KeyboardShortcutsSettings", () => ({
  default: () => <div>Keyboard Shortcuts section</div>,
}));

vi.mock("./VscodeSettings", () => ({
  default: () => <div>VS Code section</div>,
}));

vi.mock("./WorktreeSettings", () => ({
  default: () => <div>Worktrees section</div>,
}));

describe("SettingsDialogRoot", () => {
  beforeEach(() => {
    resetSettingsStoreForTests();
  });

  it("uses sidebar menu buttons for desktop section switching", async () => {
    const user = userEvent.setup();

    render(<SettingsDialogRoot open onOpenChange={vi.fn()} />);

    const appearanceButton = screen.getByRole("button", {
      name: "Appearance",
    });
    const terminalButton = screen.getByRole("button", { name: "Terminal" });

    expect(appearanceButton).toHaveAttribute("data-sidebar", "menu-button");
    expect(appearanceButton).toHaveAttribute("data-active", "true");
    expect(screen.getByText("Appearance section")).toBeInTheDocument();

    await user.click(terminalButton);

    expect(terminalButton).toHaveAttribute("data-active", "true");
    expect(screen.getByText("Terminal section")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { current: "page", name: "Terminal" }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Keyboard Shortcuts" }),
    );
    expect(screen.getByText("Keyboard Shortcuts section")).toBeInTheDocument();
  });

  it("keeps the mobile select navigation working", async () => {
    const user = userEvent.setup();

    render(<SettingsDialogRoot open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "VS Code" }));

    expect(screen.getByText("VS Code section")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveTextContent("VS Code");
  });

  it("closes from the sidebar back button", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(<SettingsDialogRoot open onOpenChange={onOpenChange} />);

    await user.click(
      screen.getAllByRole("button", { name: "Close settings" })[0],
    );

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("resets to the requested section when reopened from a command", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <SettingsDialogRoot open onOpenChange={onOpenChange} />,
    );

    await user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.getByText("Terminal section")).toBeInTheDocument();

    rerender(<SettingsDialogRoot open={false} onOpenChange={onOpenChange} />);
    rerender(
      <SettingsDialogRoot
        initialSection="VS Code"
        open
        onOpenChange={onOpenChange}
      />,
    );

    expect(screen.getByText("VS Code section")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { current: "page", name: "VS Code" }),
    ).toBeInTheDocument();
  });

  it("reopens to the last selected section", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <SettingsDialogRoot open onOpenChange={onOpenChange} />,
    );

    await user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.getByText("Terminal section")).toBeInTheDocument();

    rerender(<SettingsDialogRoot open={false} onOpenChange={onOpenChange} />);
    rerender(<SettingsDialogRoot open onOpenChange={onOpenChange} />);

    expect(screen.getByText("Terminal section")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { current: "page", name: "Terminal" }),
    ).toBeInTheDocument();
  });
});
