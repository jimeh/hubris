import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import KeyboardShortcuts from "./KeyboardShortcuts";
import { useKeybindingsStore } from "@/lib/stores/keybindings";

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(),
}));

vi.mock("@/lib/commands", () => ({
  executeCommand: mocks.executeCommand,
  getCommandContextSnapshot: () => ({
    activeTab: { id: "tab-1", preview: false, type: "terminal" },
    focusedPaneId: "pane-1",
    projects: [],
    selectedProject: { id: "project-1" },
    selectedWorktree: { id: "worktree-1" },
    tabs: [],
    worktrees: [],
    worktreesByProject: {},
  }),
  getCommandDefinition: (id: string) => ({ id }),
}));

vi.mock("@/lib/stores/commandUi", () => ({
  useCommandUiStore: {
    getState: () => ({
      dialog: null,
      paletteOpen: false,
    }),
  },
}));

describe("KeyboardShortcuts", () => {
  beforeEach(() => {
    mocks.executeCommand.mockReset();
    useKeybindingsStore.setState({
      registry: {
        bindings: [
          {
            command: "tab.newTerminal",
            key: "ctrl+k",
            source: "user",
            when: "selectedWorktree && !inputFocus && !terminalFocus",
          },
          {
            command: "app.openCommandPalette",
            key: "ctrl+shift+p",
            source: "user",
            when: "!inputFocus",
          },
        ],
        conflicts: [],
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("executes matching commands through the command runtime", () => {
    render(<KeyboardShortcuts />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        ctrlKey: true,
        key: "P",
        shiftKey: true,
      }),
    );

    expect(mocks.executeCommand).toHaveBeenCalledWith({
      args: undefined,
      id: "app.openCommandPalette",
      source: "keyboard-shortcut",
    });
  });

  it("does not fire while typing in inputs", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    render(<KeyboardShortcuts />);

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        ctrlKey: true,
        key: "P",
        shiftKey: true,
      }),
    );

    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it("honors terminal focus guards", () => {
    render(<KeyboardShortcuts />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        ctrlKey: true,
        key: "K",
      }),
    );

    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });
});
