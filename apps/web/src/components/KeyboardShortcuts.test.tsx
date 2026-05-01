import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import KeyboardShortcuts from "./KeyboardShortcuts";
import { useKeybindingsStore } from "@/lib/stores/keybindings";
import { useSettingsStore } from "@/lib/stores/settings";
import { useWorktreeHistorySwitcherStore } from "@/lib/stores/worktreeHistorySwitcher";

const mocks = vi.hoisted(() => ({
  commandContext: {
    activeTab: { id: "tab-1", preview: false, type: "terminal" },
  } as {
    activeTab: { id: string; preview: boolean; type: string };
  },
  commandUiState: {
    dialog: null as { type: string } | null,
    paletteOpen: false,
  },
  executeCommand: vi.fn(),
}));

function setNavigatorPlatform(platform: string): void {
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: platform,
  });
}

vi.mock("@/lib/commands", () => ({
  executeCommand: mocks.executeCommand,
  getCommandContextSnapshot: () => ({
    activeTab: mocks.commandContext.activeTab,
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
    getState: () => mocks.commandUiState,
  },
}));

describe("KeyboardShortcuts", () => {
  beforeEach(() => {
    mocks.executeCommand.mockReset();
    mocks.commandContext.activeTab = {
      id: "tab-1",
      preview: false,
      type: "terminal",
    };
    mocks.commandUiState.dialog = null;
    mocks.commandUiState.paletteOpen = false;
    useKeybindingsStore.setState({
      registry: {
        bindings: [
          {
            command: "tab.newTerminal",
            key: "ctrl+k",
            source: "user",
            when: "selectedWorktree && (!inputFocus || terminalFocus)",
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
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        terminal: {
          ...state.settings.terminal,
          sendKeybindingsToShell: false,
        },
      },
    }));
    useWorktreeHistorySwitcherStore.getState().cancel();
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

  it("stops handled shortcuts from reaching secondary listeners", () => {
    const downstreamListener = vi.fn();
    document.body.addEventListener("keydown", downstreamListener);
    render(<KeyboardShortcuts />);

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
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
    expect(downstreamListener).not.toHaveBeenCalled();
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

  it("executes app shortcuts while terminal input is focused by default", () => {
    const textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    document.body.append(textarea);
    textarea.focus();
    render(<KeyboardShortcuts />);

    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        ctrlKey: true,
        key: "K",
      }),
    );

    expect(mocks.executeCommand).toHaveBeenCalledWith({
      args: undefined,
      id: "tab.newTerminal",
      source: "keyboard-shortcut",
    });
  });

  it("sends terminal shortcuts to the shell when configured", () => {
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        terminal: {
          ...state.settings.terminal,
          sendKeybindingsToShell: true,
        },
      },
    }));
    const textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    document.body.append(textarea);
    textarea.focus();
    render(<KeyboardShortcuts />);

    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        ctrlKey: true,
        key: "K",
      }),
    );

    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it("does not treat body focus as terminal focus", () => {
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        terminal: {
          ...state.settings.terminal,
          sendKeybindingsToShell: true,
        },
      },
    }));
    render(<KeyboardShortcuts />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        ctrlKey: true,
        key: "K",
      }),
    );

    expect(mocks.executeCommand).toHaveBeenCalledWith({
      args: undefined,
      id: "tab.newTerminal",
      source: "keyboard-shortcut",
    });
  });

  it("does not intercept reserved browser reload shortcuts", () => {
    setNavigatorPlatform("MacIntel");
    useKeybindingsStore.setState({
      registry: {
        bindings: [
          {
            command: "app.openCommandPalette",
            key: "meta+r",
            source: "user",
            when: "selectedWorktree",
          },
        ],
        conflicts: [],
      },
    });
    render(<KeyboardShortcuts />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "R",
        metaKey: true,
      }),
    );

    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it("does not dispatch exact shortcut conflicts", () => {
    useKeybindingsStore.setState({
      registry: {
        bindings: [
          {
            command: "tab.newTerminal",
            key: "ctrl+1",
            source: "user",
            when: "selectedWorktree",
          },
          {
            command: "tab.newBrowser",
            key: "ctrl+1",
            source: "user",
            when: "selectedWorktree",
          },
        ],
        conflicts: [
          {
            bindings: [],
            key: "ctrl+1\u0000selectedWorktree",
          },
        ],
      },
    });
    render(<KeyboardShortcuts />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "Digit1",
        ctrlKey: true,
        key: "1",
      }),
    );

    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it("starts the worktree history switcher through the command runtime", () => {
    useKeybindingsStore.setState({
      registry: {
        bindings: [
          {
            args: { direction: "back" },
            command: "worktree.showHistorySwitcher",
            key: "ctrl+tab",
            source: "default",
            when: "selectedWorktree",
          },
        ],
        conflicts: [],
      },
    });
    render(<KeyboardShortcuts />);

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Tab",
      ctrlKey: true,
      key: "Tab",
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.executeCommand).toHaveBeenCalledWith({
      args: { direction: "back" },
      id: "worktree.showHistorySwitcher",
      source: "keyboard-shortcut",
    });
  });

  it("starts the worktree history switcher when a browser tab is active", () => {
    mocks.commandContext.activeTab = {
      id: "tab-1",
      preview: false,
      type: "browser",
    };
    useKeybindingsStore.setState({
      registry: {
        bindings: [
          {
            args: { direction: "back" },
            command: "worktree.showHistorySwitcher",
            key: "ctrl+tab",
            source: "default",
            when: "selectedWorktree",
          },
        ],
        conflicts: [],
      },
    });
    render(<KeyboardShortcuts />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "Tab",
        ctrlKey: true,
        key: "Tab",
      }),
    );

    expect(mocks.executeCommand).toHaveBeenCalledWith({
      args: { direction: "back" },
      id: "worktree.showHistorySwitcher",
      source: "keyboard-shortcut",
    });
  });

  it("starts the worktree history switcher from the browser address field", () => {
    mocks.commandContext.activeTab = {
      id: "tab-1",
      preview: false,
      type: "browser",
    };
    useKeybindingsStore.setState({
      registry: {
        bindings: [
          {
            args: { direction: "back" },
            command: "worktree.showHistorySwitcher",
            key: "ctrl+tab",
            source: "default",
            when: "selectedWorktree",
          },
        ],
        conflicts: [],
      },
    });
    const input = document.createElement("input");
    input.name = "browser-url";
    document.body.append(input);
    input.focus();
    render(<KeyboardShortcuts />);

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Tab",
        ctrlKey: true,
        key: "Tab",
      }),
    );

    expect(mocks.executeCommand).toHaveBeenCalledWith({
      args: { direction: "back" },
      id: "worktree.showHistorySwitcher",
      source: "keyboard-shortcut",
    });
  });

  it("starts the worktree history switcher while terminal input is focused by default", () => {
    useKeybindingsStore.setState({
      registry: {
        bindings: [
          {
            args: { direction: "back" },
            command: "worktree.showHistorySwitcher",
            key: "ctrl+tab",
            source: "default",
            when: "selectedWorktree",
          },
        ],
        conflicts: [],
      },
    });
    const textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    document.body.append(textarea);
    textarea.focus();
    render(<KeyboardShortcuts />);

    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Tab",
        ctrlKey: true,
        key: "Tab",
      }),
    );

    expect(mocks.executeCommand).toHaveBeenCalledWith({
      args: { direction: "back" },
      id: "worktree.showHistorySwitcher",
      source: "keyboard-shortcut",
    });
  });

  it("captures the worktree history switcher before terminal handlers stop propagation", () => {
    useKeybindingsStore.setState({
      registry: {
        bindings: [
          {
            args: { direction: "back" },
            command: "worktree.showHistorySwitcher",
            key: "ctrl+tab",
            source: "default",
            when: "selectedWorktree",
          },
        ],
        conflicts: [],
      },
    });
    const textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    textarea.addEventListener("keydown", (event) => event.stopPropagation());
    document.body.append(textarea);
    textarea.focus();
    render(<KeyboardShortcuts />);

    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Tab",
        ctrlKey: true,
        key: "Tab",
      }),
    );

    expect(mocks.executeCommand).toHaveBeenCalledWith({
      args: { direction: "back" },
      id: "worktree.showHistorySwitcher",
      source: "keyboard-shortcut",
    });
  });

  it("cycles an open worktree history switcher while Ctrl is held", () => {
    useWorktreeHistorySwitcherStore
      .getState()
      .start(["w1", "w2", "w3"], "back");
    render(<KeyboardShortcuts />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Tab",
        ctrlKey: true,
        key: "Tab",
      }),
    );
    expect(useWorktreeHistorySwitcherStore.getState().selectedIndex).toBe(2);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Tab",
        ctrlKey: true,
        key: "Tab",
        shiftKey: true,
      }),
    );
    expect(useWorktreeHistorySwitcherStore.getState().selectedIndex).toBe(1);
  });

  it("commits the selected worktree when Ctrl is released", () => {
    useWorktreeHistorySwitcherStore.getState().start(["w1", "w2"], "back");
    render(<KeyboardShortcuts />);

    window.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Control",
      }),
    );

    expect(mocks.executeCommand).toHaveBeenCalledWith({
      args: { worktreeId: "w2" },
      id: "worktree.select",
      source: "keyboard-shortcut",
    });
    expect(useWorktreeHistorySwitcherStore.getState().open).toBe(false);
  });

  it("cancels the worktree history switcher with Escape", () => {
    useWorktreeHistorySwitcherStore.getState().start(["w1", "w2"], "back");
    render(<KeyboardShortcuts />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
      }),
    );

    expect(useWorktreeHistorySwitcherStore.getState().open).toBe(false);
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it("does not start the worktree history switcher in terminal passthrough mode", () => {
    useKeybindingsStore.setState({
      registry: {
        bindings: [
          {
            args: { direction: "back" },
            command: "worktree.showHistorySwitcher",
            key: "ctrl+tab",
            source: "default",
            when: "selectedWorktree",
          },
        ],
        conflicts: [],
      },
    });
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        terminal: {
          ...state.settings.terminal,
          sendKeybindingsToShell: true,
        },
      },
    }));
    const textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    document.body.append(textarea);
    textarea.focus();
    render(<KeyboardShortcuts />);

    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Tab",
        ctrlKey: true,
        key: "Tab",
      }),
    );

    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it("does not start the worktree history switcher over command UI", () => {
    mocks.commandUiState.paletteOpen = true;
    useKeybindingsStore.setState({
      registry: {
        bindings: [
          {
            args: { direction: "back" },
            command: "worktree.showHistorySwitcher",
            key: "ctrl+tab",
            source: "default",
            when: "selectedWorktree",
          },
        ],
        conflicts: [],
      },
    });
    render(<KeyboardShortcuts />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "Tab",
        ctrlKey: true,
        key: "Tab",
      }),
    );

    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });
});
