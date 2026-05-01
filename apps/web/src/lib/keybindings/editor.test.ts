import { describe, expect, it } from "vitest";
import {
  addUserShortcut,
  disableCommandDefaults,
  isReservedKeybinding,
  removeUserShortcut,
  resetCommandKeybindings,
  updateUserShortcutAdvanced,
  validateKeybindingDraft,
  type EditableKeybindingEntry,
} from "./editor";

describe("keybinding editor draft helpers", () => {
  it("adds multiple shortcuts for the same command", () => {
    const draft = addUserShortcut({
      command: "tab.newTerminal",
      key: "alt+1",
      keybindings: addUserShortcut({
        command: "tab.newTerminal",
        key: "alt+2",
        keybindings: [],
      }),
    });

    expect(draft).toMatchObject([
      { command: "tab.newTerminal", key: "alt+2" },
      { command: "tab.newTerminal", key: "alt+1" },
    ]);
  });

  it("disables defaults and resets command customizations", () => {
    const draft = addUserShortcut({
      command: "tab.newTerminal",
      key: "ctrl+1",
      keybindings: disableCommandDefaults([], "tab.newTerminal"),
    });

    expect(draft.some((binding) => binding.disabled)).toBe(true);
    expect(draft.find((binding) => binding.disabled)?.key).toBe("mod+t");
    expect(draft.some((binding) => binding.command === "tab.newTerminal")).toBe(
      true,
    );

    expect(resetCommandKeybindings(draft, "tab.newTerminal")).toEqual([]);
  });

  it("removes one shortcut without removing siblings", () => {
    const draft = [
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
    ] satisfies EditableKeybindingEntry[];

    expect(removeUserShortcut(draft, 0)).toEqual([draft[1]]);
  });

  it("preserves unmanaged entries during command reset", () => {
    const draft = [
      {
        command: "unknown.command",
        disabled: false,
        key: "ctrl+9",
      },
      {
        command: "tab.newTerminal",
        disabled: false,
        key: "ctrl+1",
      },
    ] satisfies EditableKeybindingEntry[];

    expect(resetCommandKeybindings(draft, "tab.newTerminal")).toEqual([
      draft[0],
    ]);
  });

  it("detects exact conflicts and same-command duplicates", () => {
    const conflict = validateKeybindingDraft([
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
    expect(conflict.conflicts).toHaveLength(1);

    const duplicate = validateKeybindingDraft([
      {
        args: { one: 1, two: 2 },
        command: "tab.newTerminal",
        disabled: false,
        key: "ctrl+1",
        when: "selectedWorktree",
      },
      {
        args: { two: 2, one: 1 },
        command: "tab.newTerminal",
        disabled: false,
        key: "ctrl+1",
        when: "selectedWorktree",
      },
    ]);
    expect(duplicate.duplicates).toHaveLength(1);
  });

  it("allows contextual overlaps", () => {
    const result = validateKeybindingDraft([
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
        when: "selectedWorktree && focusedPane",
      },
    ]);

    expect(result.conflicts).toHaveLength(0);
  });

  it("validates advanced when and args input", () => {
    expect(() =>
      updateUserShortcutAdvanced({
        args: { value: null },
        entryIndex: 0,
        keybindings: [
          {
            command: "tab.newBrowser",
            disabled: false,
            key: "ctrl+1",
          },
        ],
        when: "",
      }),
    ).toThrow();

    const result = validateKeybindingDraft([
      {
        command: "tab.newBrowser",
        disabled: false,
        key: "ctrl+1",
        when: "typoKey",
      },
    ]);
    expect(result.errors[0]).toMatch(/Unknown when condition key/);
  });

  it("rejects common browser and system shortcuts in the recorder", () => {
    expect(isReservedKeybinding("cmd+w")).toBe(true);
    expect(isReservedKeybinding("ctrl+shift+i")).toBe(true);
    expect(isReservedKeybinding("mod+k")).toBe(false);
  });
});
