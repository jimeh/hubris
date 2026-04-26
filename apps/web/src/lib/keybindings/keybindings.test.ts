import { describe, expect, it, vi } from "vitest";
import {
  formatKeybinding,
  keybindingFromEvent,
  normalizeKeybinding,
  normalizeKeybindingForStorage,
} from "./keys";
import { defaultKeybindings } from "./defaults";
import {
  buildKeybindingRegistry,
  getFirstKeybindingForCommandArgs,
  resolveKeybinding,
} from "./registry";
import {
  completeWhenExpression,
  evaluateWhenExpression,
  matchingWhenCompletions,
  normalizeWhenExpressionWhitespace,
  tokenizeWhenExpressionForHighlighting,
} from "./when";

vi.mock("@/lib/commands", () => ({
  getCommandDefinition: (id: string) => ({ id }),
}));

function setNavigatorPlatform(platform: string): void {
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: platform,
  });
}

describe("keybinding keys", () => {
  it("normalizes modifiers and platform mod aliases", () => {
    setNavigatorPlatform("MacIntel");

    expect(normalizeKeybinding("shift+cmd+p")).toBe("meta+shift+p");
    expect(normalizeKeybinding("ctrl+alt+ArrowLeft")).toBe("ctrl+alt+left");
  });

  it("records platform primary modifiers as mod", () => {
    setNavigatorPlatform("MacIntel");

    expect(
      keybindingFromEvent({
        altKey: false,
        code: "KeyP",
        ctrlKey: false,
        key: "p",
        metaKey: true,
        shiftKey: false,
      } as KeyboardEvent),
    ).toBe("mod+p");

    setNavigatorPlatform("Linux x86_64");

    expect(
      keybindingFromEvent({
        altKey: false,
        code: "KeyP",
        ctrlKey: true,
        key: "p",
        metaKey: false,
        shiftKey: false,
      } as KeyboardEvent),
    ).toBe("mod+p");
  });

  it("keeps runtime and storage normalization separate", () => {
    setNavigatorPlatform("MacIntel");

    expect(normalizeKeybinding("mod+p")).toBe("meta+p");
    expect(normalizeKeybindingForStorage("mod+p")).toBe("mod+p");
    expect(normalizeKeybindingForStorage("cmd+p")).toBe("cmd+p");
    expect(normalizeKeybindingForStorage("meta+p")).toBe("cmd+p");
    expect(normalizeKeybindingForStorage("ctrl+p")).toBe("ctrl+p");
  });

  it("does not treat explicit meta as the platform mod alias", () => {
    setNavigatorPlatform("MacIntel");

    expect(normalizeKeybinding("meta+p")).toBe("meta+p");
    expect(normalizeKeybinding("mod+p")).toBe("meta+p");
    expect(normalizeKeybindingForStorage("meta+p")).not.toBe("mod+p");
  });

  it("uses physical letter keys for alt-modified characters", () => {
    expect(
      keybindingFromEvent({
        altKey: true,
        code: "KeyP",
        ctrlKey: false,
        key: "π",
        metaKey: false,
        shiftKey: false,
      } as KeyboardEvent),
    ).toBe("alt+p");
  });

  it("ignores modifier-only key events", () => {
    expect(
      keybindingFromEvent({
        altKey: false,
        code: "MetaLeft",
        ctrlKey: false,
        key: "Meta",
        metaKey: true,
        shiftKey: false,
      } as KeyboardEvent),
    ).toBeNull();

    expect(
      keybindingFromEvent({
        altKey: false,
        code: "ControlLeft",
        ctrlKey: true,
        key: "Control",
        metaKey: false,
        shiftKey: false,
      } as KeyboardEvent),
    ).toBeNull();
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
    isLinux: false,
    isMacOS: true,
    isWindows: false,
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
    expect(
      evaluateWhenExpression(
        "selectedWorktree\n  &&\tactiveTabType == 'terminal'\n  && !inputFocus",
        context,
      ),
    ).toBe(true);
  });

  it("supports OS-specific conditions", () => {
    expect(evaluateWhenExpression("isMacOS && !isWindows", context)).toBe(true);
    expect(evaluateWhenExpression("isLinux || isWindows", context)).toBe(false);
  });

  it("fails loudly for unknown keys", () => {
    expect(() => evaluateWhenExpression("typoKey", context)).toThrow(
      /Unknown when condition key/,
    );
  });

  it("decodes standard string escapes and rejects malformed escapes", () => {
    expect(
      evaluateWhenExpression("activeTabType == 'term\\u0069nal'", context),
    ).toBe(true);
    expect(() =>
      evaluateWhenExpression("activeTabType == 'terminal\\q'", context),
    ).toThrow(/Invalid escape/);
  });

  it("suggests and inserts when condition completions", () => {
    expect(matchingWhenCompletions("selected", "selected".length)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "selectedWorktree" }),
      ]),
    );
    expect(
      matchingWhenCompletions("selectedWorktree", "selectedWorktree".length),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "selectedWorktree" }),
      ]),
    );
    expect(
      completeWhenExpression({
        completion: "selectedWorktree",
        cursorIndex: "selected".length,
        value: "selected",
      }),
    ).toEqual({
      cursorIndex: "selectedWorktree".length,
      value: "selectedWorktree",
    });
  });

  it("normalizes condition whitespace outside string literals", () => {
    expect(
      normalizeWhenExpressionWhitespace(
        "selectedWorktree\n  &&\tactiveTabType == 'terminal preview'",
      ),
    ).toBe("selectedWorktree && activeTabType == 'terminal preview'");
  });

  it("tokenizes conditions for syntax highlighting", () => {
    expect(
      tokenizeWhenExpressionForHighlighting(
        "(selectedWorktree && activeTabType == 'terminal')",
      ),
    ).toEqual([
      { type: "paren", value: "(" },
      { type: "key", value: "selectedWorktree" },
      { type: "whitespace", value: " " },
      { type: "operator", value: "&&" },
      { type: "whitespace", value: " " },
      { type: "key", value: "activeTabType" },
      { type: "whitespace", value: " " },
      { type: "operator", value: "==" },
      { type: "whitespace", value: " " },
      { type: "string", value: "'terminal'" },
      { type: "paren", value: ")" },
    ]);
  });

  it("marks unknown and invalid highlight tokens without throwing", () => {
    expect(tokenizeWhenExpressionForHighlighting("typoKey @ 'open")).toEqual([
      { type: "unknown", value: "typoKey" },
      { type: "whitespace", value: " " },
      { type: "invalid", value: "@" },
      { type: "whitespace", value: " " },
      { type: "invalid", value: "'open" },
    ]);
  });

  it("preserves whitespace tokens for multiline highlighting", () => {
    expect(
      tokenizeWhenExpressionForHighlighting(
        "selectedWorktree\n  && inputFocus",
      ),
    ).toEqual([
      { type: "key", value: "selectedWorktree" },
      { type: "whitespace", value: "\n  " },
      { type: "operator", value: "&&" },
      { type: "whitespace", value: " " },
      { type: "key", value: "inputFocus" },
    ]);
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
    isLinux: false,
    isMacOS: true,
    isWindows: false,
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

  it("treats condition linefeeds as normal whitespace for conflicts", () => {
    const registry = buildKeybindingRegistry([
      {
        command: "tab.newTerminal",
        key: "ctrl+k",
        when: "selectedWorktree && focusedPane",
      },
      {
        command: "tab.newBrowser",
        key: "ctrl+k",
        when: "selectedWorktree\n  && focusedPane",
      },
    ]);

    expect(registry.conflicts).toHaveLength(1);
    expect(
      resolveKeybinding({
        context,
        key: "ctrl+k",
        registry,
      }),
    ).toBeNull();
  });

  it("does not resolve exact active conflicts", () => {
    const registry = buildKeybindingRegistry([
      {
        command: "tab.newTerminal",
        key: "ctrl+1",
        when: "selectedWorktree",
      },
      {
        command: "tab.newBrowser",
        key: "ctrl+1",
        when: "selectedWorktree",
      },
    ]);

    expect(registry.conflicts).toHaveLength(1);
    expect(
      resolveKeybinding({
        context,
        key: "ctrl+1",
        registry,
      }),
    ).toBeNull();
  });

  it("matches command args independent of object key order", () => {
    const registry = buildKeybindingRegistry([
      {
        args: { port: 5173, url: "http://localhost:5173" },
        command: "tab.newBrowser",
        key: "ctrl+k",
      },
    ]);

    expect(
      getFirstKeybindingForCommandArgs(registry, "tab.newBrowser", {
        url: "http://localhost:5173",
        port: 5173,
      }),
    ).not.toBeNull();
  });

  it("drops malformed user when expressions from the active registry", () => {
    const registry = buildKeybindingRegistry([
      {
        command: "tab.newTerminal",
        key: "ctrl+k",
        when: "typoKey",
      },
    ]);

    expect(
      registry.bindings.some(
        (binding) =>
          binding.command === "tab.newTerminal" && binding.key === "ctrl+k",
      ),
    ).toBe(false);
  });

  it("drops malformed user keybindings without breaking the registry", () => {
    expect(() =>
      buildKeybindingRegistry([
        {
          command: "tab.newTerminal",
          key: "cmd",
          when: "selectedWorktree",
        },
      ]),
    ).not.toThrow();

    const registry = buildKeybindingRegistry([
      {
        command: "tab.newTerminal",
        key: "cmd",
        when: "selectedWorktree",
      },
    ]);

    expect(
      registry.bindings.some(
        (binding) =>
          binding.command === "tab.newTerminal" && binding.key === "cmd",
      ),
    ).toBe(false);
  });

  it("ignores malformed when expressions while resolving shortcuts", () => {
    const binding = resolveKeybinding({
      context,
      key: "ctrl+k",
      registry: {
        bindings: [
          {
            command: "tab.newTerminal",
            key: "ctrl+k",
            source: "user",
            when: "typoKey",
          },
        ],
        conflicts: [],
      },
    });

    expect(binding).toBeNull();
  });
});

describe("default keybindings", () => {
  it("uses bracket shortcuts for worktree history and switching", () => {
    expect(defaultKeybindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "app.toggleLeftSidebar",
          key: "mod+b",
        }),
        expect.objectContaining({
          command: "app.toggleRightSidebar",
          key: "mod+alt+b",
        }),
        expect.objectContaining({
          args: { direction: "back" },
          command: "worktree.showHistorySwitcher",
          key: "ctrl+tab",
        }),
        expect.objectContaining({
          args: { direction: "forward" },
          command: "worktree.showHistorySwitcher",
          key: "ctrl+shift+tab",
        }),
        expect.objectContaining({
          command: "worktree.navigateBack",
          key: "mod+[",
        }),
        expect.objectContaining({
          command: "worktree.navigateForward",
          key: "mod+]",
        }),
        expect.objectContaining({
          command: "worktree.selectPrevious",
          key: "mod+shift+[",
        }),
        expect.objectContaining({
          command: "worktree.selectNext",
          key: "mod+shift+]",
        }),
        expect.objectContaining({
          args: { uiMode: "cycle" },
          command: "worktree.setUiMode",
          key: "mod+e",
        }),
      ]),
    );
  });
});
