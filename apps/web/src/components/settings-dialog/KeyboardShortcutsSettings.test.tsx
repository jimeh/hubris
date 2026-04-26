import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import KeyboardShortcutsSettings from "./KeyboardShortcutsSettings";
import {
  resetKeybindingsStoreForTests,
  useKeybindingsStore,
} from "@/lib/stores/keybindings";
import type { KeybindingEntry } from "@/lib/contracts/sse.generated";

const okStatus = {
  kind: "ok",
  message: null,
  writesBlocked: false,
} as const;

function seedKeybindings(keybindings: KeybindingEntry[] = []) {
  const replaceUserKeybindings = vi.fn(async (next: KeybindingEntry[]) => ({
    generation: "2",
    keybindings: next,
    status: okStatus,
  }));
  useKeybindingsStore.setState({
    generation: "1",
    keybindings,
    status: okStatus,
    replaceUserKeybindings,
  });
  return replaceUserKeybindings;
}

describe("KeyboardShortcutsSettings", () => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "Linux x86_64",
    });
    resetKeybindingsStoreForTests();
  });

  it("filters commands and records a new shortcut", async () => {
    const user = userEvent.setup();
    const replaceUserKeybindings = seedKeybindings();
    render(<KeyboardShortcutsSettings />);

    await user.type(
      screen.getByPlaceholderText("Search commands..."),
      "New Terminal",
    );
    const row = screen.getAllByTestId("keybinding-row:tab.newTerminal")[0];

    await user.click(
      within(row).getByRole("button", {
        name: "Add shortcut for New Terminal Tab",
      }),
    );
    fireEvent.keyDown(window, { altKey: true, code: "Digit1", key: "1" });
    await user.click(screen.getByRole("button", { name: "Save Shortcut" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(replaceUserKeybindings).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          command: "tab.newTerminal",
          key: "alt+1",
        }),
      ]),
    );
  });

  it("keeps command rows inside a dedicated table scroll region", () => {
    seedKeybindings();
    render(<KeyboardShortcutsSettings />);

    expect(screen.getByTestId("keybinding-table-scroll")).toHaveClass(
      "overflow-y-auto",
    );
    expect(screen.getByText("Command")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Search commands..."),
    ).toBeInTheDocument();
  });

  it("blocks saving exact shortcut conflicts", () => {
    seedKeybindings([
      {
        command: "tab.newTerminal",
        disabled: false,
        key: "ctrl+1",
        when: "selectedWorktree",
      },
      {
        command: "tab.newBrowser",
        disabled: false,
        key: "ctrl+1",
        when: "selectedWorktree",
      },
    ]);

    render(<KeyboardShortcutsSettings />);

    expect(screen.getByText(/Resolve shortcut issues/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("resets a command and clears extra user shortcuts", async () => {
    const user = userEvent.setup();
    const replaceUserKeybindings = seedKeybindings([
      {
        command: "tab.newTerminal",
        disabled: false,
        key: "ctrl+1",
      },
      {
        command: "tab.newTerminal",
        disabled: false,
        key: "ctrl+2",
      },
    ]);
    render(<KeyboardShortcutsSettings />);

    await user.type(
      screen.getByPlaceholderText("Search commands..."),
      "New Terminal",
    );
    const row = screen.getAllByTestId("keybinding-row:tab.newTerminal")[0];
    await user.click(
      within(row).getByRole("button", {
        name: "More actions for New Terminal Tab",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Reset" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(replaceUserKeybindings).toHaveBeenCalledWith([]);
  });

  it("disables controls while keybindings.toml is invalid", () => {
    seedKeybindings();
    useKeybindingsStore.setState({
      status: {
        kind: "invalidFile",
        message: "expected a ]",
        writesBlocked: true,
      },
    });

    render(<KeyboardShortcutsSettings />);

    expect(screen.getByText("Keybindings file is invalid")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(
      screen.getAllByRole("button", { name: /Add shortcut for/ })[0],
    ).toBeDisabled();
  });

  it("edits an existing keybinding by clicking the key label", async () => {
    const user = userEvent.setup();
    seedKeybindings([
      {
        command: "tab.newTerminal",
        disabled: false,
        key: "ctrl+1",
      },
    ]);
    render(<KeyboardShortcutsSettings />);

    await user.type(
      screen.getByPlaceholderText("Search commands..."),
      "New Terminal",
    );
    const row = screen.getAllByTestId("keybinding-row:tab.newTerminal")[0];

    await user.click(
      within(row).getByRole("button", {
        name: /Edit shortcut .* for New Terminal Tab/,
      }),
    );

    expect(screen.getByRole("dialog")).toHaveTextContent("Record Shortcut");
  });

  it("clears an existing user shortcut from the recorder", async () => {
    const user = userEvent.setup();
    const replaceUserKeybindings = seedKeybindings([
      {
        command: "tab.newTerminal",
        disabled: false,
        key: "ctrl+1",
      },
    ]);
    render(<KeyboardShortcutsSettings />);

    await user.type(
      screen.getByPlaceholderText("Search commands..."),
      "New Terminal",
    );
    await user.click(
      screen.getByRole("button", {
        name: /Edit shortcut Ctrl\+1 for New Terminal Tab/,
      }),
    );
    fireEvent.keyDown(window, { key: "Backspace" });
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(replaceUserKeybindings).toHaveBeenCalledWith([]);
  });

  it("disables a default shortcut from the recorder", async () => {
    const user = userEvent.setup();
    const replaceUserKeybindings = seedKeybindings();
    render(<KeyboardShortcutsSettings />);

    await user.type(
      screen.getByPlaceholderText("Search commands..."),
      "Switch Worktree Mode",
    );
    const row = screen.getAllByTestId("keybinding-row:worktree.setUiMode")[0];
    await user.click(
      within(row).getByRole("button", {
        name: /Edit shortcut .* for Switch Worktree Mode/,
      }),
    );
    fireEvent.keyDown(window, { key: "Delete" });
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(replaceUserKeybindings).toHaveBeenCalledWith([
      expect.objectContaining({
        disabled: true,
        key: "mod+e",
        when: expect.any(String),
      }),
    ]);
  });

  it("preserves default shortcut args and when conditions when rebinding", async () => {
    const user = userEvent.setup();
    const replaceUserKeybindings = seedKeybindings();
    render(<KeyboardShortcutsSettings />);

    await user.type(
      screen.getByPlaceholderText("Search commands..."),
      "Switch Worktree Mode",
    );
    const row = screen.getAllByTestId("keybinding-row:worktree.setUiMode")[0];

    await user.click(
      within(row).getByRole("button", {
        name: /Edit shortcut .* for Switch Worktree Mode/,
      }),
    );
    fireEvent.keyDown(window, { altKey: true, code: "Digit3", key: "3" });
    await user.click(screen.getByRole("button", { name: "Save Shortcut" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(replaceUserKeybindings).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          disabled: true,
          key: "mod+e",
          when: expect.any(String),
        }),
        expect.objectContaining({
          args: { uiMode: "cycle" },
          command: "worktree.setUiMode",
          key: "alt+3",
          when: expect.any(String),
        }),
      ]),
    );
  });

  it("copies default args and when conditions when adding another shortcut", async () => {
    const user = userEvent.setup();
    const replaceUserKeybindings = seedKeybindings();
    render(<KeyboardShortcutsSettings />);

    await user.type(
      screen.getByPlaceholderText("Search commands..."),
      "Switch Worktree Mode",
    );
    const row = screen.getAllByTestId("keybinding-row:worktree.setUiMode")[0];
    await user.click(
      within(row).getByRole("button", {
        name: "Add shortcut for Switch Worktree Mode",
      }),
    );
    fireEvent.keyDown(window, { altKey: true, code: "Digit4", key: "4" });
    await user.click(screen.getByRole("button", { name: "Save Shortcut" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(replaceUserKeybindings).toHaveBeenCalledWith([
      expect.objectContaining({
        args: { uiMode: "cycle" },
        command: "worktree.setUiMode",
        key: "alt+4",
        when: expect.any(String),
      }),
    ]);
  });

  it("customizes a default shortcut from the advanced panel", async () => {
    const user = userEvent.setup();
    const replaceUserKeybindings = seedKeybindings();
    render(<KeyboardShortcutsSettings />);

    await user.type(
      screen.getByPlaceholderText("Search commands..."),
      "Switch Worktree Mode",
    );
    const row = screen.getAllByTestId("keybinding-row:worktree.setUiMode")[0];
    await user.click(
      within(row).getByRole("button", {
        name: /Show advanced for .* on Switch Worktree Mode/,
      }),
    );
    const whenInput = screen.getByRole("textbox", { name: "When" });
    fireEvent.change(whenInput, {
      target: { value: "selectedWorktree && isLinux" },
    });
    fireEvent.blur(whenInput);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(replaceUserKeybindings).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          disabled: true,
          key: "mod+e",
          when: expect.any(String),
        }),
        expect.objectContaining({
          args: { uiMode: "cycle" },
          command: "worktree.setUiMode",
          key: "mod+e",
          when: "selectedWorktree && isLinux",
        }),
      ]),
    );
  });

  it("opens advanced shortcut fields from the when column", async () => {
    const user = userEvent.setup();
    seedKeybindings([
      {
        command: "tab.newTerminal",
        disabled: false,
        key: "ctrl+1",
        when: "selectedWorktree",
      },
    ]);
    render(<KeyboardShortcutsSettings />);

    await user.type(
      screen.getByPlaceholderText("Search commands..."),
      "New Terminal",
    );
    await user.click(screen.getByText("selectedWorktree"));

    const rowWithAdvanced = screen
      .getAllByTestId("keybinding-row:tab.newTerminal")
      .find((row) => within(row).queryByText("Pane ID"));

    expect(rowWithAdvanced).toBeDefined();
    expect(within(rowWithAdvanced!).getByText("Pane ID")).toBeInTheDocument();
    expect(
      within(rowWithAdvanced!).getByText("Worktree ID"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /Advanced/ }),
    ).not.toBeInTheDocument();
  });

  it("uses a multiline when condition textarea", async () => {
    const user = userEvent.setup();
    seedKeybindings([
      {
        command: "tab.newTerminal",
        disabled: false,
        key: "ctrl+1",
      },
    ]);
    render(<KeyboardShortcutsSettings />);

    await user.type(
      screen.getByPlaceholderText("Search commands..."),
      "New Terminal",
    );
    await user.click(
      screen.getByRole("button", {
        name: "Show advanced for Ctrl+1 on New Terminal Tab",
      }),
    );

    const whenInput = screen.getByRole("textbox", { name: "When" });
    expect(whenInput.tagName).toBe("TEXTAREA");

    fireEvent.change(whenInput, {
      target: { value: "selectedWorktree\n&& !inputFocus" },
    });
    expect(whenInput).toHaveValue("selectedWorktree\n&& !inputFocus");
  });

  it("renders syntax highlighting for when conditions", async () => {
    const user = userEvent.setup();
    seedKeybindings([
      {
        command: "tab.newTerminal",
        disabled: false,
        key: "ctrl+1",
      },
    ]);
    render(<KeyboardShortcutsSettings />);

    await user.type(
      screen.getByPlaceholderText("Search commands..."),
      "New Terminal",
    );
    await user.click(
      screen.getByRole("button", {
        name: "Show advanced for Ctrl+1 on New Terminal Tab",
      }),
    );

    const whenInput = screen.getByRole("textbox", { name: "When" });
    fireEvent.change(whenInput, {
      target: { value: "selectedWorktree && typoKey == 'terminal'" },
    });

    const highlight = screen.getByTestId("when-highlight");
    expect(highlight).toHaveTextContent(
      "selectedWorktree && typoKey == 'terminal'",
    );
    expect(
      highlight.querySelector('[data-token-kind="key"]'),
    ).toHaveTextContent("selectedWorktree");
    expect(
      highlight.querySelector('[data-token-kind="unknown"]'),
    ).toHaveTextContent("typoKey");
    expect(
      highlight.querySelector('[data-token-kind="string"]'),
    ).toHaveTextContent("'terminal'");
  });

  it("suggests when conditions while typing", async () => {
    const user = userEvent.setup();
    seedKeybindings([
      {
        command: "tab.newTerminal",
        disabled: false,
        key: "ctrl+1",
      },
    ]);
    render(<KeyboardShortcutsSettings />);

    await user.type(
      screen.getByPlaceholderText("Search commands..."),
      "New Terminal",
    );
    await user.click(
      screen.getByRole("button", {
        name: "Show advanced for Ctrl+1 on New Terminal Tab",
      }),
    );
    await user.type(screen.getByRole("textbox", { name: "When" }), "selected");

    expect(screen.getByText("selectedWorktree")).toBeInTheDocument();

    await user.click(screen.getByText("selectedWorktree"));

    expect(screen.getByRole("textbox", { name: "When" })).toHaveValue(
      "selectedWorktree",
    );
  });

  it("edits command args with typed fields", async () => {
    const user = userEvent.setup();
    const replaceUserKeybindings = seedKeybindings([
      {
        args: { url: "http://localhost:3000" },
        command: "tab.newBrowser",
        disabled: false,
        key: "ctrl+1",
      },
    ]);
    render(<KeyboardShortcutsSettings />);

    await user.type(
      screen.getByPlaceholderText("Search commands..."),
      "New Browser",
    );
    await user.click(
      screen.getByRole("button", {
        name: "Show advanced for Ctrl+1 on New Browser Tab",
      }),
    );
    const urlInput = screen.getByRole("textbox", { name: "URL" });
    await user.clear(urlInput);
    await user.type(urlInput, "http://localhost:5173");
    fireEvent.blur(urlInput);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(replaceUserKeybindings).toHaveBeenCalledWith([
      expect.objectContaining({
        args: { url: "http://localhost:5173" },
        command: "tab.newBrowser",
        key: "ctrl+1",
      }),
    ]);
  });
});
