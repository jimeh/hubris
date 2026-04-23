import { describe, expect, it, vi } from "vitest";
import {
  formatKeybinding,
  keybindingFromEvent,
  normalizeKeybinding,
} from "./keys";
import { buildKeybindingRegistry, resolveKeybinding } from "./registry";
import { evaluateWhenExpression } from "./when";

vi.mock("@/lib/commands", () => ({
  getCommandDefinition: (id: string) => ({ id }),
}));

describe("keybinding keys", () => {
  it("normalizes modifiers and platform mod aliases", () => {
    expect(normalizeKeybinding("shift+cmd+p")).toBe("meta+shift+p");
    expect(normalizeKeybinding("ctrl+alt+ArrowLeft")).toBe("ctrl+alt+left");
  });

  it("normalizes keyboard events", () => {
    expect(
      keybindingFromEvent({
        altKey: true,
        ctrlKey: false,
        key: "ArrowRight",
        metaKey: true,
        shiftKey: false,
      } as KeyboardEvent),
    ).toBe("meta+alt+right");
  });

  it("formats shortcut labels", () => {
    expect(formatKeybinding("ctrl+shift+p")).toContain("P");
  });
});

describe("when conditions", () => {
  const context = {
    activeTabType: "terminal",
    editorFocus: false,
    inputFocus: false,
    selectedWorktree: true,
    terminalFocus: true,
  };

  it("evaluates boolean operators and comparisons", () => {
    expect(
      evaluateWhenExpression(
        "selectedWorktree && activeTabType == 'terminal' && !inputFocus",
        context,
      ),
    ).toBe(true);
    expect(evaluateWhenExpression("editorFocus || inputFocus", context)).toBe(
      false,
    );
  });

  it("fails loudly for unknown keys", () => {
    expect(() => evaluateWhenExpression("typoKey", context)).toThrow(
      /Unknown when condition key/,
    );
  });
});

describe("keybinding registry", () => {
  const context = {
    activeTabPreview: false,
    activeTabType: "terminal",
    browserFocus: false,
    commandPaletteOpen: false,
    dialogOpen: false,
    editorFocus: false,
    focusedPane: true,
    gitStatusFocus: false,
    inputFocus: false,
    selectedProject: true,
    selectedWorktree: true,
    terminalFocus: false,
  };

  it("merges user bindings with defaults deterministically", () => {
    const registry = buildKeybindingRegistry([
      {
        command: "tab.newBrowser",
        key: "ctrl+b",
        when: "selectedWorktree",
      },
    ]);

    expect(
      registry.bindings.some(
        (binding) =>
          binding.command === "tab.newBrowser" && binding.key === "ctrl+b",
      ),
    ).toBe(true);
  });

  it("lets user disabled entries remove matching defaults", () => {
    const registry = buildKeybindingRegistry([
      {
        disabled: true,
        key: "mod+t",
        when: "selectedWorktree && (!inputFocus || terminalFocus) && !browserFocus && !editorFocus && !commandPaletteOpen && !dialogOpen",
      },
    ]);

    expect(
      registry.bindings.some(
        (binding) => binding.command === "tab.newTerminal",
      ),
    ).toBe(false);
  });

  it("prefers more specific contextual matches", () => {
    const registry = buildKeybindingRegistry([
      {
        command: "tab.newTerminal",
        key: "ctrl+k",
        when: "selectedWorktree",
      },
      {
        command: "tab.newBrowser",
        key: "ctrl+k",
        when: "selectedWorktree && focusedPane",
      },
    ]);

    const binding = resolveKeybinding({
      context,
      key: "ctrl+k",
      registry,
    });

    expect(binding?.command).toBe("tab.newBrowser");
  });
});
